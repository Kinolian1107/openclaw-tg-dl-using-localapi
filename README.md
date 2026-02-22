# openclaw-tg-dl-using-localapi

An [OpenClaw](https://github.com/openclaw/openclaw) skill that patches OpenClaw to download Telegram files through a [Local Bot API Server](https://core.telegram.org/bots/api#using-a-local-bot-api-server), bypassing the standard Bot API 20 MB limit (up to 2 GB).

## Why

The Telegram Bot API limits file downloads to 20 MB. By running a Local Bot API Server on your machine and patching OpenClaw's `resolveMedia()`, files up to 2 GB are downloaded transparently — no AI intervention needed.

## What This Does

### Layer 1: Transparent Large File Download (Patch)

Patches OpenClaw's dist files to:

1. **Config schema** — Adds `localBotApiUrl` field to the Telegram channel Zod schema
2. **`resolveMedia()` integration** — Routes `getFile` + file downloads through the Local Bot API when configured
3. **`file_id` fallback injection** — If `resolveMedia()` still fails, injects `<telegram_large_file>` metadata into the message so the AI can trigger manual download

### Layer 2: Standalone Download Script

`scripts/tg-download.sh` downloads files by `file_id` via the Local Bot API, with 3-tier fallback:
1. **Volume mount** — direct host filesystem copy (fastest)
2. **docker cp** — copy from container
3. **HTTP download** — standard API endpoint

## Prerequisites

- [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) Docker container running with `TELEGRAM_LOCAL=true`
- `docker`, `curl`, `python3` on the host
- OpenClaw installed globally via npm

## Installation

```bash
# Clone
git clone https://github.com/Kinolian1107/openclaw-tg-dl-using-localapi.git ~/git/openclaw-tg-dl-using-localapi

# Symlink into OpenClaw skills
ln -s ~/git/openclaw-tg-dl-using-localapi ~/.openclaw/skills/tg-dl-localapi

# Apply patch
node ~/git/openclaw-tg-dl-using-localapi/scripts/patch-openclaw.js

# Add to openclaw.json under channels.telegram:
#   "localBotApiUrl": "http://localhost:18995",
#   "mediaMaxMb": 2000

# Restart
openclaw gateway restart
```

## After `openclaw update`

Each `openclaw update` replaces the dist files. Re-apply the patch:

```bash
# One-liner
bash ~/git/openclaw-tg-dl-using-localapi/scripts/post-update.sh

# Or manually
node ~/git/openclaw-tg-dl-using-localapi/scripts/patch-openclaw.js
openclaw gateway restart
```

The patch script is **idempotent** — safe to re-run on already-patched files.

## How It Works

```
User sends 50MB video via Telegram
       │
       ▼
OpenClaw receives Telegram update (message has file_id)
       │
       ▼
resolveMedia() sees localBotApiUrl in config
       │
       ▼
Calls Local Bot API (localhost:18995) getFile → local file_path
       │
       ▼
Downloads from Local Bot API /file/bot<token>/... → saves to disk
       │
       ▼
File passed to AI as media attachment (same as any ≤20MB file)
```

If Local Bot API is down, the patch injects `<telegram_large_file>` XML with `file_id` into the message text, allowing the AI to call `tg-download.sh` as a fallback.

## What Gets Patched

| Phase | Files | Change |
|-------|-------|--------|
| Config schema | ~6-11 | Adds `localBotApiUrl: z.string().optional()` to Telegram Zod schema |
| resolveMedia() | ~5-10 | Adds `localBotApiUrl` param, routes downloads through Local Bot API |
| file_id injection | ~5-10 | Injects `<telegram_large_file>` tag when media download fails |

Patches are marked with `/* tg-localapi-url-patch */` and `/* tg-dl-localapi-patch */` for idempotency.

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

## Manual Download

```bash
# Download by file_id
scripts/tg-download.sh "BAADBAADxwADZv..." -o /output/dir

# With volume mount (fastest)
scripts/tg-download.sh "BAADBAADxwADZv..." -o /output/dir -v /opt/docker/telegram-bot-api/data

# Capture path in pipeline
FILE_PATH=$(scripts/tg-download.sh "$FILE_ID" -o /home/kino/asr)
```

| Flag | Default | Description |
|------|---------|-------------|
| `-o` | `.` | Output directory |
| `-t` | auto from `openclaw.json` | Bot token |
| `-u` | `http://localhost:18995` | Local Bot API URL |
| `-c` | `telegram-bot-api` | Docker container name |
| `-v` | (none) | Host volume path for `/var/lib/telegram-bot-api` |

## Docker Setup

If you don't have the Local Bot API container yet:

```yaml
# docker-compose.yml
telegram-bot-api:
  image: aiogram/telegram-bot-api:latest
  restart: unless-stopped
  environment:
    TELEGRAM_API_ID: "<your-api-id>"       # From https://my.telegram.org
    TELEGRAM_API_HASH: "<your-api-hash>"
    TELEGRAM_LOCAL: "true"
  ports:
    - "18995:8081"
  volumes:
    - telegram-bot-api-data:/var/lib/telegram-bot-api
```

## Troubleshooting

**Patch reports "0 patched, 0 already done":**
OpenClaw's dist format changed. Open an issue with your OpenClaw version (`cat $(npm root -g)/openclaw/dist/build-info.json`).

**Config validation error on startup:**
The config schema patch didn't apply. Re-run `node scripts/patch-openclaw.js` and check output.

**Files still limited to 20MB:**
1. Check `localBotApiUrl` is set in `openclaw.json` under `channels.telegram`
2. Verify Local Bot API is running: `curl http://localhost:18995/bot<TOKEN>/getMe`
3. Check gateway was restarted after patching

## Environment Variables

| Variable | Equivalent Flag |
|----------|----------------|
| `TG_DL_TOKEN` | `-t` |
| `TG_DL_API_URL` | `-u` |
| `TG_DL_CONTAINER` | `-c` |
| `TG_DL_VOLUME_MAP` | `-v` |

## License

MIT
