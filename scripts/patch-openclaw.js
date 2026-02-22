#!/usr/bin/env node
/**
 * Patch OpenClaw dist files to inject Telegram file metadata (file_id, file_size,
 * file_name, mime_type) into the message body when resolveMedia returns null for
 * files exceeding the 20MB Bot API limit.
 *
 * This allows the AI to see the file_id and call the tg-dl-localapi skill to
 * download large files via the Local Bot API Server.
 *
 * Usage:
 *   node patch-openclaw.js [--dry-run] [--dist-dir /path/to/dist]
 *
 * The script is idempotent — re-running on already-patched files is safe.
 */
const fs = require('fs');
const path = require('path');

const MARKER = '/* tg-dl-localapi-patch */';

function buildSearch(indent) {
  return `${indent}\t\tthrow mediaErr;\n${indent}\t}\n${indent}\tconst hasText = Boolean((msg.text ?? msg.caption ?? "").trim());`;
}

function buildPatch(indent) {
  const t = indent + '\t';
  const t2 = t + '\t';
  const t3 = t2 + '\t';
  return [
    `${t}\tthrow mediaErr;`,
    `${t}}`,
    `${t}${MARKER}`,
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
}

const INDENT_LEVELS = ['\t', '\t\t'];

function resolveDistDir() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dist-dir');
  if (dirIdx !== -1 && args[dirIdx + 1]) return args[dirIdx + 1];

  const candidates = [
    process.env.OPENCLAW_DIST,
    path.join(process.env.HOME || '', '.nvm/versions/node', fs.readdirSync(path.join(process.env.HOME || '', '.nvm/versions/node')).sort().pop() || '', 'lib/node_modules/openclaw/dist'),
  ].filter(Boolean);

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

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const distDir = resolveDistDir();
  console.log(`OpenClaw dist: ${distDir}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);

  const jsFiles = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) jsFiles.push(full);
    }
  }
  walk(distDir);

  let patchedCount = 0;
  let skippedCount = 0;

  for (const file of jsFiles) {
    let content = fs.readFileSync(file, 'utf-8');
    if (content.includes(MARKER)) {
      skippedCount++;
      continue;
    }

    let matched = false;
    for (const indent of INDENT_LEVELS) {
      const search = buildSearch(indent);
      if (!content.includes(search)) continue;
      content = content.replace(search, buildPatch(indent));
      matched = true;
      break;
    }
    if (!matched) continue;

    if (!dryRun) fs.writeFileSync(file, content, 'utf-8');
    patchedCount++;
    console.log(`  ${dryRun ? 'Would patch' : 'Patched'}: ${path.relative(distDir, file)}`);
  }

  console.log(`\nDone: ${patchedCount} file(s) patched, ${skippedCount} already patched.`);
  if (patchedCount > 0 && !dryRun) {
    console.log('Restart OpenClaw gateway to apply changes.');
  }
}

main();
