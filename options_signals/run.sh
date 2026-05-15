#!/usr/bin/env bash
# Fire-and-forget launcher: creates a venv on first run, then exec's the bot.
# Pass any bot.py flags through as arguments, e.g.:
#   ./run.sh --watchlist SPY,QQQ,NVDA --target-pct 0.75 --max-hold-minutes 240
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  echo "first run — creating .venv and installing requirements..."
  python3 -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet -r requirements.txt
fi

exec .venv/bin/python bot.py "$@"
