# Handoff brief: Lucas Fink TikTok archive to Facebook Reels

Paste this whole file to the agent doing the work. It assumes no prior context.
The code in the appendix is complete and tested — install it, do not rewrite it.

---

## The goal

Lucas Fink (@lucasfinkrj, pro skimboarder, Red Bull athlete) hired RET Media to:

1. **Archive his TikTok.** Download every video he has ever posted — 1993 of them,
   roughly 23GB — in max quality with no watermark, onto the RM external drive,
   each file named after the video's TikTok caption.
2. **Republish the whole catalog to his Facebook Page as Reels.** 25 per day,
   oldest video first, the TikTok caption as the Facebook description, with the
   Portuguese ones translated to English.
3. **Run unattended for ~80 days.** Garrett should not touch it daily.

Total cost is **$0**. yt-dlp is open source, the Meta Graph API has no usage
charges, launchd ships with macOS, the drive already exists.

## Where the work happens

Everything runs on Garrett's MacBook Pro, with the videos on an external drive
that mounts at `/Volumes/RM`. Not in the cloud — the videos are 23GB and whichever
machine holds them has to be the one uploading them.

Working folder on the Mac: `~/lucasfink`

## Accounts and links

| What | Where |
|---|---|
| Lucas on TikTok | https://www.tiktok.com/@lucasfinkrj |
| His TikTok channel ID (use this, not the handle) | `MS4wLjABAAAApBOPJCvWGgP2UMYgszzlkklApxB_hSGhpPO5fISqc0ICaxbkDZCLRm5aFsVCCuzA` |
| His Facebook Page ID | `946028488753049` |
| The Page | https://www.facebook.com/946028488753049 |
| Meta Business Suite | https://business.facebook.com/latest/home |
| Business Settings, for the permanent token | https://business.facebook.com/settings/system-users |
| Meta developer apps | https://developers.facebook.com/apps/ |
| Graph API Explorer | https://developers.facebook.com/tools/explorer/ |
| Access Token Debugger | https://developers.facebook.com/tools/debug/accesstoken/ |
| Reels publishing docs | https://developers.facebook.com/docs/video-api/guides/reels-publishing |

Those Meta URLs are the standard entry points but were not reachable to verify
from the machine this brief was written on. If one has moved, navigate from
business.facebook.com or developers.facebook.com rather than guessing.

## Facts already established — do not re-derive these, they cost hours

**TikTok**

- Enumerating the profile by handle **fails**. The channel-ID form works:
  `tiktokuser:MS4wLjABAAAApBOPJCvWGgP2UMYgszzlkklApxB_hSGhpPO5fISqc0ICaxbkDZCLRm5aFsVCCuzA`
- 1993 videos, 2020-03-25 through 2026-08-23, roughly 23GB.
- The format selector `-f "b[format_id!=download]" -S "res,br"` yields 1080x1920
  H.265 with no watermark. The format literally named `download` **is** the
  watermarked one, which is why it is excluded. Do not change this selector.
- Install `yt-dlp[default,curl-cffi]`. Without curl-cffi's TLS impersonation
  TikTok intermittently refuses requests.
- yt-dlp truncates `%(title)s` to 72 characters. Filenames use the truncated
  title plus the video ID in brackets; the publisher finds files by that ID.
  Full captions come from the CSV, never from filenames.

**Facebook**

- Reels publishing is three calls: `POST /{page_id}/video_reels` with
  `upload_phase=start` → binary upload to the returned `rupload.facebook.com` URL
  with `Authorization: OAuth <token>`, `offset: 0` and `file_size` headers →
  `POST /{page_id}/video_reels` with `upload_phase=finish`,
  `video_state=PUBLISHED` and `description`.
- **Meta caps Reels at 30 published posts per rolling 24 hours.** 25/day is
  deliberately under it, leaving headroom for retries. Do not raise it.
- **Reels max out at 90 seconds.** 33 of the 1993 videos are longer (longest is
  5m43s). The publisher routes those to the regular `/videos` endpoint instead.
- Scheduling was deliberately not used. Meta lists a `SCHEDULED` video state but
  documents no parameter for the timestamp. The daily launchd job is the scheduler.

**Captions**

