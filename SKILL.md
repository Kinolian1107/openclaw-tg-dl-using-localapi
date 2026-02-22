---
name: tg-dl-localapi
description: >
  Download Telegram files via Local Bot API Server, bypassing the 20 MB standard
  Bot API limit (up to 2 GB). Includes patches for OpenClaw that:
  (1) Add localBotApiUrl support so resolveMedia downloads via Local Bot API directly,
  (2) Inject file metadata (file_id, file_size, file_name, mime_type) into the message
  body when a file exceeds the download limit, so the AI can automatically detect and
  download large files as a fallback.
  Triggers on keywords: download telegram file, tg download, file_id,
  下載 Telegram 檔案, 大檔案下載, telegram_large_file.
metadata:
  openclaw:
    emoji: "📥"
    requires:
      bins: ["curl", "python3"]
    os: ["linux"]
---

# Telegram Local Bot API Downloader

Download Telegram files by `file_id` via a Local Bot API Server container, bypassing the standard 20 MB limit (up to 2 GB).

## How It Works — Two Layers of Support

This skill provides **two complementary patches** for OpenClaw:

### Layer 1: `localBotApiUrl` (Primary — Transparent)

Patches OpenClaw's `resolveMedia()` to use a Local Bot API Server for file downloads. When `localBotApiUrl` is configured in `openclaw.json`, all file downloads go through the local server instead of `api.telegram.org`, eliminating the 20 MB limit entirely.

**Effect:** Files up to 2 GB are downloaded automatically — no AI intervention needed.

### Layer 2: `<telegram_large_file>` Tag (Fallback — AI-Triggered)

If `resolveMedia()` still returns null (e.g. Local Bot API is down, or not configured), the patch injects a `<telegram_large_file>` tag containing the file's `file_id` and metadata into the message body. The AI can then use the download script to fetch the file manually.

## Setup (One-Time)

### 1. Prerequisites

- A running `telegram-bot-api` Docker container (e.g. `aiogram/telegram-bot-api`) with `TELEGRAM_LOCAL=true`
- `curl`, `python3` available on the host
- Bot token auto-detected from `~/.openclaw/openclaw.json`

### 2. Apply the OpenClaw Patch

```bash
node scripts/patch-openclaw.js
```

The patch is **idempotent** — re-running on already-patched files is safe.

### 3. Configure `openclaw.json`

Add these fields under `channels.telegram`:

```json
{
  "channels": {
    "telegram": {
      "mediaMaxMb": 2000,
      "localBotApiUrl": "http://localhost:18995"
    }
  }
}
```

### 4. Restart Gateway

```bash
openclaw gateway restart
```

### 5. Re-Apply After `openclaw update`

Each `openclaw update` replaces the dist files. Re-run the patch script afterward:

```bash
node ~/git/openclaw-tg-dl-using-localapi/scripts/patch-openclaw.js
openclaw gateway restart
```

## Automatic Trigger (How the AI Should Handle `<telegram_large_file>`)

When Layer 1 (localBotApiUrl) fails or is not configured, and a user sends a file >20 MB via Telegram, the patched OpenClaw injects a tag into the message:

```
<telegram_large_file>{"file_id":"BAADBAADxw...","file_size":52428800,"file_name":"video.mp4","mime_type":"video/mp4"}</telegram_large_file>
```

**When you see `<telegram_large_file>` in a user message, you MUST:**

1. Parse the JSON inside the tag to extract `file_id`, `file_name`, `file_size`, `mime_type`
2. Download the file using the script below:

```bash
SKILL_DIR="$(dirname "$(readlink -f ~/.openclaw/skills/tg-dl-localapi/SKILL.md)")"
FILE_PATH=$("${SKILL_DIR}/scripts/tg-download.sh" "<file_id>" -o /home/kino/asr)
```

3. `FILE_PATH` (stdout) is the absolute path of the downloaded file
4. Process the file as needed (e.g. pass to ASR skill for transcription, or send it back)

## Manual Usage

```bash
scripts/tg-download.sh <file_id> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-o` | `.` (cwd) | Output directory |
| `-t` | auto from `openclaw.json` | Bot token |
| `-u` | `http://localhost:18995` | Local Bot API URL |
| `-c` | `telegram-bot-api` | Docker container name |
| `-v` | (none) | Host volume path mapping to `/var/lib/telegram-bot-api` |

The script prints the **absolute path** of the downloaded file to **stdout**. Status messages go to stderr.

## Download Methods (3-Tier Fallback)

1. **Volume mount** — direct copy from host filesystem (fastest; requires `-v` flag)
2. **docker cp** — copy from container (default, always works if docker is available)
3. **HTTP download** — standard `/file/bot<token>/` endpoint (fallback for non-local mode)

## Integration with Other Skills

Other skills (e.g. ASR) can call this script to download large files before processing:

```bash
SKILL_DIR="/home/kino/git/openclaw-tg-dl-using-localapi"
FILE_PATH=$("${SKILL_DIR}/scripts/tg-download.sh" "$FILE_ID" -o /home/kino/asr)
ffmpeg -i "$FILE_PATH" ...
```

## Environment Variables

All flags can also be set via environment variables (flags take priority):

| Variable | Equivalent Flag |
|----------|----------------|
| `TG_DL_TOKEN` | `-t` |
| `TG_DL_API_URL` | `-u` |
| `TG_DL_CONTAINER` | `-c` |
| `TG_DL_VOLUME_MAP` | `-v` |

## What the Patch Does (Technical Details)

The `scripts/patch-openclaw.js` script applies **three types of modifications** to OpenClaw's bundled dist files:

### Config Schema Patch (~6 files)

Adds `localBotApiUrl: z.string().optional()` to the Telegram channel Zod schema, so OpenClaw accepts the field in `openclaw.json` without validation errors.

### Local Bot API URL Patch (~5 files)

Modifies the `resolveMedia()` function:
- Adds `localBotApiUrl` parameter
- Routes file downloads through `localBotApiUrl` instead of `api.telegram.org`
- Adds a `getFilePath()` helper that calls `getFile` via the Local Bot API directly (bypassing grammY's built-in API call which always uses the standard endpoint)

### File ID Injection Patch (~5 files)

When `resolveMedia()` returns null (file too big or download failed), injects a `<telegram_large_file>` XML tag into `msg.text` or `msg.caption` containing the file's metadata as JSON.

### Safety

All patches are idempotent (contain marker comments `/* tg-localapi-url-patch */` and `/* tg-dl-localapi-patch */`). Re-running on already-patched files is safe.
