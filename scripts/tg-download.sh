#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: tg-download.sh <file_id> [options]

Download a Telegram file by file_id using Local Bot API Server.

The Local Bot API (TELEGRAM_LOCAL=true) returns absolute container paths from
getFile. This script handles the download via docker cp (or direct volume
access when configured).

Arguments:
  file_id               Telegram file_id (required)

Options:
  -o, --output-dir      Output directory (default: current dir)
  -t, --token           Bot token (auto-detected from openclaw.json if omitted)
  -u, --api-url         Local Bot API URL (default: http://localhost:18995)
  -c, --container       Docker container name (default: telegram-bot-api)
  -v, --volume-map      Host path that maps to /var/lib/telegram-bot-api inside
                        the container. If set and accessible, copies directly
                        from host filesystem (faster, no docker needed).
                        Example: /opt/docker/telegram-bot-api/data
  -h, --help            Show this help

Output:
  Prints the absolute path of the downloaded file to stdout.
  All status messages go to stderr.

Environment:
  TG_DL_TOKEN           Bot token (overridden by -t)
  TG_DL_API_URL         Local Bot API URL (overridden by -u)
  TG_DL_CONTAINER       Container name (overridden by -c)
  TG_DL_VOLUME_MAP      Volume host path (overridden by -v)
USAGE
  exit 0
}

# --- defaults (env overridable) ---
API_URL="${TG_DL_API_URL:-http://localhost:18995}"
BOT_TOKEN="${TG_DL_TOKEN:-}"
CONTAINER="${TG_DL_CONTAINER:-telegram-bot-api}"
VOLUME_MAP="${TG_DL_VOLUME_MAP:-}"
OUTPUT_DIR="."
FILE_ID=""

# --- parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output-dir)  OUTPUT_DIR="$2"; shift 2 ;;
    -t|--token)       BOT_TOKEN="$2"; shift 2 ;;
    -u|--api-url)     API_URL="$2"; shift 2 ;;
    -c|--container)   CONTAINER="$2"; shift 2 ;;
    -v|--volume-map)  VOLUME_MAP="$2"; shift 2 ;;
    -h|--help)        usage ;;
    -*)               echo "Error: Unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$FILE_ID" ]]; then
        FILE_ID="$1"; shift
      else
        echo "Error: Unexpected argument: $1" >&2; exit 1
      fi
      ;;
  esac
done

if [[ -z "$FILE_ID" ]]; then
  echo "Error: file_id is required" >&2
  echo "Run with --help for usage" >&2
  exit 1
fi

# --- auto-detect bot token from openclaw.json ---
if [[ -z "$BOT_TOKEN" ]]; then
  OPENCLAW_CFG="${HOME}/.openclaw/openclaw.json"
  if [[ -f "$OPENCLAW_CFG" ]]; then
    BOT_TOKEN=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
print(cfg.get('channels', {}).get('telegram', {}).get('botToken', ''), end='')
" "$OPENCLAW_CFG" 2>/dev/null) || true
  fi
  if [[ -z "$BOT_TOKEN" ]]; then
    echo "Error: Bot token not found. Provide via -t, TG_DL_TOKEN, or set in openclaw.json" >&2
    exit 1
  fi
  echo "Auto-detected bot token from openclaw.json" >&2
fi

API_URL="${API_URL%/}"
mkdir -p "$OUTPUT_DIR"

# --- step 1: getFile ---
echo "Calling getFile for file_id=${FILE_ID:0:30}..." >&2
ENCODED_FILE_ID=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$FILE_ID")
GET_FILE_RESP=$(curl -sS --max-time 30 "${API_URL}/bot${BOT_TOKEN}/getFile?file_id=${ENCODED_FILE_ID}")

PARSED=$(python3 -c "
import json, sys
data = json.load(sys.stdin)
if not data.get('ok'):
    desc = data.get('description', 'unknown error')
    print(f'ERROR:{desc}')
else:
    r = data['result']
    fp = r.get('file_path', '')
    fs = r.get('file_size', 'unknown')
    print(f'OK:{fp}:{fs}')
" <<< "$GET_FILE_RESP")

if [[ "$PARSED" == ERROR:* ]]; then
  echo "Error: getFile failed: ${PARSED#ERROR:}" >&2
  exit 1
fi

FILE_PATH="${PARSED#OK:}"
FILE_SIZE="${FILE_PATH##*:}"
FILE_PATH="${FILE_PATH%:*}"

if [[ -z "$FILE_PATH" ]]; then
  echo "Error: getFile returned empty file_path" >&2
  exit 1
fi

FILENAME=$(basename "$FILE_PATH")
OUTPUT_PATH="${OUTPUT_DIR}/${FILENAME}"

if [[ "$FILE_SIZE" != "unknown" ]]; then
  SIZE_HR=$(python3 -c "
s=int('${FILE_SIZE}')
for u in ['B','KB','MB','GB']:
    if s < 1024: print(f'{s:.1f} {u}'); break
    s /= 1024
")
  echo "File: ${FILENAME} (${SIZE_HR})" >&2
else
  echo "File: ${FILENAME}" >&2
fi

# --- step 2: download the file ---
DOWNLOADED=false

# Method A: direct volume access (fastest, no docker needed)
if [[ -n "$VOLUME_MAP" && "$FILE_PATH" == /var/lib/telegram-bot-api/* ]]; then
  RELATIVE="${FILE_PATH#/var/lib/telegram-bot-api/}"
  HOST_PATH="${VOLUME_MAP%/}/${RELATIVE}"
  if [[ -r "$HOST_PATH" ]]; then
    echo "Copying from volume: ${HOST_PATH}" >&2
    cp "$HOST_PATH" "$OUTPUT_PATH"
    DOWNLOADED=true
  else
    echo "Volume path not readable (${HOST_PATH}), falling back..." >&2
  fi
fi

# Method B: docker cp (works with any container setup)
if [[ "$DOWNLOADED" == "false" ]] && command -v docker &>/dev/null; then
  echo "Downloading via docker cp from ${CONTAINER}:${FILE_PATH}" >&2
  if docker cp "${CONTAINER}:${FILE_PATH}" "$OUTPUT_PATH" 2>/dev/null; then
    DOWNLOADED=true
  else
    echo "docker cp failed, trying HTTP fallback..." >&2
  fi
fi

# Method C: HTTP download (works when file_path is relative / non-local mode)
if [[ "$DOWNLOADED" == "false" ]]; then
  DOWNLOAD_URL="${API_URL}/file/bot${BOT_TOKEN}/${FILE_PATH}"
  echo "Downloading via HTTP..." >&2
  HTTP_CODE=$(curl -sS --max-time 600 -w '%{http_code}' -o "$OUTPUT_PATH" "$DOWNLOAD_URL")
  if [[ "$HTTP_CODE" == "200" ]]; then
    DOWNLOADED=true
  else
    rm -f "$OUTPUT_PATH"
  fi
fi

if [[ "$DOWNLOADED" == "false" ]]; then
  echo "Error: All download methods failed" >&2
  exit 1
fi

ACTUAL_SIZE=$(stat -c%s "$OUTPUT_PATH" 2>/dev/null || stat -f%z "$OUTPUT_PATH" 2>/dev/null || echo "unknown")
echo "Downloaded ${ACTUAL_SIZE} bytes -> ${OUTPUT_PATH}" >&2

# --- output: absolute path to stdout ---
realpath "$OUTPUT_PATH"
