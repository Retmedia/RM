#!/usr/bin/env bash
# Ekko quick launch — double-click in Finder to start the app.
# First run installs dependencies + yt-dlp; later runs just start the server.

set -uo pipefail

# Resolve to the directory this script lives in (works even if aliased / moved).
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

# Finder launches Terminal with a minimal PATH; restore the usual install dirs.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Pause before exit so the Terminal window doesn't slam shut on errors. Cleared
# right before we exec into Node, which never returns to bash.
pause_on_exit() {
  echo
  read -n 1 -s -r -p "Press any key to close…"
  echo
}
trap pause_on_exit EXIT

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js 18+ is required."
  echo "Install the LTS version from https://nodejs.org and try again."
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo
  echo "Node $NODE_MAJOR is too old. Install Node 18+ from https://nodejs.org"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run — installing Node dependencies…"
  npm install --no-fund --no-audit || { echo "npm install failed."; exit 1; }
fi

if [ ! -x bin/yt-dlp ] && [ ! -x bin/yt-dlp.exe ]; then
  echo "First run — installing yt-dlp…"
  npm run install-ytdlp || { echo "yt-dlp install failed. Check your internet connection."; exit 1; }
fi

PORT="${PORT:-3939}"
URL="http://localhost:${PORT}"

echo
echo "Ekko starting at ${URL}"
echo "Press Ctrl-C in this window to stop the server."
echo

# Open the browser shortly after the server starts listening.
(sleep 1 && open "$URL" >/dev/null 2>&1 || true) &

# Hand off to Node — this replaces bash, so the EXIT trap won't fire on Ctrl-C.
trap - EXIT
PORT="$PORT" exec node server/server.js
