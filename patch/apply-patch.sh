#!/bin/bash
# Patch OpenClaw to support Telegram Local Bot API for file downloads.
# Re-run after every `openclaw update`.
#
# Usage:
#   ./apply-patch.sh              # Apply patch
#   ./apply-patch.sh --dry-run    # Preview changes only
#   ./apply-patch.sh --restore    # Restore from backup

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Find OpenClaw dist
if command -v openclaw &>/dev/null; then
  OC_BIN="$(readlink -f "$(which openclaw)")"
  DIST_DIR="$(dirname "$(dirname "$OC_BIN")")/lib/node_modules/openclaw/dist"
else
  NVM_DIR="${HOME}/.nvm/versions/node"
  if [ -d "$NVM_DIR" ]; then
    NODE_VER="$(ls "$NVM_DIR" | sort -V | tail -1)"
    DIST_DIR="${NVM_DIR}/${NODE_VER}/lib/node_modules/openclaw/dist"
  fi
fi

if [ ! -d "${DIST_DIR:-}" ]; then
  echo "ERROR: OpenClaw dist not found."
  exit 1
fi

# Handle --restore
if [ "${1:-}" = "--restore" ]; then
  BACKUP="${DIST_DIR}.bak"
  if [ ! -d "$BACKUP" ]; then
    echo "ERROR: No backup found at $BACKUP"
    exit 1
  fi
  echo "Restoring from backup..."
  rm -rf "$DIST_DIR"
  cp -r "$BACKUP" "$DIST_DIR"
  echo "✓ Restored. Restart OpenClaw gateway to apply."
  exit 0
fi

# Create backup if not exists
BACKUP="${DIST_DIR}.bak"
if [ ! -d "$BACKUP" ]; then
  echo "Creating backup at ${BACKUP}..."
  cp -r "$DIST_DIR" "$BACKUP"
  echo "✓ Backup created."
fi

# Run the Node.js patcher
echo ""
node "$SCRIPT_DIR/apply-patch.js" "$@" --dist "$DIST_DIR"

echo ""
if [ "${1:-}" != "--dry-run" ]; then
  echo "Next steps:"
  echo "  1. Add to openclaw.json under channels.telegram:"
  echo '     "localBotApiUrl": "http://localhost:18995",'
  echo '     "mediaMaxMb": 2000'
  echo "  2. Restart gateway: openclaw gateway restart"
fi