- 735 translated from Portuguese, 1258 already-English passed through byte for
  byte. Hashtags and @mentions preserved exactly. 4 videos have no caption on
  TikTok and will post with an empty description.

## The one step a human must do

**Get the Meta Page access token.** Facebook will not issue one without Garrett
logged in. It cannot be automated. Walk him through it screen by screen:

1. https://developers.facebook.com/apps/ → Create App → type **Business**
2. Tools → Graph API Explorer
3. Pick the app → **Get Token** → **Get Page Access Token** → the Lucas Fink page
4. Add permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`
5. Paste into the Access Token Debugger → **Extend Access Token**
6. Save it: `echo 'THE_TOKEN' > ~/.fb_lucas_token && chmod 600 ~/.fb_lucas_token`

**Push him toward the permanent version instead.** That token expires in ~60 days
and this run is 80 days, so it dies around day 60 and the job stops. At
https://business.facebook.com/settings/system-users → Add → assign the Page →
Generate Token with those same three permissions, the token never expires. Three
extra minutes. If he refuses, set a calendar reminder for day 55 — the publisher
also warns in its log from 14 days out.

## Steps, in order

**1. Confirm the drive.** `ls /Volumes` — expect `RM`. Everything below assumes
`/Volumes/RM/Lucas Fink`; substitute the real name if it differs.

**2. Download.** Save the appendix files into `~/lucasfink`, then:

```
cd ~/lucasfink
chmod +x *.sh
DEST="/Volumes/RM/Lucas Fink" ./download_lucasfink_tiktok.sh
```

3–5 hours. It self-installs yt-dlp into `~/.tiktok-dl-venv`, checks the drive is
mounted and has 25GB free, detects the filesystem (on exFAT/FAT/NTFS it adds
`--windows-filenames`, since those reject `? " : * < > |` and TikTok captions are
full of them), and resumes if interrupted. Re-running costs nothing.

**3. Token.** See above.

**4. Install the daily job.**

```
cd ~/lucasfink
./install_fb_daily.sh "/Volumes/RM/Lucas Fink"
```

It validates the folder, patches `VIDEO_DIR`, copies the publisher and queue into
`~`, dry-runs, and only then installs the launchd job for 9:15am daily.

**5. Post three real ones and look at the Page.**

```
~/.tiktok-dl-venv/bin/python ~/fb_publish_daily.py --limit 3
```

Confirm on the Page that all three are actual Reels with the right caption. This
is the first time real bytes touch Facebook — everything before it was tested
against a mock. If those three are right, the other 1990 will be too.

**6. Close the two failure modes that matter.**

- `sudo pmset -a sleep 0`. launchd **skips** a missed run rather than queuing it,
  so every night the Mac sleeps through 9:15 adds a day to the 80.
- Keep the RM drive plugged in. An unmounted drive is a skipped day; the log says
  which drive is missing, and re-running catches that day up.

**7. Report to Garrett:** videos downloaded vs 1993, anything that failed and why,
and confirmation that the three test posts look right.

## The queue CSV

`lucas_caption_queue.csv` is data, not code, so it is not in this brief. It is
already on the Mac at `~/lucasfink/lucas_caption_queue.csv` (450KB, 1993 rows plus
a header, UTF-8 with BOM). The installer copies it to `~/lucas_caption_queue.csv`.

Columns: `queue_position` (1-1993, oldest first), `video_id`, `upload_date`,
`final_caption` (what gets posted), `original_caption`, `was_translated`, `views`,
`duration_s`, `sort_ts`.

If it is ever lost it must be regenerated from TikTok metadata and re-translated —
that is hours of work, so back it up before touching anything.

## Do not

- **Do not use SnapTik or any browser downloader.** 1993 videos one at a time with
  server-side re-encoding. Already evaluated and rejected.
- **Do not use browser automation for the Facebook uploads.** Chrome's file upload
  path rejects files over 10MB and these average 12MB. The Graph API is three
  calls per video at any size.
- **Do not raise 25/day.** Meta's cap is 30.
- **Do not add scheduling.** See above.
- **Do not add a second state layer.** `_fb_posted.csv` in the video folder is
  appended after every single post, so re-running never double-posts. It is the
  source of truth. Deleting it starts the whole run over from video 1.

