#!/usr/bin/env bash
#
# Download every video @lucasfinkrj has posted to TikTok, max quality, no watermark.
#
# Resumable: re-run it as many times as you like. Videos already downloaded are
# skipped via the archive file, so an interrupted run costs nothing.
#
# Usage:   ./download_lucasfink_tiktok.sh
#          DEST="/path/to/folder" ./download_lucasfink_tiktok.sh
#
set -euo pipefail

# ---------------------------------------------------------------------------
# SET THIS to the "Lucas Fink" folder inside RM Drive.
# ---------------------------------------------------------------------------
DEST="${DEST:-/Volumes/RM/Lucas Fink}"

# Profile enumeration by handle (@lucasfinkrj) FAILS. The channel-ID form works.
CHANNEL="tiktokuser:MS4wLjABAAAApBOPJCvWGgP2UMYgszzlkklApxB_hSGhpPO5fISqc0ICaxbkDZCLRm5aFsVCCuzA"

VENV="$HOME/.tiktok-dl-venv"
YTDLP="$VENV/bin/yt-dlp"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# The RM drive has to actually be plugged in.
VOLUME="$(printf '%s' "$DEST" | awk -F/ '/^\/Volumes\//{print "/Volumes/" $3}')"
if [ -n "$VOLUME" ] && [ ! -d "$VOLUME" ]; then
  echo "ERROR: $VOLUME is not mounted. Plug the RM drive in and run this again." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Self-install / upgrade yt-dlp
#    curl-cffi gives TLS impersonation. Without it TikTok intermittently 403s.
# ---------------------------------------------------------------------------
if [ ! -x "$VENV/bin/python" ]; then
  log "Creating venv at $VENV"
  python3 -m venv "$VENV"
fi
log "Installing/upgrading yt-dlp"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet --upgrade "yt-dlp[default,curl-cffi]"
log "yt-dlp $("$YTDLP" --version)"

# ---------------------------------------------------------------------------
# 2. Prepare destination
# ---------------------------------------------------------------------------
mkdir -p "$DEST" 2>/dev/null || true
if [ ! -d "$DEST" ]; then
  echo "ERROR: could not create $DEST" >&2
  exit 1
fi
if [ ! -w "$DEST" ]; then
  echo "ERROR: destination is not writable: $DEST" >&2
  echo "       If the drive is NTFS, macOS mounts it read-only. Reformat it exFAT or use another disk." >&2
  exit 1
fi
log "Destination: $DEST"

# Free space. 1993 videos come to roughly 23GB.
AVAIL_GB="$(df -g "$DEST" | awk 'NR==2 {print $4}')"
log "Free space: ${AVAIL_GB}GB (need ~23GB)"
if [ -n "$AVAIL_GB" ] && [ "$AVAIL_GB" -lt 25 ]; then
  echo "ERROR: only ${AVAIL_GB}GB free. Free up space before starting - a disk that fills" >&2
  echo "       up halfway leaves you with truncated video files." >&2
  exit 1
fi

# Filesystem. exFAT/FAT/NTFS reject ? " : * < > | which TikTok captions are full of,
# so filenames get sanitized on those volumes. APFS/HFS+ take them as-is.
FSTYPE="$(mount | sed -n 's/^.* on \(.*\) (\([a-z0-9]*\).*/\1|\2/p' \
  | awk -F'|' -v d="$DEST/" 'index(d, $1"/")==1 || $1=="/" { if (length($1) >= length(best)) { best=$1; fs=$2 } } END { print fs }')"
FS_ARGS=()
case "$FSTYPE" in
  apfs|hfs|"")
    [ -n "$FSTYPE" ] && log "Filesystem: $FSTYPE (captions preserved in filenames)"
    ;;
  *)
    log "Filesystem: $FSTYPE - using --windows-filenames so illegal characters are replaced"
    log "            (filenames only; Facebook captions come from the CSV and are untouched)"
    FS_ARGS+=(--windows-filenames)
    ;;
esac

ARCHIVE="$DEST/_archive.txt"
INDEX="$DEST/_index.tsv"
ERRORS="$DEST/_download_errors.txt"

# ---------------------------------------------------------------------------
# 3. Download
#
#    -f "b[format_id!=download]"  the format literally named `download` IS the
#                                 watermarked one. Excluding it yields the clean
#                                 1080x1920 H.265 source. DO NOT CHANGE.
#    -S "res,br"                  prefer highest resolution, then bitrate.
#    %(title).72B                 yt-dlp truncates title to 72 chars anyway;
#                                 .72B makes the truncation UTF-8 safe.
#    [%(id)s]                     the publisher locates files by this ID.
# ---------------------------------------------------------------------------
log "Starting download (1993 videos, ~23GB, expect 3-5 hours)"

set +e
"$YTDLP" \
  -f "b[format_id!=download]" \
  -S "res,br" \
  -o "$DEST/%(title).72B [%(id)s].%(ext)s" \
  --download-archive "$ARCHIVE" \
  --print-to-file "after_move:%(id)s\t%(filepath)s" "$INDEX" \
  --no-overwrites \
  --continue \
  --ignore-errors \
  --no-abort-on-error \
  --retries 10 \
  --fragment-retries 10 \
  --file-access-retries 5 \
  --sleep-requests 1 \
  --min-sleep-interval 1 \
  --max-sleep-interval 3 \
  --newline \
  "${FS_ARGS[@]+"${FS_ARGS[@]}"}" \
  "$CHANNEL" 2> >(tee -a "$ERRORS" >&2)
RC=$?
set -e

# ---------------------------------------------------------------------------
# 4. Report
# ---------------------------------------------------------------------------
COUNT=$(find "$DEST" -maxdepth 1 -type f \( -name '*.mp4' -o -name '*.webm' -o -name '*.mov' \) | wc -l | tr -d ' ')
log "Files on disk: $COUNT / 1993"
log "Bytes on disk: $(du -sh "$DEST" 2>/dev/null | cut -f1)"

if [ "$COUNT" -lt 1993 ]; then
  log "Incomplete. Re-run this script - it resumes from $ARCHIVE and costs nothing."
  log "Errors (if any) logged to: $ERRORS"
fi
if [ "$RC" -ne 0 ]; then
  log "yt-dlp exited $RC (individual video failures are non-fatal; re-run to retry them)"
fi

log "Done. Next: set VIDEO_DIR in fb_publish_daily.py to:"
log "  $DEST"
