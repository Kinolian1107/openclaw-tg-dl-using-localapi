---
name: tg-dl-localapi
description: >
  Download Telegram files by file_id using a Local Bot API Server, bypassing
  the 20 MB standard Bot API limit (up to 2 GB). Use when you need to download
  a Telegram file by file_id — especially large audio, video, or document files.
  Also useful when other skills need to re-download files outside the normal
  message pipeline, from cron jobs, or by explicit file_id.
  Triggers on keywords: download telegram file, tg download, file_id,
  下載 Telegram 檔案, 大檔案下載, local bot api download.
metadata:
  openclaw:
    emoji: "📥"
    requires:
      bins: ["curl", "python3"]
    os: ["linux"]
---

# Telegram Local Bot API Downloader

Download Telegram files by `file_id` using a Local Bot API Server, bypassing the standard 20 MB limit (up to 2 GB).

## Prerequisites

- A running [Telegram Bot API Server](https://github.com/tdlib/telegram-bot-api) at `http://localhost:18995` (or custom URL)
- Bot token is auto-detected from `~/.openclaw/openclaw.json`

## Usage

Run `scripts/tg-download.sh` (resolve relative to this SKILL.md's directory):

```bash
bash "${SKILL_DIR}/scripts/tg-download.sh" <file_id> [-o output_dir] [-t bot_token] [-u api_url]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-o` | `.` (cwd) | Output directory |
| `-t` | auto-detect from `openclaw.json` | Bot token |
| `-u` | `http://localhost:18995` | Local Bot API URL |

The script prints the **absolute path** of the downloaded file to stdout. All status/progress messages go to stderr.

## Examples

```bash
SKILL_DIR="$(dirname "$(readlink -f "$0")")"

# Download a file to /home/kino/asr
bash "${SKILL_DIR}/scripts/tg-download.sh" "BAADBAADxwADZv..." -o /home/kino/asr

# Custom API URL
bash "${SKILL_DIR}/scripts/tg-download.sh" "BAADBAADxwADZv..." -u http://192.168.1.100:8081
```

## Integration with Other Skills

Other skills (e.g., ASR) can call this to download large files before processing:

```bash
TG_DL_SKILL="$HOME/.openclaw/skills/tg-dl-localapi"
FILE_PATH=$(bash "${TG_DL_SKILL}/scripts/tg-download.sh" "$FILE_ID" -o /home/kino/asr)
# then process $FILE_PATH with ffmpeg / whisper / etc.
```

## How It Works

1. Calls `getFile` on the Local Bot API to resolve `file_id` → local file path
2. Downloads the file via the Local Bot API's `/file/` endpoint
3. Shows download progress for large files
4. Saves to the output directory preserving original filename
5. Prints absolute path to stdout

## Note on OpenClaw Built-in Support

OpenClaw natively supports `localBotApiUrl` in its Telegram config. If set in `openclaw.json`, incoming files are automatically downloaded via the Local Bot API. This skill is for **out-of-pipeline** use: re-downloading by `file_id`, cron jobs, or integration with other skills.
