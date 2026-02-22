#!/usr/bin/env node
/**
 * Patch OpenClaw dist to support localBotApiUrl for Telegram.
 * Only file downloads use the Local Bot API; all other operations use the standard API.
 *
 * Run: node apply-patch.js [--dry-run] [--dist /path/to/openclaw/dist]
 *
 * Re-run after every `openclaw update` to re-apply the patch.
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const distIdx = args.indexOf("--dist");
let distDir = distIdx !== -1 ? args[distIdx + 1] : null;

if (!distDir) {
  const nvmDir = path.join(process.env.HOME, ".nvm/versions/node");
  if (fs.existsSync(nvmDir)) {
    const versions = fs.readdirSync(nvmDir).sort().reverse();
    for (const v of versions) {
      const candidate = path.join(nvmDir, v, "lib/node_modules/openclaw/dist");
      if (fs.existsSync(candidate)) { distDir = candidate; break; }
    }
  }
  if (!distDir) {
    try {
      const ocBin = require("child_process").execSync("which openclaw", { encoding: "utf8" }).trim();
      distDir = path.join(path.dirname(path.dirname(fs.realpathSync(ocBin))), "lib/node_modules/openclaw/dist");
    } catch {}
  }
}

if (!distDir || !fs.existsSync(distDir)) {
  console.error("ERROR: OpenClaw dist directory not found. Use --dist to specify.");
  process.exit(1);
}

console.log(`OpenClaw dist: ${distDir}`);
console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}\n`);

let totalPatched = 0;
let totalSkipped = 0;

function collectJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectJsFiles(full));
    else if (entry.name.endsWith(".js")) results.push(full);
  }
  return results;
}

function applyReplace(content, label, oldStr, newStr) {
  if (!content.includes(oldStr)) return { content, applied: false };
  if (content.includes(newStr) && newStr !== oldStr) return { content, applied: false };
  content = content.replace(oldStr, newStr);
  return { content, applied: true };
}

const allFiles = collectJsFiles(distDir);

// ── Patch 1: Config Schema ──
// Add localBotApiUrl field to Telegram config schema
const CONFIG_OLD = [
  "\tmediaMaxMb: z.number().positive().optional(),\n\ttimeoutSeconds: z.number().int().positive().optional(),\n\tretry: RetryConfigSchema,",
];
const CONFIG_NEW = [
  "\tmediaMaxMb: z.number().positive().optional(),\n\tlocalBotApiUrl: z.string().optional(),\n\ttimeoutSeconds: z.number().int().positive().optional(),\n\tretry: RetryConfigSchema,",
];

for (const filePath of allFiles) {
  let content = fs.readFileSync(filePath, "utf8");
  let changed = false;

  for (let i = 0; i < CONFIG_OLD.length; i++) {
    const r = applyReplace(content, "config-schema", CONFIG_OLD[i], CONFIG_NEW[i]);
    if (r.applied) { content = r.content; changed = true; }
  }

  if (changed) {
    const rel = path.relative(distDir, filePath);
    if (dryRun) { console.log(`[DRY] Would patch config schema: ${rel}`); }
    else { fs.writeFileSync(filePath, content); console.log(`✓ Patched config schema: ${rel}`); }
    totalPatched++;
  }
}

// ── Patch 2: resolveMedia function ──
const RESOLVE_PATCHES = [
  // 2a: function signature + fileApiBase + download URL + getFilePath helper
  {
    old: `async function resolveMedia(ctx, maxBytes, token, proxyFetch) {\n\tconst msg = ctx.message;\n\tconst downloadAndSaveTelegramFile = async (filePath, fetchImpl) => {\n\t\tconst fetched = await fetchRemoteMedia({\n\t\t\turl: \`https://api.telegram.org/file/bot\${token}/\${filePath}\`,\n\t\t\tfetchImpl,\n\t\t\tfilePathHint: filePath\n\t\t});\n\t\tconst originalName = fetched.fileName ?? filePath;\n\t\treturn saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", maxBytes, originalName);\n\t};`,
    new: `async function resolveMedia(ctx, maxBytes, token, proxyFetch, localBotApiUrl) {\n\tconst msg = ctx.message;\n\tconst fileApiBase = localBotApiUrl ? localBotApiUrl.replace(/\\/+$/, "") : "https://api.telegram.org";\n\tconst downloadAndSaveTelegramFile = async (filePath, fetchImpl) => {\n\t\tconst fetched = await fetchRemoteMedia({\n\t\t\turl: \`\${fileApiBase}/file/bot\${token}/\${filePath}\`,\n\t\t\tfetchImpl,\n\t\t\tfilePathHint: filePath\n\t\t});\n\t\tconst originalName = fetched.fileName ?? filePath;\n\t\treturn saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", maxBytes, originalName);\n\t};\n\tconst getFilePath = async (fileId, fetchImpl) => {\n\t\tif (!localBotApiUrl) return (await ctx.getFile()).file_path ?? null;\n\t\tconst res = await fetchImpl(\`\${fileApiBase}/bot\${token}/getFile?file_id=\${encodeURIComponent(fileId)}\`);\n\t\tif (!res.ok) {\n\t\t\tconst body = await res.text().catch(() => "");\n\t\t\tthrow new Error(\`Local Bot API getFile failed (\${res.status}): \${body}\`);\n\t\t}\n\t\treturn (await res.json())?.result?.file_path ?? null;\n\t};`,
  },

  // 2b: sticker ctx.getFile() → getFilePath
  {
    old: `\t\ttry {\n\t\t\tconst file = await ctx.getFile();\n\t\t\tif (!file.file_path) {\n\t\t\t\tlogVerbose("telegram: getFile returned no file_path for sticker");\n\t\t\t\treturn null;\n\t\t\t}\n\t\t\tconst fetchImpl = proxyFetch ?? globalThis.fetch;\n\t\t\tif (!fetchImpl) {\n\t\t\t\tlogVerbose("telegram: fetch not available for sticker download");\n\t\t\t\treturn null;\n\t\t\t}\n\t\t\tconst saved = await downloadAndSaveTelegramFile(file.file_path, fetchImpl);`,
    new: `\t\ttry {\n\t\t\tconst fetchImpl = proxyFetch ?? globalThis.fetch;\n\t\t\tif (!fetchImpl) {\n\t\t\t\tlogVerbose("telegram: fetch not available for sticker download");\n\t\t\t\treturn null;\n\t\t\t}\n\t\t\tconst stickerFilePath = await getFilePath(sticker.file_id, fetchImpl);\n\t\t\tif (!stickerFilePath) {\n\t\t\t\tlogVerbose("telegram: getFile returned no file_path for sticker");\n\t\t\t\treturn null;\n\t\t\t}\n\t\t\tconst saved = await downloadAndSaveTelegramFile(stickerFilePath, fetchImpl);`,
  },

  // 2c: main media ctx.getFile() → getFilePath
  {
    old: `\tif (!(msg.photo?.[msg.photo.length - 1] ?? msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice)?.file_id) return null;\n\tlet file;\n\ttry {\n\t\tfile = await retryAsync(() => ctx.getFile(), {\n\t\t\tattempts: 3,\n\t\t\tminDelayMs: 1e3,\n\t\t\tmaxDelayMs: 4e3,\n\t\t\tjitter: .2,\n\t\t\tlabel: "telegram:getFile",\n\t\t\tonRetry: ({ attempt, maxAttempts }) => logVerbose(\`telegram: getFile retry \${attempt}/\${maxAttempts}\`)\n\t\t});\n\t} catch (err) {\n\t\tlogVerbose(\`telegram: getFile failed after retries: \${String(err)}\`);\n\t\treturn null;\n\t}\n\tif (!file.file_path) throw new Error("Telegram getFile returned no file_path");\n\tconst fetchImpl = proxyFetch ?? globalThis.fetch;\n\tif (!fetchImpl) throw new Error("fetch is not available; set channels.telegram.proxy in config");\n\tconst saved = await downloadAndSaveTelegramFile(file.file_path, fetchImpl);`,
    new: `\tconst m = msg.photo?.[msg.photo.length - 1] ?? msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice;\n\tif (!m?.file_id) return null;\n\tconst fetchImpl = proxyFetch ?? globalThis.fetch;\n\tif (!fetchImpl) throw new Error("fetch is not available; set channels.telegram.proxy in config");\n\tlet filePath;\n\ttry {\n\t\tfilePath = await retryAsync(() => getFilePath(m.file_id, fetchImpl), {\n\t\t\tattempts: 3,\n\t\t\tminDelayMs: 1e3,\n\t\t\tmaxDelayMs: 4e3,\n\t\t\tjitter: .2,\n\t\t\tlabel: "telegram:getFile",\n\t\t\tonRetry: ({ attempt, maxAttempts }) => logVerbose(\`telegram: getFile retry \${attempt}/\${maxAttempts}\`)\n\t\t});\n\t} catch (err) {\n\t\tlogVerbose(\`telegram: getFile failed after retries: \${String(err)}\`);\n\t\treturn null;\n\t}\n\tif (!filePath) throw new Error("Telegram getFile returned no file_path");\n\tconst saved = await downloadAndSaveTelegramFile(filePath, fetchImpl);`,
  },
];

// ── Patch 3: resolveMedia call sites ──
const CALLER_PATCHES = [
  {
    old: `const media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);`,
    new: `const media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch, telegramCfg.localBotApiUrl);`,
  },
  {
    old: `media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);`,
    new: `media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch, telegramCfg.localBotApiUrl);`,
  },
];

for (const filePath of allFiles) {
  let content = fs.readFileSync(filePath, "utf8");
  let changed = false;
  const rel = path.relative(distDir, filePath);

  // Check if already patched
  if (content.includes("async function resolveMedia(ctx, maxBytes, token, proxyFetch, localBotApiUrl)")) {
    continue;
  }

  // Only process files that have the unpatched resolveMedia
  if (!content.includes("async function resolveMedia(ctx, maxBytes, token, proxyFetch)")) {
    continue;
  }

  for (const patch of RESOLVE_PATCHES) {
    const r = applyReplace(content, "resolveMedia", patch.old, patch.new);
    if (r.applied) { content = r.content; changed = true; }
    else if (content.includes(patch.old.substring(0, 60))) {
      console.warn(`⚠ Pattern nearly matched but failed in ${rel} (resolveMedia patch)`);
    }
  }

  for (const patch of CALLER_PATCHES) {
    while (content.includes(patch.old)) {
      content = content.replace(patch.old, patch.new);
      changed = true;
    }
  }

  if (changed) {
    if (dryRun) { console.log(`[DRY] Would patch resolveMedia: ${rel}`); }
    else { fs.writeFileSync(filePath, content); console.log(`✓ Patched resolveMedia: ${rel}`); }
    totalPatched++;
  }
}

console.log(`\nDone. ${totalPatched} file(s) patched.`);
if (totalPatched === 0) {
  console.log("Nothing to patch — already patched or patterns not found.");
  console.log("If you just ran `openclaw update`, the dist files may have changed.");
  console.log("Check with --dry-run to diagnose.");
}
