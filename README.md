# openclaw-tg-dl-using-localapi

Patch [OpenClaw](https://github.com/openclaw/openclaw) to support [Telegram Local Bot API Server](https://core.telegram.org/bots/api#using-a-local-bot-api-server) for file downloads, bypassing the 20 MB limit (up to 2 GB).

## Problem

The standard Telegram Bot API limits file downloads to 20 MB. When a user sends a larger file, OpenClaw's `resolveMedia()` fails silently and the AI never receives the file.

## Solution

This project patches OpenClaw's bundled dist files to add `localBotApiUrl` config support. When configured:

- **File downloads** (getFile + file content) go through your Local Bot API Server → no 20 MB limit
- **Everything else** (sending messages, reactions, etc.) stays on the standard Telegram API

This is the same approach that grammY natively supports via `apiRoot`, but OpenClaw doesn't expose it.

## Prerequisites

- A running [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) Docker container
- `api_id` and `api_hash` from [my.telegram.org](https://my.telegram.org)
- OpenClaw installed globally via npm
- Node.js

## Installation

### 1. Clone

```bash
git clone https://github.com/Kinolian1107/openclaw-tg-dl-using-localapi.git ~/git/openclaw-tg-dl-using-localapi
```

### 2. Docker Setup (if not already running)

Add to your `docker-compose.yml`:

```yaml
telegram-bot-api:
  image: aiogram/telegram-bot-api:latest
  restart: unless-stopped
  environment:
    TELEGRAM_API_ID: "<your-api-id>"
    TELEGRAM_API_HASH: "<your-api-hash>"
    TELEGRAM_LOCAL: "true"
  ports:
    - "18995:8081"
  volumes:
    - telegram-bot-api-data:/var/lib/telegram-bot-api
```

### 3. Apply the Patch

```bash
# Preview changes
node ~/git/openclaw-tg-dl-using-localapi/patch/apply-patch.js --dry-run

# Apply
node ~/git/openclaw-tg-dl-using-localapi/patch/apply-patch.js
```

Or use the wrapper script:

```bash
bash ~/git/openclaw-tg-dl-using-localapi/patch/apply-patch.sh
```

### 4. Configure OpenClaw

Add to `~/.openclaw/openclaw.json` under `channels.telegram`:

```json
{
  "channels": {
    "telegram": {
      "localBotApiUrl": "http://localhost:18995",
      "mediaMaxMb": 2000
    }
  }
}
```

### 5. Restart Gateway

```bash
openclaw gateway restart
```

### 6. (Optional) Install as OpenClaw Skill

The repo also includes a standalone download script. To make it available as a skill:

```bash
ln -s ~/git/openclaw-tg-dl-using-localapi ~/.openclaw/skills/tg-dl-localapi
```

## After `openclaw update`

Each `openclaw update` replaces the dist files. Re-apply the patch:

```bash
node ~/git/openclaw-tg-dl-using-localapi/patch/apply-patch.js
openclaw gateway restart
```

The patch is **idempotent** — safe to re-run on already-patched files.

To restore original dist files:

```bash
bash ~/git/openclaw-tg-dl-using-localapi/patch/apply-patch.sh --restore
```

## What the Patch Modifies

### Config Schema (6 files)

Adds `localBotApiUrl: z.string().optional()` to the Telegram channel config schema (`TelegramAccountSchemaBase`), allowing the field in `openclaw.json` without validation errors.

### resolveMedia Function (5 files)

Modifies the `resolveMedia(ctx, maxBytes, token, proxyFetch)` function:

1. **Adds `localBotApiUrl` parameter** to the function signature
2. **Adds `fileApiBase`** — resolves to Local Bot API URL when configured, falls back to `api.telegram.org`
3. **Adds `getFilePath` helper** — when `localBotApiUrl` is set, calls `getFile` via HTTP directly to the Local Bot API instead of through grammY's `ctx.getFile()` (which always uses the standard API)
4. **Updates download URL** — uses `fileApiBase` instead of hardcoded `api.telegram.org`
5. **Updates call sites** — passes `telegramCfg.localBotApiUrl` from config

### What's NOT Changed

- Bot constructor (`new Bot(token, ...)`) — all non-file-download API calls stay on standard API
- Probe/audit functions — health checks stay on standard API
- Message sending, reactions, etc. — all standard API

## Standalone Download Script

`scripts/tg-download.sh` can download files by `file_id` independently:

```bash
scripts/tg-download.sh <file_id> -o /output/dir
```

| Flag | Default | Description |
|------|---------|-------------|
| `-o` | `.` | Output directory |
| `-t` | auto from `openclaw.json` | Bot token |
| `-u` | `http://localhost:18995` | Local Bot API URL |
| `-c` | `telegram-bot-api` | Docker container name |
| `-v` | (none) | Host volume path for `/var/lib/telegram-bot-api` |

## Architecture

```
User sends 50MB file via Telegram
       │
       ▼
OpenClaw receives Telegram update (message has file_id)
       │
       ▼
resolveMedia() → getFilePath() → getFile via Local Bot API (port 18995)
       │                              │
       │                    ┌─────────┴─────────┐
       │                    │ telegram-bot-api   │
       │                    │ Docker container   │
       │                    │ (downloads from    │
       │                    │  Telegram servers) │
       │                    └─────────┬─────────┘
       │                              │
       ▼                              ▼
Downloads file content via Local Bot API → saves to disk
       │
       ▼
File attached to message → AI receives it normally
```

## License

MIT
