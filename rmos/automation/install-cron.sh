#!/usr/bin/env bash
# Installs the two scheduled jobs. Idempotent: run it again after moving the
# checkout and it replaces its own entries rather than stacking new ones.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
MARK="# rmos"

DAILY="30 7 * * 1-5 cd $ROOT && $NODE automation/run.js daily >> $ROOT/data/automation.log 2>&1 $MARK"
WEEKLY="0 7 * * 1 cd $ROOT && $NODE automation/run.js weekly >> $ROOT/data/automation.log 2>&1 $MARK"

mkdir -p "$ROOT/data"
( crontab -l 2>/dev/null | grep -v "$MARK" || true; echo "$WEEKLY"; echo "$DAILY" ) | crontab -

echo "Installed:"
echo "  Monday 07:00   build the week and check it fits"
echo "  Weekdays 07:30 briefs, alerts and the digest"
echo
echo "Output: $ROOT/data/briefs/  ·  log: $ROOT/data/automation.log"
echo "Set RMOS_WEBHOOK to push the digest somewhere (Slack, email relay, anything that takes JSON)."
echo
crontab -l | grep "$MARK"
