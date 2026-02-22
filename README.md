# openclaw-tg-dl-using-localapi

An [OpenClaw](https://github.com/openclaw/openclaw) skill that enables downloading Telegram files >20 MB via a [Local Bot API Server](https://core.telegram.org/bots/api#using-a-local-bot-api-server), bypassing the standard Bot API 20 MB limit (up to 2 GB).

## Problem

The Telegram Bot API limits file downloads to 20 MB. When a user sends a larger file, OpenClaw's `resolveMedia()` silently fails and returns `null`. The AI proceeds with an empty media list — it never receives the `file_id` and has no way to access the file.

## Solution

This skill provides two components:

### 1. OpenClaw Patch (`scripts/patch-openclaw.js`)

Modifies OpenClaw's dist files so that when `resolveMedia()` fails for large files, the `file_id` and file metadata are injected into the message body as a `<telegram_large_file>` tag:

```xml
<telegram_large_file>{"file_id":"BAADBAADxw...","file_size":52428800,"file_name":"video.mp4","mime_type":"video/mp4"}</telegram_large_file>
```

This allows the AI to detect large files and automatically download them.

### 2. Download Script (`scripts/tg-download.sh`)

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

# Apply the patch
node ~/git/openclaw-tg-dl-using-localapi/scripts/patch-openclaw.js

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

### End-to-End Flow

```
User sends 50MB video via Telegram
       │
       ▼
OpenClaw receives Telegram update (message has file_id)
       │
       ▼
resolveMedia() calls Telegram Bot API getFile()
       │
       ▼
Bot API returns "file is too big" (>20MB limit)
       │
       ▼
resolveMedia() returns null → media = null
       │
       ▼
★ PATCH CODE RUNS: detects msg has file_id but media is null
       │
       ▼
Injects <telegram_large_file> tag with file_id/metadata into msg.text or msg.caption
       │
       ▼
Message proceeds through normal OpenClaw pipeline
       │
       ▼
AI sees <telegram_large_file> tag in user message → reads SKILL.md
       │
       ▼
AI calls tg-download.sh with file_id → downloads via Local Bot API → file saved locally
       │
       ▼
AI processes the downloaded file (ASR, forwarding, etc.)
```

### Technical: What the Patch Modifies

The patch targets the Telegram message handler in OpenClaw's bundled dist files. There are ~10 JS files that each contain a copy of the same `resolveMedia` handler (different entry point bundles).

**Before (original OpenClaw)**:
```javascript
// resolveMedia returns null when file is too big
media = await resolveMedia(ctx, ...);
// media is null → allMedia is empty → AI never sees file_id
const hasText = Boolean((msg.text ?? msg.caption ?? "").trim());
```

**After (with patch)**:
```javascript
media = await resolveMedia(ctx, ...);
/* tg-dl-localapi-patch */
if (!media) {
    const _mo = msg.document ?? msg.video ?? msg.audio ?? msg.voice ?? msg.video_note;
    if (_mo?.file_id) {
        // Inject <telegram_large_file> tag with metadata
        const _tag = "<telegram_large_file>" + JSON.stringify({
            file_id: _mo.file_id,
            file_size: ...,
            file_name: ...,
            mime_type: ...
        }) + "</telegram_large_file>";
        // Append to msg.text or msg.caption
        if (msg.caption !== undefined) msg.caption = text + "\n" + _tag;
        else msg.text = text + "\n" + _tag;
    }
}
const hasText = Boolean((msg.text ?? msg.caption ?? "").trim());
```

The modification is to `msg.text` / `msg.caption` — the Telegram message object itself. This ensures the metadata flows naturally through the rest of OpenClaw's message pipeline (debouncing, inbound context building, agent prompt construction) without requiring changes to any other code.

### Patch Detection

The patch uses a marker comment `/* tg-dl-localapi-patch */` for idempotency. The script:
1. Scans all `.js` files in OpenClaw's `dist/` directory (including `plugin-sdk/`)
2. Skips files that already contain the marker
3. Finds files with the target code pattern and applies the patch
4. Reports results: patched count, already-patched count

## Usage

### Automatic (with patch)

Once patched, the AI automatically sees `<telegram_large_file>` tags when users send files >20 MB. The AI extracts the `file_id` from the JSON and calls the download script.

### Manual

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

Output: absolute path of the downloaded file on stdout.

## Integration with ASR

This skill works seamlessly with ASR skills. When a user sends a large audio/video file for transcription:

1. The AI sees the `<telegram_large_file>` tag
2. Downloads the file using this skill's script
3. Passes the downloaded file to the ASR skill for processing

## Environment Variables

| Variable | Equivalent Flag |
|----------|----------------|
| `TG_DL_TOKEN` | `-t` |
| `TG_DL_API_URL` | `-u` |
| `TG_DL_CONTAINER` | `-c` |
| `TG_DL_VOLUME_MAP` | `-v` |

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

## License

MIT