## How it behaves when things go wrong

| Situation | What happens |
|---|---|
| Meta rate-limits mid-run | Stops cleanly. Tomorrow resumes at exactly the next video. |
| Token expires or is revoked | Stops immediately and says so. Nothing is lost. |
| A video file is missing | Logged, skipped, the day still posts its full 25. |
| One video fails 3 times | Set aside so it cannot block the other 1992. |
| Mac dies mid-post | State is appended after each post, so nothing double-posts. |
| RM drive unplugged at 9:15 | Names the missing drive, skips the day. Re-run to catch up. |
| Two runs overlap | An flock makes the second exit without posting. |
| Queue runs out | Says so and tells you to remove the launchd job. |

## Done means

1993 videos on the RM drive, a launchd job posting 25/day at 9:15am, three
manually verified Reels live on the Page, `--status` reporting the right
remaining count, and the Mac not sleeping.

## The one risk no script can remove

Meta's originality and monetization rules for a back catalog republished from
TikTok have changed repeatedly and could not be verified. The watermark is gone,
which is the usual disqualifier, but if any part of this is a monetization play,
Lucas should confirm with his Meta partner contact before day 30.

---

# Appendix: the code

Three files, all tested. Save each into `~/lucasfink` with the filename shown.
They are already on Garrett's Mac in that folder — this appendix is here so the
work can be reconstructed from this brief alone.

## `download_lucasfink_tiktok.sh`

```bash
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
```

## `fb_publish_daily.py`

