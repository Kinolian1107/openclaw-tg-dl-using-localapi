#!/usr/bin/env node
/**
 * Patch OpenClaw dist files to add:
 *   1. Local Bot API URL support (localBotApiUrl config + resolveMedia integration)
 *   2. file_id injection when resolveMedia fails for large files (>20MB)
 *
 * Usage:
 *   node patch-openclaw.js [--dry-run] [--dist-dir /path/to/dist]
 *
 * Idempotent — safe to re-run on already-patched files.
 */
const fs = require('fs');
const path = require('path');

const MARKER_URL = '/* tg-localapi-url-patch */';
const MARKER_FILEID = '/* tg-dl-localapi-patch */';

// ── Helpers ──────────────────────────────────────────────────────────

function resolveDistDir() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dist-dir');
  if (dirIdx !== -1 && args[dirIdx + 1]) return args[dirIdx + 1];

  const candidates = [
    process.env.OPENCLAW_DIST,
  ].filter(Boolean);

  const home = process.env.HOME || '';
  const nvmDir = path.join(home, '.nvm/versions/node');
  try {
    const versions = fs.readdirSync(nvmDir).sort();
    if (versions.length > 0)
      candidates.push(path.join(nvmDir, versions[versions.length - 1], 'lib/node_modules/openclaw/dist'));
  } catch {}

  for (const cand of candidates) {
    try { if (fs.statSync(cand).isDirectory()) return cand; } catch {}
  }

  try {
    const npmRoot = require('child_process').execSync('npm root -g', { encoding: 'utf-8' }).trim();
    const d = path.join(npmRoot, 'openclaw/dist');
    if (fs.statSync(d).isDirectory()) return d;
  } catch {}

  console.error('Error: Cannot locate OpenClaw dist directory. Use --dist-dir <path>.');
  process.exit(1);
}

function collectJsFiles(dir) {
  const files = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  }
  walk(dir);
  return files;
}

// ── Phase 1: Config Schema — add localBotApiUrl ──────────────────────

function patchConfigSchema(content) {
  const search = 'mediaMaxMb: z.number().positive().optional(),\n\ttimeoutSeconds:';
  const replace = 'mediaMaxMb: z.number().positive().optional(),\n\tlocalBotApiUrl: z.string().optional(),\n\ttimeoutSeconds:';
  if (!content.includes(search)) return null;
  return content.replace(search, replace);
}

// ── Phase 2: resolveMedia — Local Bot API integration ────────────────

