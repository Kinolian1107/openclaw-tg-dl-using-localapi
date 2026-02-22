# openclaw-tg-dl-using-localapi

An [OpenClaw](https://github.com/openclaw/openclaw) skill that enables downloading Telegram files >20 MB via a [Local Bot API Server](https://core.telegram.org/bots/api#using-a-local-bot-api-server), bypassing the standard Bot API 20 MB limit (up to 2 GB).

## Problem

The Telegram Bot API limits file downloads to 20 MB. When a user sends a larger file, OpenClaw's `resolveMedia()` fails and the AI has no way to access the file.

## Solution

This skill provides two layers of support:

### Layer 1: `localBotApiUrl` Config (Transparent)

Patches OpenClaw's `resolveMedia()` to download files through a Local Bot API Server when `localBotApiUrl` is configured. This removes the 20 MB limit entirely — files up to 2 GB are downloaded automatically with no AI intervention.

### Layer 2: `<telegram_large_file>` Tag (Fallback)

If `resolveMedia()` still fails (Local Bot API down, misconfigured, etc.), the patch injects file metadata into the message body as a `<telegram_large_file>` tag. The AI can then call the included download script to fetch the file.

### Download Script (`scripts/tg-download.sh`)

Downloads files by `file_id` via the Local Bot API Server with a 3-tier fallback:
1. **Volume mount** — direct host filesystem copy (fastest)
2. **docker cp** — copy from container (default)
3. **HTTP download** — standard Bot API endpoint (fallback)

## Prerequisites

- A running `telegram-bot-api` Docker container with `TELEGRAM_LOCAL=true`
- `docker`, `curl`, `python3` available on the host
- OpenClaw installed globally via npm

## Installation

### As an OpenClaw Skill

```bash
# Clone
git clone https://github.com/Kinolian1107/openclaw-tg-dl-using-localapi.git ~/git/openclaw-tg-dl-using-localapi

# Symlink into OpenClaw skills
ln -s ~/git/openclaw-tg-dl-using-localapi ~/.openclaw/skills/tg-dl-localapi

# Apply patches to OpenClaw dist
node ~/git/openclaw-tg-dl-using-localapi/scripts/patch-openclaw.js

# Configure openclaw.json (add under channels.telegram)
# "mediaMaxMb": 2000,
# "localBotApiUrl": "http://localhost:18995"

# Restart gateway
openclaw gateway restart
```

### After `openclaw update`

The patch modifies dist files that get replaced on update. Re-apply:

```bash
node ~/git/openclaw-tg-dl-using-localapi/scripts/patch-openclaw.js
openclaw gateway restart
```

The patch script is **idempotent** — safe to re-run.

## How It Works

### End-to-End Flow (Layer 1 — Transparent)

```
User sends 50MB video via Telegram
       │
       ▼
OpenClaw receives Telegram update (message has file_id)
       │
       ▼
resolveMedia() detects localBotApiUrl in config
       │
       ▼
Calls Local Bot API (localhost:18995) getFile → returns local file_path
       │
       ▼
Downloads file from Local Bot API /file/bot<token>/... → saves to disk
       │
       ▼
File passed to AI as media attachment (same as any normal file)
       │
       ▼
AI processes the file normally (ASR, forwarding, etc.)
```

### Fallback Flow (Layer 2 — AI-Triggered)

```
resolveMedia() fails (Local Bot API down, network issue, etc.)
       │
       ▼
★ PATCH CODE: detects msg has file_id but media is null
       │
       ▼
Injects <telegram_large_file> tag with file_id/metadata into msg.text
       │
       ▼
AI sees <telegram_large_file> tag → reads SKILL.md
       │
       ▼
AI calls tg-download.sh with file_id → downloads via Local Bot API
       │
       ▼
AI processes the downloaded file
```

## What the Patch Modifies

The `scripts/patch-openclaw.js` applies three types of changes to OpenClaw's dist files:

### 1. Config Schema (~6 files)

Adds `localBotApiUrl: z.string().optional()` to the Telegram channel Zod schema.

### 2. resolveMedia() Integration (~5 files)

- Adds `localBotApiUrl` parameter to `resolveMedia()`
- Routes `getFile` and file downloads through Local Bot API when configured
- Falls back to standard `api.telegram.org` when `localBotApiUrl` is not set

**Before:**
```javascript
async function resolveMedia(ctx, maxBytes, token, proxyFetch) {
    // Downloads via https://api.telegram.org — limited to 20 MB
}
```

**After:**
```javascript
async function resolveMedia(ctx, maxBytes, token, proxyFetch, localBotApiUrl) {
    const fileApiBase = localBotApiUrl
        ? localBotApiUrl.replace(/\/+$/, "")
        : "https://api.telegram.org";
    // Downloads via localBotApiUrl when configured — up to 2 GB
}
```

### 3. File ID Injection (~5 files)

When `resolveMedia()` returns null, injects `<telegram_large_file>` XML tag with JSON metadata into the message body.

### Patch Markers

- `/* tg-localapi-url-patch */` — Local Bot API URL integration
- `/* tg-dl-localapi-patch */` — File ID injection

Both markers ensure idempotency — the script skips already-patched files.

## Usage

### Automatic (with localBotApiUrl)

Once patched and configured, files up to 2 GB are downloaded transparently. No special action needed.

### Manual (by file_id)

```bash
# Basic download
scripts/tg-download.sh "BAADBAADxwADZv..." -o /output/dir

# With volume mount (fastest)
scripts/tg-download.sh "BAADBAADxwADZv..." -o /output/dir -v /opt/docker/telegram-bot-api/data

# Capture path for pipeline
FILE_PATH=$(scripts/tg-download.sh "$FILE_ID" -o /home/kino/asr)
echo "Downloaded to: $FILE_PATH"
```

| Flag | Default | Description |
|------|---------|-------------|
| `-o` | `.` | Output directory |
| `-t` | auto from `openclaw.json` | Bot token |
| `-u` | `http://localhost:18995` | Local Bot API URL |
| `-c` | `telegram-bot-api` | Docker container name |
| `-v` | (none) | Host volume path for `/var/lib/telegram-bot-api` |

## Docker Setup for Local Bot API

If you don't have the Local Bot API container yet, add to your `docker-compose.yml`:

```yaml
telegram-bot-api:
  image: aiogram/telegram-bot-api:latest
  restart: unless-stopped
  environment:
    TELEGRAM_API_ID: "<your-api-id>"       # From https://my.telegram.org
    TELEGRAM_API_HASH: "<your-api-hash>"   # From https://my.telegram.org
    TELEGRAM_LOCAL: "true"
  ports:
    - "18995:8081"
  volumes:
    - telegram-bot-api-data:/var/lib/telegram-bot-api
```

Get `api_id` and `api_hash` from [https://my.telegram.org](https://my.telegram.org).

## Environment Variables

| Variable | Equivalent Flag |
|----------|----------------|
| `TG_DL_TOKEN` | `-t` |
| `TG_DL_API_URL` | `-u` |
| `TG_DL_CONTAINER` | `-c` |
| `TG_DL_VOLUME_MAP` | `-v` |

## License

MIT
