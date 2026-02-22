#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: tg-download.sh <file_id> [options]

Download a Telegram file by file_id using Local Bot API Server.

Arguments:
  file_id             Telegram file_id (required)

Options:
  -o, --output-dir    Output directory (default: current dir)
  -t, --token         Bot token (auto-detected from openclaw.json if omitted)
  -u, --api-url       Local Bot API URL (default: http://localhost:18995)
  -h, --help          Show this help

Output:
  Prints the absolute path of the downloaded file to stdout.
  All status messages go to stderr.
USAGE
  exit 0
}

json_get() {
  python3 -c "import json,sys; d=json.load(sys.stdin); exec(sys.argv[1])" "$1"
}

API_URL="http://localhost:18995"
BOT_TOKEN=""
OUTPUT_DIR="."
FILE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    -t|--token)      BOT_TOKEN="$2"; shift 2 ;;
    -u|--api-url)    API_URL="$2"; shift 2 ;;
    -h|--help)       usage ;;
    -*)              echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$FILE_ID" ]]; then
        FILE_ID="$1"; shift
      else
        echo "Unexpected argument: $1" >&2; exit 1
      fi
      ;;
  esac
done

if [[ -z "$FILE_ID" ]]; then
  echo "Error: file_id is required" >&2
  usage
fi

if [[ -z "$BOT_TOKEN" ]]; then
  OPENCLAW_CFG="${HOME}/.openclaw/openclaw.json"
  if [[ -f "$OPENCLAW_CFG" ]]; then
    BOT_TOKEN=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        t = json.load(f).get('channels',{}).get('telegram',{}).get('botToken','')
    print(t, end='')
except: pass
" "$OPENCLAW_CFG" 2>/dev/null) || true
  fi
  if [[ -z "$BOT_TOKEN" ]]; then
    echo "Error: Bot token not found. Provide via -t or set in openclaw.json" >&2
    exit 1
  fi
  echo "Auto-detected bot token from openclaw.json" >&2
fi

API_URL="${API_URL%/}"
mkdir -p "$OUTPUT_DIR"

echo "Calling getFile for file_id=${FILE_ID:0:20}..." >&2
ENCODED_ID=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$FILE_ID")
GET_FILE_RESP=$(curl -sS "${API_URL}/bot${BOT_TOKEN}/getFile?file_id=${ENCODED_ID}")

OK=$(echo "$GET_FILE_RESP" | json_get "print(d.get('ok', False))")
if [[ "$OK" != "True" ]]; then
  DESC=$(echo "$GET_FILE_RESP" | json_get "print(d.get('description', 'unknown error'))")
  echo "Error: getFile failed: $DESC" >&2
  exit 1
fi

FILE_PATH=$(echo "$GET_FILE_RESP" | json_get "print(d['result']['file_path'])")
FILE_SIZE=$(echo "$GET_FILE_RESP" | json_get "print(d['result'].get('file_size', 'unknown'))")

if [[ -z "$FILE_PATH" || "$FILE_PATH" == "None" ]]; then
  echo "Error: getFile returned empty file_path" >&2
  exit 1
fi

FILENAME=$(basename "$FILE_PATH")
if [[ "$FILE_SIZE" != "unknown" ]]; then
  SIZE_MB=$(awk "BEGIN{printf \"%.1f\", $FILE_SIZE/1048576}")
  echo "File: ${FILENAME} (${SIZE_MB} MB)" >&2
else
  echo "File: ${FILENAME}" >&2
fi

DOWNLOAD_URL="${API_URL}/file/bot${BOT_TOKEN}/${FILE_PATH}"
OUTPUT_PATH="${OUTPUT_DIR}/${FILENAME}"

echo "Downloading to ${OUTPUT_PATH}..." >&2
HTTP_CODE=$(curl -# -w '%{http_code}' -o "$OUTPUT_PATH" "$DOWNLOAD_URL" 2>&2)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Error: Download failed with HTTP ${HTTP_CODE}" >&2
  rm -f "$OUTPUT_PATH"
  exit 1
fi

ACTUAL_SIZE=$(stat -c%s "$OUTPUT_PATH" 2>/dev/null || stat -f%z "$OUTPUT_PATH" 2>/dev/null || echo "unknown")
if [[ "$ACTUAL_SIZE" != "unknown" ]]; then
  ACTUAL_MB=$(awk "BEGIN{printf \"%.1f\", $ACTUAL_SIZE/1048576}")
  echo "Downloaded ${ACTUAL_MB} MB" >&2
fi

realpath "$OUTPUT_PATH"