```python
#!/usr/bin/env python3
"""
Publish Lucas Fink's TikTok archive to his Facebook Page, 25 per day, oldest first.

Reads the queue CSV, finds each video on disk, publishes it via the Meta Graph
API, and records the success. Crash-safe: state is appended after every single
post, so re-running never double-posts.

Stdlib only - no pip install required.

  python3 fb_publish_daily.py --status        # where are we
  python3 fb_publish_daily.py --dry-run       # verify without posting
  python3 fb_publish_daily.py --limit 3       # post 3 real ones
  python3 fb_publish_daily.py                 # post today's 25
"""

import argparse
import csv
import fcntl
import json
import mimetypes
import os
import random
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# CONFIG - set VIDEO_DIR to the "Lucas Fink" folder inside RM Drive.
# Every value here can also be overridden by the matching FB_* env var.
# ---------------------------------------------------------------------------
VIDEO_DIR = ""  # <-- SET THIS
PAGE_ID = "946028488753049"
QUEUE_CSV = "~/lucas_caption_queue.csv"
TOKEN_FILE = "~/.fb_lucas_token"
LOG_FILE = "~/fb_publish.log"

DAILY_LIMIT = 25          # Meta caps Reels at 30 per rolling 24h. Do not raise.
SPACING_SECONDS = 90      # gap between posts
REELS_MAX_SECONDS = 90    # longer videos route to /videos instead of /video_reels
MAX_ATTEMPTS = 3          # per-video failures before it is set aside
GRAPH_VERSION = "v21.0"

GRAPH = f"https://graph.facebook.com/{GRAPH_VERSION}"
GRAPH_VIDEO = f"https://graph-video.facebook.com/{GRAPH_VERSION}"

VIDEO_EXTS = (".mp4", ".mov", ".webm", ".mkv")

# Graph error codes that mean "you are throttled, stop for today".
RATE_LIMIT_CODES = {4, 17, 32, 341, 613}
RATE_LIMIT_SUBCODES = {2207051}


# ---------------------------------------------------------------------------
# plumbing
# ---------------------------------------------------------------------------

_log_fh = None


def log(msg):
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    if _log_fh:
        _log_fh.write(line + "\n")
        _log_fh.flush()


class GraphError(Exception):
    def __init__(self, message, code=None, subcode=None, http_status=None, body=None):
        super().__init__(message)
        self.code = code
        self.subcode = subcode
        self.http_status = http_status
        self.body = body

    @property
    def is_rate_limit(self):
        return self.code in RATE_LIMIT_CODES or self.subcode in RATE_LIMIT_SUBCODES

    @property
    def is_auth_failure(self):
        return self.code in (102, 190) or self.http_status == 401


def _parse_graph_error(status, raw):
    try:
        payload = json.loads(raw)
        err = payload.get("error", {})
        return GraphError(
            err.get("message", raw[:400]),
            code=err.get("code"),
            subcode=err.get("error_subcode"),
            http_status=status,
            body=raw[:2000],
        )
    except (ValueError, AttributeError):
        return GraphError(f"HTTP {status}: {raw[:400]}", http_status=status, body=raw[:2000])


def _request(req, timeout=600):
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        raise _parse_graph_error(e.code, raw) from None
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        return {"_raw": raw}


def graph_post(url, params, timeout=120):
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    return _request(req, timeout=timeout)


def graph_get(url, params, timeout=60):
    req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}", method="GET")
    return _request(req, timeout=timeout)


def with_retries(fn, what, attempts=3):
    """Retry transient network/5xx failures. Rate limits and auth errors do not retry."""
    last = None
    for i in range(attempts):
        try:
            return fn()
        except GraphError as e:
            if e.is_rate_limit or e.is_auth_failure:
                raise
            last = e
            if e.http_status and e.http_status < 500 and e.code not in (1, 2):
                raise  # a real 4xx: retrying will not help
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = GraphError(f"network error: {e}")
        if i < attempts - 1:
            backoff = (2 ** i) * 5 + random.uniform(0, 3)
            log(f"    {what} failed ({last}); retrying in {backoff:.0f}s")
            time.sleep(backoff)
    raise last


# ---------------------------------------------------------------------------
# token
# ---------------------------------------------------------------------------

def load_token(path):
    p = Path(path).expanduser()
    if not p.exists():
        raise SystemExit(
            f"ERROR: no token file at {p}\n"
            "Create it: paste the extended Page access token into that file, one line, then\n"
            f"  chmod 600 {p}"
        )
    token = p.read_text(encoding="utf-8").strip()
    if not token:
        raise SystemExit(f"ERROR: {p} is empty")
    if token.startswith(("http", "{")) or " " in token:
        raise SystemExit(f"ERROR: {p} does not look like a bare access token")
    mode = p.stat().st_mode & 0o777
    if mode & 0o077:
        log(f"WARNING: {p} is mode {oct(mode)} - run: chmod 600 {p}")
    return token


def check_token(token):
    """Log token health. Returns days remaining, or None if it never expires."""
    try:
        data = graph_get(f"{GRAPH}/debug_token", {"input_token": token, "access_token": token})
    except GraphError as e:
        log(f"WARNING: could not inspect token: {e}")
        return None
    d = data.get("data", {})
    if not d.get("is_valid", True):
        raise SystemExit(f"ERROR: token is not valid: {d.get('error', {}).get('message', 'unknown')}")

    scopes = set(d.get("scopes", []))
    needed = {"pages_show_list", "pages_read_engagement", "pages_manage_posts"}
    missing = needed - scopes
    if missing:
        log(f"WARNING: token is missing permissions: {', '.join(sorted(missing))}")

    expires_at = d.get("expires_at", 0)
    if not expires_at:
        log("Token: never expires (System User token). Good.")
        return None
    days = (expires_at - time.time()) / 86400
    when = datetime.fromtimestamp(expires_at, timezone.utc).strftime("%Y-%m-%d")
    if days <= 0:
        raise SystemExit(f"ERROR: token expired on {when}. Regenerate it.")
    msg = f"Token: expires {when} ({days:.0f} days left)"
    if days <= 14:
        msg = ("*** " + msg + " - REGENERATE SOON or the daily job stops silently. "
               "Permanent fix: Business Settings > System Users > Generate Token ***")
    log(msg)
    return days


# ---------------------------------------------------------------------------
# single-run lock
# ---------------------------------------------------------------------------

def acquire_lock(path):
    """Stop a manual run and the launchd run from posting the same video twice."""
    fh = path.open("w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return None
    fh.write(f"{os.getpid()}\n")
    fh.flush()
    return fh


def release_lock(fh):
    if fh is None:
        return
    try:
        fcntl.flock(fh, fcntl.LOCK_UN)
    except OSError:
        pass
    fh.close()


# ---------------------------------------------------------------------------
# queue + state
# ---------------------------------------------------------------------------

def read_queue(path):
    p = Path(path).expanduser()
    if not p.exists():
        raise SystemExit(f"ERROR: queue CSV not found at {p}")
    with p.open(encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        raise SystemExit(f"ERROR: queue CSV at {p} is empty")
    required = {"queue_position", "video_id", "final_caption", "duration_s"}
    missing = required - set(rows[0].keys())
    if missing:
        raise SystemExit(f"ERROR: queue CSV missing columns: {', '.join(sorted(missing))}")
    rows.sort(key=lambda r: int(r["queue_position"]))
    return rows


STATE_HEADER = ["video_id", "queue_position", "fb_id", "posted_at_utc", "endpoint"]
SKIP_HEADER = ["video_id", "queue_position", "attempts", "last_error", "recorded_at_utc"]


def _read_csv_map(path, key="video_id"):
    p = Path(path)
    if not p.exists():
        return {}
    with p.open(encoding="utf-8", newline="") as fh:
        return {r[key]: r for r in csv.DictReader(fh) if r.get(key)}


def _append_csv(path, header, row):
    p = Path(path)
    exists = p.exists() and p.stat().st_size > 0
    with p.open("a", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=header)
        if not exists:
            w.writeheader()
        w.writerow(row)


def _bump_attempt(path, video_id, queue_position, error):
    """Track consecutive failures so one bad video cannot block the queue forever."""
    rows = _read_csv_map(path)
    prev = int(rows.get(video_id, {}).get("attempts", 0))
    rows[video_id] = {
        "video_id": video_id,
        "queue_position": queue_position,
        "attempts": str(prev + 1),
        "last_error": str(error)[:300].replace("\n", " "),
        "recorded_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    p = Path(path)
    with p.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=SKIP_HEADER)
        w.writeheader()
        for r in rows.values():
            w.writerow({k: r.get(k, "") for k in SKIP_HEADER})
    return prev + 1


# ---------------------------------------------------------------------------
# locating files
# ---------------------------------------------------------------------------

def build_file_index(video_dir):
    """Map TikTok video ID -> path. Filenames carry '[<id>]' from the downloader."""
    index = {}
    tsv = video_dir / "_index.tsv"
    if tsv.exists():
        for line in tsv.read_text(encoding="utf-8", errors="replace").splitlines():
            if "\t" not in line:
                continue
            vid, path = line.split("\t", 1)
            f = Path(path.strip())
            if f.exists():
                index[vid.strip()] = f
    for f in video_dir.iterdir():
        if not f.is_file() or f.suffix.lower() not in VIDEO_EXTS:
            continue
        name = f.name
        if "[" in name and "]" in name:
            vid = name[name.rfind("[") + 1:name.rfind("]")]
            if vid.isdigit():
                index.setdefault(vid, f)
    return index


# ---------------------------------------------------------------------------
# publishing
# ---------------------------------------------------------------------------

def upload_bytes(upload_url, token, path):
    """Push the binary to rupload. Meta documents POST; some edges want PUT."""
    size = path.stat().st_size
    payload = path.read_bytes()

    def attempt(method):
        req = urllib.request.Request(upload_url, data=payload, method=method)
        req.add_header("Authorization", f"OAuth {token}")
        req.add_header("offset", "0")
        req.add_header("file_size", str(size))
        req.add_header("Content-Type", "application/octet-stream")
        return _request(req, timeout=900)

    try:
        return attempt("POST")
    except GraphError as e:
        if e.http_status == 405:
            return attempt("PUT")
        raise


def publish_reel(page_id, token, path, caption):
    start = graph_post(f"{GRAPH}/{page_id}/video_reels",
                       {"upload_phase": "start", "access_token": token})
    video_id = start.get("video_id")
    upload_url = start.get("upload_url")
    if not video_id or not upload_url:
        raise GraphError(f"start phase returned no upload target: {start}")

    with_retries(lambda: upload_bytes(upload_url, token, path), "upload")

    finish = graph_post(f"{GRAPH}/{page_id}/video_reels", {
        "access_token": token,
        "video_id": video_id,
        "upload_phase": "finish",
        "video_state": "PUBLISHED",
        "description": caption,
    }, timeout=300)
    if not finish.get("success", True):
        raise GraphError(f"finish phase rejected: {finish}")
    return video_id


def _multipart(fields, file_field, path):
    boundary = "----fbpublish" + os.urandom(12).hex()
    ctype = mimetypes.guess_type(path.name)[0] or "video/mp4"
    body = bytearray()
    for k, v in fields.items():
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode()
        body += str(v).encode("utf-8") + b"\r\n"
    body += f"--{boundary}\r\n".encode()
    body += (f'Content-Disposition: form-data; name="{file_field}"; '
             f'filename="{path.name}"\r\n').encode("utf-8")
    body += f"Content-Type: {ctype}\r\n\r\n".encode()
    body += path.read_bytes() + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def publish_video(page_id, token, path, caption):
    """For clips over 90s, which Reels rejects."""
    body, ctype = _multipart(
        {"access_token": token, "description": caption, "published": "true"},
        "source", path)
    req = urllib.request.Request(f"{GRAPH_VIDEO}/{page_id}/videos", data=body, method="POST")
    req.add_header("Content-Type", ctype)
    resp = _request(req, timeout=1800)
    vid = resp.get("id")
    if not vid:
        raise GraphError(f"/videos returned no id: {resp}")
    return vid


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def resolve(cli, env, default):
    return cli or os.environ.get(env) or default


def main():
    global _log_fh

    ap = argparse.ArgumentParser(description="Publish Lucas Fink's TikTok archive to Facebook.")
    ap.add_argument("--limit", type=int, help=f"how many to post (default {DAILY_LIMIT})")
    ap.add_argument("--dry-run", action="store_true", help="verify everything, post nothing")
    ap.add_argument("--status", action="store_true", help="print progress and exit")
    ap.add_argument("--video-dir", help="folder holding the downloaded videos")
    ap.add_argument("--queue", help="path to lucas_caption_queue.csv")
    ap.add_argument("--token-file", help="file containing the Page access token")
    ap.add_argument("--page-id", help="Facebook Page ID")
    ap.add_argument("--no-spacing", action="store_true", help="do not sleep between posts")
    args = ap.parse_args()

    video_dir_s = resolve(args.video_dir, "FB_VIDEO_DIR", VIDEO_DIR)
    queue_path = resolve(args.queue, "FB_QUEUE_CSV", QUEUE_CSV)
    token_path = resolve(args.token_file, "FB_TOKEN_FILE", TOKEN_FILE)
    page_id = resolve(args.page_id, "FB_PAGE_ID", PAGE_ID)
    daily = int(os.environ.get("FB_DAILY_LIMIT", DAILY_LIMIT))
    limit = args.limit or daily

    if not video_dir_s:
        raise SystemExit(
            "ERROR: VIDEO_DIR is not set.\n"
            "Edit the VIDEO_DIR line near the top of this file, or pass --video-dir.")
    video_dir = Path(video_dir_s).expanduser()
    if not video_dir.is_dir():
        parts = video_dir.parts
        if len(parts) > 2 and parts[1] == "Volumes" and not Path("/Volumes", parts[2]).is_dir():
            raise SystemExit(
                f"ERROR: the {parts[2]} drive is not mounted, so today's batch was skipped.\n"
                f"Plug it in, then run this again to catch up:  {sys.argv[0]}")
        raise SystemExit(f"ERROR: video folder does not exist: {video_dir}")

    log_path = Path(os.environ.get("FB_LOG_FILE", LOG_FILE)).expanduser()
    try:
        _log_fh = log_path.open("a", encoding="utf-8")
    except OSError:
        _log_fh = None

    lock_fh = None
    if not args.status:
        lock_fh = acquire_lock(video_dir / "_fb_publish.lock")
        if lock_fh is None:
            log("Another run is already in progress. Exiting so nothing is posted twice.")
            return 0

    try:
        queue = read_queue(queue_path)
        posted = _read_csv_map(video_dir / "_fb_posted.csv")
        skipped = _read_csv_map(video_dir / "_fb_skipped.csv")
        index = build_file_index(video_dir)

        done = set(posted)
        set_aside = {k for k, v in skipped.items() if int(v.get("attempts", 0)) >= MAX_ATTEMPTS}
        pending = [r for r in queue if r["video_id"] not in done and r["video_id"] not in set_aside]

        if args.status:
            on_disk = sum(1 for r in queue if r["video_id"] in index)
            log(f"Queue:      {len(queue)}")
            log(f"On disk:    {on_disk}")
            log(f"Published:  {len(done)}")
            log(f"Set aside:  {len(set_aside)}")
            log(f"Remaining:  {len(pending)}  (~{-(-len(pending) // max(daily, 1))} days at {daily}/day)")
            if pending:
                log(f"Next up:    #{pending[0]['queue_position']} {pending[0]['video_id']}")
            return 0

        log("=" * 70)
        log(f"Run start | published {len(done)}/{len(queue)} | {len(pending)} remaining"
            + (" | DRY RUN" if args.dry_run else ""))
        log(f"Videos: {video_dir}")

        if not pending:
            log("Queue is empty. Everything has been published. You can remove the launchd job.")
            return 0

        token = None
        if not args.dry_run:
            token = load_token(token_path)
            check_token(token)

        published = attempted = 0
        for row in pending:
            if published >= limit:
                break
            vid = row["video_id"]
            pos = row["queue_position"]
            caption = row["final_caption"]
            try:
                duration = int(float(row["duration_s"] or 0))
            except ValueError:
                duration = 0

            path = index.get(vid)
            if path is None or not path.exists():
                log(f"  #{pos} {vid}: MISSING on disk - skipping (re-run the downloader)")
                _bump_attempt(video_dir / "_fb_skipped.csv", vid, pos, "file not found on disk")
                continue

            as_reel = duration <= REELS_MAX_SECONDS
            kind = "reel" if as_reel else "video"
            size_mb = path.stat().st_size / 1e6
            preview = caption.replace("\n", " ")[:60] or "(no caption)"
            log(f"  #{pos} {vid} [{kind} {duration}s {size_mb:.1f}MB] {preview}")

            if args.dry_run:
                published += 1
                continue

            attempted += 1
            try:
                if as_reel:
                    fb_id = with_retries(
                        lambda: publish_reel(page_id, token, path, caption), "publish", attempts=2)
                else:
                    fb_id = with_retries(
                        lambda: publish_video(page_id, token, path, caption), "publish", attempts=2)
            except GraphError as e:
                if e.is_rate_limit:
                    log(f"    RATE LIMITED by Meta: {e}")
                    log("    Stopping cleanly. Tomorrow's run picks up exactly here.")
                    break
                if e.is_auth_failure:
                    log(f"    TOKEN REJECTED: {e}")
                    log("    Regenerate the Page token and rerun. Nothing was lost.")
                    break
                n = _bump_attempt(video_dir / "_fb_skipped.csv", vid, pos, e)
                log(f"    FAILED (attempt {n}/{MAX_ATTEMPTS}): {e}")
                if n >= MAX_ATTEMPTS:
                    log("    Set aside - it will no longer hold up the queue.")
                continue
            except Exception as e:  # never let one video kill the whole day
                n = _bump_attempt(video_dir / "_fb_skipped.csv", vid, pos, e)
                log(f"    FAILED (attempt {n}/{MAX_ATTEMPTS}): {e}")
                continue

            _append_csv(video_dir / "_fb_posted.csv", STATE_HEADER, {
                "video_id": vid,
                "queue_position": pos,
                "fb_id": fb_id,
                "posted_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "endpoint": "video_reels" if as_reel else "videos",
            })
            published += 1
            log(f"    OK -> fb id {fb_id}  ({published}/{limit} today)")

            if published < limit and not args.no_spacing:
                time.sleep(SPACING_SECONDS)

        remaining = len(pending) - published
        log(f"Run end | posted {published} | {remaining} still queued"
            f" (~{-(-remaining // max(limit, 1))} days left)")
        if args.dry_run:
            log("DRY RUN - nothing was published.")
        return 0
    finally:
        release_lock(lock_fh)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("Interrupted. Progress is saved; the next run resumes where this stopped.")
        sys.exit(130)
```

## `install_fb_daily.sh`

```bash
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
```
