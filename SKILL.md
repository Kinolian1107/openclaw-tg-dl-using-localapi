---
name: tg-dl-localapi
description: >
  Download Telegram files via Local Bot API Server, bypassing the 20 MB standard
  Bot API limit (up to 2 GB). Includes a patch for OpenClaw that injects file
  metadata (file_id, file_size, file_name, mime_type) into the message body when
  a file exceeds the 20 MB limit, so the AI can automatically detect and download
  large files. Triggers on keywords: download telegram file, tg download, file_id,
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

## Setup (One-Time)

### 1. Prerequisites

- A running `telegram-bot-api` Docker container (e.g. `aiogram/telegram-bot-api`) with `TELEGRAM_LOCAL=true`
- `curl`, `python3` available on the host
- Bot token auto-detected from `~/.openclaw/openclaw.json`

### 2. Apply the OpenClaw Patch

The patch modifies OpenClaw's dist files so that when Telegram sends a file >20 MB, the AI receives a `<telegram_large_file>` tag containing the `file_id` and file metadata — enabling automatic download.

```bash
node scripts/patch-openclaw.js
```

The patch is **idempotent** — re-running on already-patched files is safe.

After patching, restart the gateway:

```bash
openclaw gateway restart
```

### 3. Re-Apply After `openclaw update`

Each `openclaw update` replaces the dist files. Re-run the patch script afterward:

```bash
node scripts/patch-openclaw.js && openclaw gateway restart
```

## Automatic Trigger (How the AI Should Handle `<telegram_large_file>`)

When a user sends a file >20 MB via Telegram, the patched OpenClaw injects a tag into the message:

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

**Example: User sends a 50MB video with caption "轉逐字稿"**

The message body will look like:
```
轉逐字稿
<telegram_large_file>{"file_id":"BAADBAADxw...","file_size":52428800,"file_name":"video.mp4","mime_type":"video/mp4"}</telegram_large_file>
```

→ Extract file_id → Download via tg-download.sh → Pass to ASR skill.

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

The `scripts/patch-openclaw.js` script modifies OpenClaw's bundled dist files:

**Location**: The Telegram message handler, right after `resolveMedia()` returns null.

**Change**: When `resolveMedia` returns null (file too big or download failed) and the message contains media with a `file_id`, the patch injects a `<telegram_large_file>` XML tag into `msg.text` or `msg.caption`. This tag contains a JSON object with:

- `file_id` — Telegram's file identifier (used for downloading)
- `file_size` — file size in bytes
- `file_name` — original filename
- `mime_type` — MIME type

**Files affected**: ~10 dist `.js` files containing the Telegram `resolveMedia` handler (each is a different entry point bundle).

**Safety**: The patch is idempotent (contains a marker comment `/* tg-dl-localapi-patch */`) and only modifies the specific code path for failed media downloads. Normal message handling is unaffected.
