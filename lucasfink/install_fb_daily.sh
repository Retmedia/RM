#!/usr/bin/env bash
#
# Install the daily Facebook publishing job. Run once.
#
# Verifies everything first, does a dry run, and only then installs the launchd
# job. Safe to re-run - it replaces the existing job rather than duplicating it.
#
# Usage:  ./install_fb_daily.sh "/path/to/Lucas Fink"
#
set -euo pipefail

LABEL="com.retmedia.lucasfink.fbpublish"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISHER="$HOME/fb_publish_daily.py"
QUEUE="$HOME/lucas_caption_queue.csv"
TOKEN="$HOME/.fb_lucas_token"
LOG="$HOME/fb_publish.log"
HOUR=9
MINUTE=15

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
ok()  { printf '  ok  %s\n' "$*"; }

echo "== Lucas Fink -> Facebook daily publisher =="
echo

# ---------------------------------------------------------------------------
# 1. Where are the videos
# ---------------------------------------------------------------------------
VIDEO_DIR="${1:-${VIDEO_DIR:-}}"
if [ -z "$VIDEO_DIR" ]; then
  read -r -p "Full path to the Lucas Fink video folder in RM Drive: " VIDEO_DIR
fi
VIDEO_DIR="${VIDEO_DIR%/}"
[ -d "$VIDEO_DIR" ] || die "not a folder: $VIDEO_DIR"
COUNT=$(find "$VIDEO_DIR" -maxdepth 1 -type f \( -name '*.mp4' -o -name '*.mov' -o -name '*.webm' \) | wc -l | tr -d ' ')
ok "video folder: $VIDEO_DIR ($COUNT videos)"
[ "$COUNT" -gt 0 ] || die "no videos in that folder - run download_lucasfink_tiktok.sh first"
if [ "$COUNT" -lt 1993 ]; then
  echo "  !!  only $COUNT of 1993 downloaded - the job will publish what is there and skip the rest"
fi

# ---------------------------------------------------------------------------
# 2. Interpreter
# ---------------------------------------------------------------------------
if [ -x "$HOME/.tiktok-dl-venv/bin/python" ]; then
  PYTHON="$HOME/.tiktok-dl-venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="$(command -v python3)"
else
  die "no python3 found. Install Xcode command line tools: xcode-select --install"
fi
ok "python: $PYTHON ($("$PYTHON" -V 2>&1))"

# ---------------------------------------------------------------------------
# 3. Install the files into $HOME and point the publisher at the videos
# ---------------------------------------------------------------------------
[ -f "$SRC_DIR/fb_publish_daily.py" ] || die "fb_publish_daily.py not next to this script"
[ -f "$SRC_DIR/lucas_caption_queue.csv" ] || die "lucas_caption_queue.csv not next to this script"

cp "$SRC_DIR/fb_publish_daily.py" "$PUBLISHER"
cp "$SRC_DIR/lucas_caption_queue.csv" "$QUEUE"
chmod +x "$PUBLISHER"

"$PYTHON" - "$PUBLISHER" "$VIDEO_DIR" <<'PYEOF'
import sys, re, pathlib
p, d = pathlib.Path(sys.argv[1]), sys.argv[2]
src = p.read_text(encoding="utf-8")
new, n = re.subn(r'^VIDEO_DIR = .*$', 'VIDEO_DIR = ' + repr(d) + '  # set by install_fb_daily.sh',
                 src, count=1, flags=re.M)
if n != 1:
    sys.exit("could not patch VIDEO_DIR")
p.write_text(new, encoding="utf-8")
PYEOF
ok "installed $PUBLISHER (VIDEO_DIR set)"
ok "installed $QUEUE ($(( $(wc -l < "$QUEUE") - 1 )) captions)"

# ---------------------------------------------------------------------------
# 4. Token
# ---------------------------------------------------------------------------
if [ ! -f "$TOKEN" ]; then
  cat <<'MSG'

  !!  No token yet at ~/.fb_lucas_token

      This is the one step that cannot be automated. Five minutes, free:

      1. developers.facebook.com -> My Apps -> Create App -> type "Business"
      2. Tools -> Graph API Explorer
      3. Pick the app -> "Get Token" -> "Get Page Access Token" -> Lucas Fink page
      4. Add permissions: pages_show_list, pages_read_engagement, pages_manage_posts
      5. Paste the token into the Access Token Debugger -> "Extend Access Token"
      6. Save it:   echo 'THE_TOKEN' > ~/.fb_lucas_token && chmod 600 ~/.fb_lucas_token

      Better: Business Settings -> System Users -> Add -> assign the Page ->
      Generate Token with those same three permissions. That token never expires.
      The extended one above dies in ~60 days and this run is 80.

MSG
  read -r -p "  Paste the token now (or press Enter to do it later): " PASTED
  if [ -n "$PASTED" ]; then
    printf '%s\n' "$PASTED" > "$TOKEN"
    chmod 600 "$TOKEN"
    ok "saved $TOKEN"
  fi
else
  chmod 600 "$TOKEN"
  ok "token present: $TOKEN"
fi

# ---------------------------------------------------------------------------
# 5. Dry run - proves the queue, the files and the captions all line up
# ---------------------------------------------------------------------------
echo
echo "-- dry run (nothing is published) --"
"$PYTHON" "$PUBLISHER" --dry-run --limit 5 || die "dry run failed - not installing the job"
echo

# ---------------------------------------------------------------------------
# 6. launchd job
# ---------------------------------------------------------------------------
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>$PUBLISHER</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>$HOUR</integer>
        <key>Minute</key><integer>$MINUTE</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
    <key>WorkingDirectory</key>
    <string>$HOME</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLISTEOF

plutil -lint "$PLIST" >/dev/null || die "generated plist is malformed"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
ok "launchd job installed: daily at $(printf '%02d:%02d' $HOUR $MINUTE)"

# ---------------------------------------------------------------------------
# 7. Sleep
# ---------------------------------------------------------------------------
echo
if pmset -g custom 2>/dev/null | awk '/^AC Power/,0' | grep -qE '^[[:space:]]*sleep[[:space:]]+0'; then
  ok "Mac does not sleep on AC power"
else
  cat <<'MSG'
  !!  This Mac sleeps on AC power.

      launchd SKIPS a missed run rather than queuing it, so every night the lid
      is shut is a day added to the 80. Fix it with:

        sudo pmset -a sleep 0

MSG
fi

# ---------------------------------------------------------------------------
# 8. What to do next
# ---------------------------------------------------------------------------
cat <<MSG

Installed. Before letting it run unattended, post three real ones and look at
the Page:

    $PYTHON $PUBLISHER --limit 3

Confirm all three are actual Reels with the right caption. If they are, the
other 1990 will be too - it is the same three API calls every time.

Day to day:
    $PYTHON $PUBLISHER --status     progress
    tail -f $LOG                    watch it work
    launchctl kickstart gui/$(id -u)/$LABEL    run today's batch now
    launchctl bootout  gui/$(id -u)/$LABEL     stop the job for good
MSG
