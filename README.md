# tg-dl-localapi

OpenClaw skill for downloading Telegram files via a [Local Bot API Server](https://github.com/tdlib/telegram-bot-api), bypassing the standard 20 MB download limit (up to 2 GB).

## Why?

The Telegram standard Bot API limits file downloads to 20 MB. By running a Local Bot API Server, this limit is raised to 2 GB. However, the local server in `TELEGRAM_LOCAL=true` mode returns absolute container paths that can't be fetched via the standard HTTP download endpoint. This skill handles that correctly using `docker cp`.

## Prerequisites

1. A running `telegram-bot-api` Docker container with `TELEGRAM_LOCAL=true`
2. Docker CLI access
3. OpenClaw with a configured Telegram bot token

### Example Docker Compose

```yaml
telegram-bot-api:
  image: aiogram/telegram-bot-api:latest
  ports:
    - "18995:8081"
  environment:
    - TELEGRAM_API_ID=${TELEGRAM_API_ID}
    - TELEGRAM_API_HASH=${TELEGRAM_API_HASH}
    - TELEGRAM_LOCAL=true
  volumes:
    - ./telegram-bot-api-data:/var/lib/telegram-bot-api
```

You need `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from [my.telegram.org](https://my.telegram.org).

## Install as OpenClaw Skill

```bash
ln -s /path/to/openclaw-tg-dl-using-localapi ~/.openclaw/skills/tg-dl-localapi
openclaw gateway restart
```

## Usage

```bash
# Download by file_id (bot token auto-detected from openclaw.json)
scripts/tg-download.sh <file_id> -o /output/dir

# All options
scripts/tg-download.sh <file_id> \
  -o /output/dir \
  -t BOT_TOKEN \
  -u http://localhost:18995 \
  -c telegram-bot-api \
  -v /opt/docker/telegram-bot-api/data
```

Output: absolute path of the downloaded file (printed to stdout).

## Download Strategy

The script tries three methods in order:

1. **Volume mount** — direct host filesystem copy (fastest; needs `-v` and read permissions)
2. **docker cp** — extracts file from the container (default method)
3. **HTTP download** — standard `/file/` endpoint (fallback for non-local mode)

## License

MIT
