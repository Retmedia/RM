#!/usr/bin/env bash
# Double-click this file on a Mac to run DogPull.
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [ -L "$SCRIPT_PATH" ]; do
  TARGET="$(readlink "$SCRIPT_PATH")"
  case "$TARGET" in
    /*) SCRIPT_PATH="$TARGET" ;;
    *)  SCRIPT_PATH="$(dirname "$SCRIPT_PATH")/$TARGET" ;;
  esac
done
cd "$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

pause_and_exit() {
  echo
  read -n 1 -s -r -p "Press any key to close..."
  exit "$1"
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required. Install it from https://nodejs.org"
  pause_and_exit 1
fi

if [ ! -x bin/yt-dlp ] && [ ! -x bin/yt-dlp.exe ]; then
  echo "First run — installing yt-dlp..."
  node scripts/install-yt-dlp.mjs
fi

if ! command -v ffmpeg >/dev/null 2>&1 && [ ! -x bin/ffmpeg ]; then
  echo
  echo "ffmpeg is required to merge 4K video with its audio track."
  echo "Install it with:  brew install ffmpeg"
  pause_and_exit 1
fi

node dogpull.js "$@"
pause_and_exit 0
