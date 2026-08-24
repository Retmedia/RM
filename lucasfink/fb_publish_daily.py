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