function patchResolveMedia(content) {
  let c = content;
  let changed = false;

  // 2a. Function signature + fileApiBase + download URL
  {
    const search = [
      'async function resolveMedia(ctx, maxBytes, token, proxyFetch) {',
      '\tconst msg = ctx.message;',
      '\tconst downloadAndSaveTelegramFile = async (filePath, fetchImpl) => {',
      '\t\tconst fetched = await fetchRemoteMedia({',
      '\t\t\turl: `https://api.telegram.org/file/bot${token}/${filePath}`,'
    ].join('\n');
    const replace = [
      'async function resolveMedia(ctx, maxBytes, token, proxyFetch, localBotApiUrl) {',
      '\t' + MARKER_URL,
      '\tconst msg = ctx.message;',
      '\tconst fileApiBase = localBotApiUrl ? localBotApiUrl.replace(/\\/+$/, "") : "https://api.telegram.org";',
      '\tconst downloadAndSaveTelegramFile = async (filePath, fetchImpl) => {',
      '\t\tconst fetched = await fetchRemoteMedia({',
      '\t\t\turl: `${fileApiBase}/file/bot${token}/${filePath}`,'
    ].join('\n');
    if (c.includes(search)) {
      c = c.replace(search, replace);
      changed = true;
    }
  }

  // 2b. Add getFilePath helper after downloadAndSaveTelegramFile
  {
    const search = [
      '\t\treturn saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", maxBytes, originalName);',
      '\t};',
      '\tif (msg.sticker) {'
    ].join('\n');
    const replace = [
      '\t\treturn saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", maxBytes, originalName);',
      '\t};',
      '\tconst getFilePath = async (fileId, fetchImpl) => {',
      '\t\tif (!localBotApiUrl) return (await ctx.getFile()).file_path ?? null;',
      '\t\tconst res = await fetchImpl(`${fileApiBase}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);',
      '\t\tif (!res.ok) {',
      '\t\t\tconst body = await res.text().catch(() => "");',
      '\t\t\tthrow new Error(`Local Bot API getFile failed (${res.status}): ${body}`);',
      '\t\t}',
      '\t\treturn (await res.json())?.result?.file_path ?? null;',
      '\t};',
      '\tif (msg.sticker) {'
    ].join('\n');
    if (c.includes(search)) {
      c = c.replace(search, replace);
      changed = true;
    }
  }

  // 2c. Sticker handling — replace ctx.getFile() with getFilePath()
  {
    const search = [
      '\t\t\tconst file = await ctx.getFile();',
      '\t\t\tif (!file.file_path) {',
      '\t\t\t\tlogVerbose("telegram: getFile returned no file_path for sticker");',
      '\t\t\t\treturn null;',
      '\t\t\t}',
      '\t\t\tconst fetchImpl = proxyFetch ?? globalThis.fetch;',
      '\t\t\tif (!fetchImpl) {',
      '\t\t\t\tlogVerbose("telegram: fetch not available for sticker download");',
      '\t\t\t\treturn null;',
      '\t\t\t}',
      '\t\t\tconst saved = await downloadAndSaveTelegramFile(file.file_path, fetchImpl);'
    ].join('\n');
    const replace = [
      '\t\t\tconst fetchImpl = proxyFetch ?? globalThis.fetch;',
      '\t\t\tif (!fetchImpl) {',
      '\t\t\t\tlogVerbose("telegram: fetch not available for sticker download");',
      '\t\t\t\treturn null;',
      '\t\t\t}',
      '\t\t\tconst stickerFilePath = await getFilePath(sticker.file_id, fetchImpl);',
      '\t\t\tif (!stickerFilePath) {',
      '\t\t\t\tlogVerbose("telegram: getFile returned no file_path for sticker");',
      '\t\t\t\treturn null;',
      '\t\t\t}',
      '\t\t\tconst saved = await downloadAndSaveTelegramFile(stickerFilePath, fetchImpl);'
    ].join('\n');
    if (c.includes(search)) {
      c = c.replace(search, replace);
      changed = true;
    }
  }

  // 2d. Main media — replace file variable with filePath, use getFilePath
  {
    const search = [
      '\tif (!(msg.photo?.[msg.photo.length - 1] ?? msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice)?.file_id) return null;',
      '\tlet file;',
      '\ttry {',
      '\t\tfile = await retryAsync(() => ctx.getFile(), {'
    ].join('\n');
    const replace = [
      '\tconst m = msg.photo?.[msg.photo.length - 1] ?? msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice;',
      '\tif (!m?.file_id) return null;',
      '\tconst fetchImpl = proxyFetch ?? globalThis.fetch;',
      '\tif (!fetchImpl) throw new Error("fetch is not available; set channels.telegram.proxy in config");',
      '\tlet filePath;',
      '\ttry {',
      '\t\tfilePath = await retryAsync(() => getFilePath(m.file_id, fetchImpl), {'
    ].join('\n');
    if (c.includes(search)) {
      c = c.replace(search, replace);
      changed = true;
    }
  }

  // 2e. After retryAsync — replace file.file_path with filePath
  {
    const search = [
      '\tif (!file.file_path) throw new Error("Telegram getFile returned no file_path");',
      '\tconst fetchImpl = proxyFetch ?? globalThis.fetch;',
      '\tif (!fetchImpl) throw new Error("fetch is not available; set channels.telegram.proxy in config");',
      '\tconst saved = await downloadAndSaveTelegramFile(file.file_path, fetchImpl);'
    ].join('\n');
    const replace = [
      '\tif (!filePath) throw new Error("Telegram getFile returned no file_path");',
      '\tconst saved = await downloadAndSaveTelegramFile(filePath, fetchImpl);'
    ].join('\n');
    if (c.includes(search)) {
      c = c.replace(search, replace);
      changed = true;
    }
  }

  // 2f. resolveMedia call sites — add telegramCfg.localBotApiUrl argument
  {
    const search = 'resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch)';
    const replace = 'resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch, telegramCfg.localBotApiUrl)';
    while (c.includes(search)) {
      c = c.replace(search, replace);
      changed = true;
    }
  }

  return changed ? c : null;
}

// ── Phase 3: file_id injection when resolveMedia returns null ────────

