---
name: tg-dl-localapi
description: >
  Patch OpenClaw to support Telegram Local Bot API for file downloads (up to 2 GB).
  Also provides a standalone download script for files by file_id.
  Triggers on keywords: download telegram file, tg download, file_id,
  下載 Telegram 檔案, 大檔案下載, telegram_large_file.
metadata:
  openclaw:
    emoji: "📥"
    requires:
      bins: ["curl", "python3", "node"]
    os: ["linux"]
---

# Telegram Local Bot API Patch + Downloader

Patches OpenClaw to use a Local Bot API Server for Telegram file downloads, bypassing the 20 MB limit (up to 2 GB).

## Patch Management

```bash
# Apply patch (idempotent, safe to re-run)
node patch/apply-patch.js

# Preview without changing files
node patch/apply-patch.js --dry-run

# Restore original dist
bash patch/apply-patch.sh --restore
```

**After every `openclaw update`**, re-run the patch:

```bash
node patch/apply-patch.js && openclaw gateway restart
```

## Config

Add to `~/.openclaw/openclaw.json` under `channels.telegram`:

```json
"localBotApiUrl": "http://localhost:18995",
"mediaMaxMb": 2000
```

## Standalone Download Script

For downloading files by `file_id` outside OpenClaw's media pipeline:

```bash
scripts/tg-download.sh <file_id> -o /home/kino/asr
```

Bot token auto-detected from `openclaw.json`. Returns the absolute path of the downloaded file on stdout.

| Flag | Default | Description |
|------|---------|-------------|
| `-o` | `.` | Output directory |
| `-t` | auto | Bot token |
| `-u` | `http://localhost:18995` | Local Bot API URL |
| `-c` | `telegram-bot-api` | Docker container name |

## How the Patch Works

When `localBotApiUrl` is configured:

1. `resolveMedia()` receives the Local Bot API URL from config
2. `getFile` API calls go to the Local Bot API instead of `api.telegram.org`
3. File downloads use the Local Bot API URL
4. All other Telegram API operations (sending messages, reactions, etc.) remain on the standard API

Without `localBotApiUrl`, behavior is identical to stock OpenClaw.
