#!/bin/bash
# Double-click this file in Finder to start RM OS.
# It sets itself up on first run, builds the week, and opens the dashboard.

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node is not installed. Get it from https://nodejs.org (the LTS build) and run this again."
  echo
  read -r -p "Press return to close."
  exit 1
fi

echo "RM OS"
echo "─────"
echo

# First run: write the starting state.
if [ ! -f data/rmos.json ]; then
  echo "Setting up for the first time…"
  node cli/rmos.js init
  echo
fi

# Build this week and the next. Safe to run every time — it never duplicates work,
# and it never dates anything into the past.
node cli/rmos.js week --weeks 2
echo

node cli/rmos.js pulse
echo
echo "─────────────────────────────────────────────"
echo "Opening the dashboard at http://localhost:3940"
echo "Close this window, or press Ctrl-C, to stop it."
echo "─────────────────────────────────────────────"
echo

( sleep 2; open http://localhost:3940 ) &
node server/server.js
