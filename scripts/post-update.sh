#!/bin/bash
# Re-apply Local Bot API patch after `openclaw update`.
# Usage: bash scripts/post-update.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Re-applying Telegram Local Bot API patch..."
node "${SCRIPT_DIR}/patch-openclaw.js"

echo ""
echo "Restarting OpenClaw gateway..."
openclaw gateway restart

echo ""
echo "Done. Local Bot API patch re-applied."
