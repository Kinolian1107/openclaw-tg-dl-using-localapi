# openclaw-tg-dl-using-localapi

An [OpenClaw](https://github.com/openclaw/openclaw) skill that enables downloading Telegram files >20 MB via a [Local Bot API Server](https://core.telegram.org/bots/api#using-a-local-bot-api-server), bypassing the standard Bot API 20 MB limit (up to 2 GB).

## Problem

The Telegram Bot API limits file downloads to 20 MB. When a user sends a larger file, OpenClaw's `resolveMedia()` silently fails and the AI has no way to access the file — it doesn't even receive the `file_id`.

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
git clone https://github.com/Kinolian1107/openclaw-tg-dl-using-localapi.git /path/to/skill

# Symlink into OpenClaw skills
ln -s /path/to/skill ~/.openclaw/skills/tg-dl-localapi

# Apply the patch
node /path/to/skill/scripts/patch-openclaw.js

# Restart gateway
openclaw gateway restart
```

### After `openclaw update`

The patch modifies dist files that get replaced on update. Re-apply:

```bash
node /path/to/skill/scripts/patch-openclaw.js
openclaw gateway restart
```

The patch script is **idempotent** — safe to re-run.

## Usage

### Automatic (with patch)

Once patched, the AI automatically sees `<telegram_large_file>` tags when users send files >20 MB. The AI extracts the `file_id` and calls the download script.

### Manual

```bash
# Basic download
scripts/tg-download.sh "BAADBAADxwADZv..." -o /output/dir

# With volume mount (fastest)
scripts/tg-download.sh "BAADBAADxwADZv..." -o /output/dir -v /opt/docker/telegram-bot-api/data
```

| Flag | Default | Description |
|------|---------|-------------|
| `-o` | `.` | Output directory |
| `-t` | auto from `openclaw.json` | Bot token |
| `-u` | `http://localhost:18995` | Local Bot API URL |
| `-c` | `telegram-bot-api` | Docker container name |
| `-v` | (none) | Host volume path for `/var/lib/telegram-bot-api` |

Output: absolute path of the downloaded file on stdout.

## How the Patch Works

The patch targets the Telegram message handler in OpenClaw's bundled dist files (~10 JS files, all containing the same `resolveMedia` handler).

**Before**: When `resolveMedia()` fails for a >20 MB file, it returns `null`. The message proceeds with empty `allMedia[]`. The AI sees the message text/caption but has no information about the file.

**After**: When `resolveMedia()` returns `null` and the message has media with a `file_id`, the patch injects a `<telegram_large_file>` tag into the message body containing:

```json
{
  "file_id": "BAADBAADxw...",
  "file_size": 52428800,
  "file_name": "video.mp4",
  "mime_type": "video/mp4"
}
```

The AI then uses this information to download the file via `scripts/tg-download.sh`.

## Integration with ASR

This skill works seamlessly with ASR skills. When a user sends a large audio/video file for transcription:

1. The AI sees the `<telegram_large_file>` tag
2. Downloads the file using this skill's script
3. Passes the downloaded file to the ASR skill for processing

## License

MIT