function patchFileIdInjection(content) {
  // Same search patterns used by the original patch, supporting multiple indent levels
  const INDENT_LEVELS = ['\t', '\t\t'];
  for (const indent of INDENT_LEVELS) {
    const search = `${indent}\t\tthrow mediaErr;\n${indent}\t}\n${indent}\tconst hasText = Boolean((msg.text ?? msg.caption ?? "").trim());`;
    if (!content.includes(search)) continue;

    const t = indent + '\t';
    const t2 = t + '\t';
    const t3 = t2 + '\t';
    const replace = [
      `${t}\tthrow mediaErr;`,
      `${t}}`,
      `${t}${MARKER_FILEID}`,
      `${t}if (!media) {`,
      `${t2}const _mo = msg.photo?.[msg.photo.length - 1] ?? msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice;`,
      `${t2}if (_mo?.file_id) {`,
      `${t3}const _fi = JSON.stringify({`,
      `${t3}\tfile_id: _mo.file_id,`,
      `${t3}\tfile_size: _mo.file_size ?? msg.document?.file_size ?? msg.video?.file_size ?? msg.audio?.file_size ?? 0,`,
      `${t3}\tfile_name: msg.document?.file_name ?? msg.audio?.file_name ?? msg.video?.file_name ?? "",`,
      `${t3}\tmime_type: msg.document?.mime_type ?? msg.audio?.mime_type ?? msg.video?.mime_type ?? ""`,
      `${t3}});`,
      `${t3}const _tag = "<telegram_large_file>" + _fi + "</telegram_large_file>";`,
      `${t3}const _et = (msg.text ?? msg.caption ?? "").trim();`,
      `${t3}if (msg.caption !== void 0) msg.caption = _et ? _et + "\\n" + _tag : _tag;`,
      `${t3}else msg.text = (_et ? _et + "\\n" + _tag : _tag);`,
      `${t2}}`,
      `${t}}`,
      `${t}const hasText = Boolean((msg.text ?? msg.caption ?? "").trim());`,
    ].join('\n');

    return content.replace(search, replace);
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const distDir = resolveDistDir();
  console.log(`OpenClaw dist: ${distDir}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'APPLY'}\n`);

  const jsFiles = collectJsFiles(distDir);

  const stats = {
    configPatched: 0, configSkipped: 0,
    urlPatched: 0, urlSkipped: 0,
    fileidPatched: 0, fileidSkipped: 0,
  };

  for (const file of jsFiles) {
    let content = fs.readFileSync(file, 'utf-8');
    const rel = path.relative(distDir, file);
    let fileModified = false;

    // Phase 1: Config schema
    if (content.includes('mediaMaxMb: z.number()')) {
      if (content.includes('localBotApiUrl: z.string().optional()')) {
        stats.configSkipped++;
      } else {
        const patched = patchConfigSchema(content);
        if (patched) {
          content = patched;
          fileModified = true;
          stats.configPatched++;
          console.log(`  [config]  ${dryRun ? 'Would patch' : 'Patched'}: ${rel}`);
        }
      }
    }

    // Phase 2: resolveMedia localBotApiUrl
    if (content.includes('async function resolveMedia(')) {
      if (content.includes(MARKER_URL) || content.includes('resolveMedia(ctx, maxBytes, token, proxyFetch, localBotApiUrl)')) {
        stats.urlSkipped++;
      } else {
        const patched = patchResolveMedia(content);
        if (patched) {
          content = patched;
          fileModified = true;
          stats.urlPatched++;
          console.log(`  [url]     ${dryRun ? 'Would patch' : 'Patched'}: ${rel}`);
        }
      }
    }

    // Phase 3: file_id injection
    if (content.includes('throw mediaErr;')) {
      if (content.includes(MARKER_FILEID)) {
        stats.fileidSkipped++;
      } else {
        const patched = patchFileIdInjection(content);
        if (patched) {
          content = patched;
          fileModified = true;
          stats.fileidPatched++;
          console.log(`  [fileid]  ${dryRun ? 'Would patch' : 'Patched'}: ${rel}`);
        }
      }
    }

    if (fileModified && !dryRun) {
      fs.writeFileSync(file, content, 'utf-8');
    }
  }

  console.log('\n── Summary ──');
  console.log(`  Config schema:     ${stats.configPatched} patched, ${stats.configSkipped} already done`);
  console.log(`  Local Bot API URL: ${stats.urlPatched} patched, ${stats.urlSkipped} already done`);
  console.log(`  File ID injection: ${stats.fileidPatched} patched, ${stats.fileidSkipped} already done`);

  const totalPatched = stats.configPatched + stats.urlPatched + stats.fileidPatched;
  if (totalPatched > 0 && !dryRun) {
    console.log('\nRestart OpenClaw gateway to apply changes:');
    console.log('  openclaw gateway restart');
  } else if (totalPatched === 0) {
    console.log('\nAll patches already applied. Nothing to do.');
  }
}

main();
