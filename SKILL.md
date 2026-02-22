---
name: tg-dl-localapi
description: >
  Download Telegram files by file_id using a Local Bot API Server (docker cp),
  bypassing the 20 MB standard Bot API limit (up to 2 GB). Use when you have a
  Telegram file_id and need to download the actual file — especially for large
  audio, video, or document files. Triggers on keywords: download telegram file,
  tg download, file_id, 下載 Telegram 檔案, 大檔案下載.
metadata:
  openclaw:
    emoji: "📥"
    requires:
      bins: ["curl", "python3", "docker"]
    os: ["linux"]
---

# Telegram Local Bot API Downloader

Download Telegram files by `file_id` via a Local Bot API Server container. Bypasses the standard 20 MB limit (up to 2 GB).

## Prerequisites

- A running `telegram-bot-api` Docker container (e.g. `aiogram/telegram-bot-api`) with `TELEGRAM_LOCAL=true`
- `docker` CLI accessible (for `docker cp`)
- Bot token auto-detected from `~/.openclaw/openclaw.json`

## How It Works

The Local Bot API in `TELEGRAM_LOCAL=true` mode returns **absolute container paths** from `getFile` (e.g. `/var/lib/telegram-bot-api/.../file.mp4`). The standard HTTP download endpoint does not serve these paths.

This script uses a 3-tier fallback:
1. **Volume mount** — direct copy from host filesystem (fastest; requires `-v` flag and readable permissions)
2. **docker cp** — copy from container (default, always works if docker is available)
3. **HTTP download** — standard `/file/bot<token>/` endpoint (fallback for non-local mode)

## Usage

Run `scripts/tg-download.sh` (resolve relative to this SKILL.md's directory):

```bash
SKILL_DIR="$(dirname "$(readlink -f "$0")")"  # or hardcode the path
"${SKILL_DIR}/scripts/tg-download.sh" <file_id> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-o` | `.` (cwd) | Output directory |
| `-t` | auto from `openclaw.json` | Bot token |
| `-u` | `http://localhost:18995` | Local Bot API URL |
| `-c` | `telegram-bot-api` | Docker container name |
| `-v` | (none) | Host volume path mapping to `/var/lib/telegram-bot-api` |

The script prints the **absolute path** of the downloaded file to **stdout**. Status messages go to stderr.

## Examples

```bash
# Basic download
scripts/tg-download.sh "BAADBAADxwADZv..." -o /home/kino/asr

# With volume mount (fastest when permissions allow)
scripts/tg-download.sh "BAADBAADxwADZv..." -o /home/kino/asr -v /opt/docker/telegram-bot-api/data

# Capture path in a variable for further processing
FILE_PATH=$(scripts/tg-download.sh "$FILE_ID" -o /home/kino/asr)
echo "Downloaded to: $FILE_PATH"
```

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
