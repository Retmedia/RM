#!/usr/bin/env bash
set -euo pipefail

# Resolve to the directory this script lives in (handles symlinks too).
SCRIPT_PATH="${BASH_SOURCE[0]}"
while [ -L "$SCRIPT_PATH" ]; do
  TARGET="$(readlink "$SCRIPT_PATH")"
  case "$TARGET" in
    /*) SCRIPT_PATH="$TARGET" ;;
    *)  SCRIPT_PATH="$(dirname "$SCRIPT_PATH")/$TARGET" ;;
  esac
done
PROJECT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
cd "$PROJECT_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js (>= 18) is required. Install from https://nodejs.org"
  echo
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing Node dependencies..."
  npm install --no-fund --no-audit
fi

if [ ! -x bin/yt-dlp ] && [ ! -x bin/yt-dlp.exe ]; then
  echo "Installing yt-dlp binary..."
  node scripts/install-yt-dlp.mjs
fi

PORT="${PORT:-3939}"
URL="http://localhost:${PORT}"

echo
echo "EkkoArchive starting at ${URL}"
echo "Press Ctrl-C in this window when done."
echo

(sleep 1 && open "$URL" >/dev/null 2>&1 || true) &

PORT="$PORT" exec node server/server.js
