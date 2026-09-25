#!/usr/bin/env python3
"""Publish Blair Conklin Facebook Page videos as Facebook Stories.

Recipe: blair-fb-stories-20.md. This file is not live until that recipe is
Created in Cursor Mine.

The Page token and numeric Page ID stay outside this repo.
Docs checked 2026-09-25:
https://developers.facebook.com/docs/page-stories-api/ (updated 2026-07-30, v26.0)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import Callable, Iterable, Mapping
from zoneinfo import ZoneInfo

GRAPH_VERSION = "v26.0"
GRAPH_HOST = "https://graph.facebook.com"
UPLOAD_HOST = "rupload.facebook.com"
TZ = ZoneInfo("America/Los_Angeles")
START = datetime(2026, 1, 1, tzinfo=TZ)
DAILY_CAP = 20
MIN_VIEWS = 10_000
MIN_SECONDS = 3.0
MAX_SECONDS = 60.0
MIN_WIDTH = 540
MIN_HEIGHT = 960
WINDOW_DAYS = 183
FEED_PAGE_LIMIT = 100
MAX_FEED_PAGES = 20
MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024
FAILURE_EMAIL = "info@retmediaagency.com"
PAGE_URL = "https://www.facebook.com/BlairConklin/"

# Graph error codes from the Handle Errors guide.
TOKEN_CODES = {102, 190, 458, 459, 460, 463, 464}
RATE_CODES = {4, 17, 341}
PERMISSION_CODES = set(range(200, 300)) | {10}
POLICY_CODES = {368}
DOWNTIME_CODES = {1, 2}
DUPLICATE_CODES = {506}

FEED_FIELDS = (
    "created_time,is_published,status_type,"
    "attachments{media_type,type,url,unshimmed_url,target{id,url,unshimmed_url},"
    "subattachments{media_type,type,url,unshimmed_url,target{id,url,unshimmed_url}}}"
)
VIDEO_FIELDS = "source,format,created_time"

REPO_ROOT = Path(__file__).resolve().parents[1]


class ConfigError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class StopRun(Exception):
    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


@dataclass
class HttpResult:
    status: int
    body: bytes


class HttpClient:
    def send(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
        max_bytes: int | None = None,
    ) -> HttpResult:
        raise NotImplementedError


class UrllibHttp(HttpClient):
    def __init__(self, timeout: float = 120.0) -> None:
        self.timeout = timeout

    def send(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
        max_bytes: int | None = None,
    ) -> HttpResult:
        request = urllib.request.Request(
            url,
            data=body,
            headers=dict(headers or {}),
            method=method,
        )
        opener = urllib.request.build_opener(_NoRedirect())
        try:
            with opener.open(request, timeout=self.timeout) as response:
                payload = _read_capped(response, max_bytes)
                return HttpResult(response.status, payload)
        except urllib.error.HTTPError as exc:
            raw = exc.read() if exc.fp is not None else b""
            if max_bytes is not None and len(raw) > max_bytes:
                raw = raw[: max_bytes + 1]
            return HttpResult(exc.code, raw)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _read_capped(response, max_bytes: int | None) -> bytes:  # noqa: ANN001
    if max_bytes is None:
        return response.read()
    chunks: list[bytes] = []
    total = 0
    while True:
        block = response.read(1024 * 256)
        if not block:
            break
        total += len(block)
        chunks.append(block)
        if total > max_bytes:
            break
    return b"".join(chunks)


@dataclass
class Candidate:
    post_id: str
    video_id: str
    created: datetime


@dataclass
class RunResult:
    posted: list[dict] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)
    stopped: str | None = None
    detail: str = ""
    dry_run: bool = False
    feed_truncated: bool = False


def redact(text: str, token: str) -> str:
    if not text:
        return ""
    cleaned = text
    if token:
        cleaned = cleaned.replace(token, "[redacted]")
    return cleaned


def inside_repo(path: Path, repo_root: Path) -> bool:
    try:
        path.resolve().relative_to(repo_root.resolve())
    except ValueError:
        return False
    return True


def parse_fb_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("+0000"):
        text = text[:-5] + "+00:00"
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=TZ)
    return parsed


def pt_date(moment: datetime):
    return moment.astimezone(TZ).date()


def whole_number(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    return int(value)


def time_windows(start: datetime, end: datetime) -> Iterable[tuple[datetime, datetime]]:
    if end <= start:
        return
    cursor = start
    step = timedelta(days=WINDOW_DAYS)
    while cursor < end:
        nxt = min(cursor + step, end)
        yield cursor, nxt
        if nxt >= end:
            break
        cursor = nxt - timedelta(seconds=1)


def _mvhd_seconds(payload: bytes) -> float | None:
    if not payload:
        return None
    version = payload[0]
    if version == 0:
        if len(payload) < 20:
            return None
        timescale = int.from_bytes(payload[12:16], "big")
        duration = int.from_bytes(payload[16:20], "big")
    elif version == 1:
        if len(payload) < 32:
            return None
        timescale = int.from_bytes(payload[20:24], "big")
        duration = int.from_bytes(payload[24:32], "big")
    else:
        return None
    if timescale <= 0:
        return None
    return duration / timescale


def parse_mp4_duration_seconds(data: bytes) -> float | None:
    """Read movie-header duration. Returns None when the file is not a readable MP4."""
    found: list[float] = []

    def walk(start: int, end: int, depth: int) -> None:
        if depth > 8 or found:
            return
        offset = start
        while offset + 8 <= end and not found:
            size = int.from_bytes(data[offset : offset + 4], "big")
            box_type = data[offset + 4 : offset + 8]
            header = 8
            if size == 1:
                if offset + 16 > end:
                    return
                size = int.from_bytes(data[offset + 8 : offset + 16], "big")
                header = 16
            elif size == 0:
                size = end - offset
            if size < header or offset + size > end:
                return
            payload_at = offset + header
            payload_end = offset + size
            if box_type == b"mvhd":
                seconds = _mvhd_seconds(data[payload_at:payload_end])
                if seconds is not None:
                    found.append(seconds)
                    return
            elif box_type not in {b"mdat", b"free", b"skip", b"wide"}:
                walk(payload_at, payload_end, depth + 1)
            offset += size

    if data:
        walk(0, len(data), 0)
    return found[0] if found else None


def duration_ok(seconds: float) -> bool:
    return MIN_SECONDS <= seconds <= MAX_SECONDS


def format_meets_story_spec(width: int, height: int) -> bool:
    if width < MIN_WIDTH or height < MIN_HEIGHT:
        return False
    return abs(width * 16 - height * 9) <= 16


def largest_format(formats: object) -> tuple[int, int] | None:
    if not isinstance(formats, list):
        return None
    best: tuple[int, int] | None = None
    best_pixels = -1
    for item in formats:
        if not isinstance(item, dict):
            continue
        width = whole_number(item.get("width"))
        height = whole_number(item.get("height"))
        if width is None or height is None or width <= 0 or height <= 0:
            continue
        pixels = width * height
        if pixels > best_pixels:
            best = (width, height)
            best_pixels = pixels
    return best


def lifetime_total_views(payload: object) -> int | None:
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if not isinstance(data, list):
        return None
    for item in data:
        if not isinstance(item, dict):
            continue
        if item.get("name") != "total_video_views":
            continue
        period = item.get("period")
        if period not in (None, "lifetime"):
            continue
        values = item.get("values")
        if not isinstance(values, list) or not values or not isinstance(values[0], dict):
            continue
        views = whole_number(values[0].get("value"))
        if views is not None:
            return views
    return None


def _edge_items(node: object) -> list[dict]:
    if isinstance(node, list):
        return [item for item in node if isinstance(item, dict)]
    if isinstance(node, dict):
        data = node.get("data")
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
    return []


def _url_excluded(url: object) -> bool:
    if not isinstance(url, str) or not url:
        return False
    path = urllib.parse.urlparse(url).path.lower()
    parts = {part for part in path.split("/") if part}
    return bool(parts & {"stories", "reel", "reels"})


def _attachment_excluded(attachment: dict) -> bool:
    urls = [attachment.get("url"), attachment.get("unshimmed_url")]
    target = attachment.get("target")
    if isinstance(target, dict):
        urls.extend([target.get("url"), target.get("unshimmed_url")])
    return any(_url_excluded(url) for url in urls)


def _is_video_attachment(attachment: dict) -> bool:
    kind = attachment.get("type")
    media = attachment.get("media_type")
    return kind in {"video", "video_autoplay"} or media == "video"


def _video_id_of(attachment: dict) -> str | None:
    target = attachment.get("target")
    if not isinstance(target, dict):
        return None
    video_id = target.get("id")
    if isinstance(video_id, str) and video_id.isdigit():
        return video_id
    if isinstance(video_id, int) and not isinstance(video_id, bool):
        return str(video_id)
    return None


def _walk_attachments(attachment: dict) -> Iterable[dict]:
    yield attachment
    for child in _edge_items(attachment.get("subattachments")):
        yield from _walk_attachments(child)


def candidates_from_post(post: object) -> list[Candidate]:
    if not isinstance(post, dict):
        return []
    if post.get("is_published") is not True:
        return []
    if post.get("status_type") != "added_video":
        return []
    created = parse_fb_datetime(post.get("created_time"))
    if created is None or created < START:
        return []
    post_id = post.get("id")
    if not isinstance(post_id, str) or not post_id:
        return []
    found: list[Candidate] = []
    for attachment in _edge_items(post.get("attachments")):
        for item in _walk_attachments(attachment):
            if not _is_video_attachment(item) or _attachment_excluded(item):
                continue
            video_id = _video_id_of(item)
            if video_id is None:
                continue
            found.append(Candidate(post_id=post_id, video_id=video_id, created=created))
    return found


def dedupe_oldest(items: Iterable[Candidate]) -> list[Candidate]:
    best: dict[str, Candidate] = {}
    for item in items:
        current = best.get(item.video_id)
        if current is None or item.created < current.created:
            best[item.video_id] = item
    return sorted(best.values(), key=lambda item: (item.created, item.video_id))


def default_ledger_path() -> Path:
    return Path.home() / ".config" / "retmedia" / "blair-fb-stories-ledger.json"


def load_config(env: Mapping[str, str], repo_root: Path) -> tuple[str, str, Path]:
    page_id = (env.get("BLAIR_FB_PAGE_ID") or "").strip()
    token = (env.get("BLAIR_FB_PAGE_TOKEN") or "").strip()
    token_file = (env.get("BLAIR_FB_PAGE_TOKEN_FILE") or "").strip()
    ledger_raw = (env.get("BLAIR_FB_STORIES_LEDGER") or "").strip()
    if not token and token_file:
        path = Path(token_file)
        if inside_repo(path, repo_root):
            raise ConfigError(
                "Blocked. The Page token file must sit outside the repo. Nothing was posted."
            )
        try:
            token = path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise ConfigError(
                "Blocked. The Page token file could not be read. Nothing was posted."
            ) from exc
    if not page_id or not page_id.isdigit() or not token:
        raise ConfigError(
            "Blocked until the Blair Facebook Page token and numeric Page ID are on the machine. "
            f"The public page is {PAGE_URL} Do not put the token or Page ID in git. Nothing was posted."
        )
    if any(char in token for char in "\r\n"):
        raise ConfigError("Blocked. The Page token is not usable. Nothing was posted.")
    ledger_path = Path(ledger_raw) if ledger_raw else default_ledger_path()
    if inside_repo(ledger_path, repo_root):
        raise ConfigError(
            "Blocked. The posted-video ledger must sit outside the repo. Nothing was posted."
        )
    return page_id, token, ledger_path


def load_ledger(path: Path) -> dict:
    if not path.exists():
        return {"posted": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StopRun("ledger", "The posted-video ledger could not be read. Nothing new was posted.") from exc
    if not isinstance(data, dict) or not isinstance(data.get("posted"), dict):
        raise StopRun("ledger", "The posted-video ledger is not in the expected shape. Nothing new was posted.")
    return data


def save_ledger(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def posted_today(ledger: dict, today) -> int:
    count = 0
    posted = ledger.get("posted") or {}
    for entry in posted.values():
        if not isinstance(entry, dict):
            continue
        moment = parse_fb_datetime(entry.get("posted_at"))
        if moment is not None and pt_date(moment) == today:
            count += 1
    return count


def _json_body(result: HttpResult) -> object | None:
    try:
        return json.loads(result.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _error_parts(payload: object) -> tuple[int | None, str]:
    if not isinstance(payload, dict):
        return None, ""
    error = payload.get("error")
    if not isinstance(error, dict):
        return None, ""
    code = error.get("code")
    if isinstance(code, bool) or not isinstance(code, int):
        code = None
    message = error.get("message")
    return code, message if isinstance(message, str) else ""


def classify_stop(status: int, payload: object) -> str | None:
    code, message = _error_parts(payload)
    lowered = message.lower()
    if "previously published" in lowered or "already been used" in lowered:
        return "already_published"
    if (
        status == 429
        or code in RATE_CODES
        or "rate limit" in lowered
        or "too many calls" in lowered
        or "request limit" in lowered
    ):
        return "rate_limit"
    if code in TOKEN_CODES or "access token" in lowered or ("session" in lowered and "invalid" in lowered):
        return "token"
    if code in PERMISSION_CODES or "permission" in lowered:
        return "permission"
    if code in POLICY_CODES:
        return "policy"
    if code in DOWNTIME_CODES:
        return "downtime"
    if code in DUPLICATE_CODES:
        return "duplicate"
    if status in {401, 403}:
        return "token"
    return None


def _stop_detail(kind: str, status: int, payload: object) -> str:
    code, message = _error_parts(payload)
    trace = ""
    if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
        fbtrace = payload["error"].get("fbtrace_id")
        if isinstance(fbtrace, str):
            trace = f" fbtrace_id={fbtrace}"
    return f"{kind} HTTP {status} code {code}: {message}{trace}".strip()


class Graph:
    def __init__(self, http: HttpClient, token: str) -> None:
        self.http = http
        self.token = token

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
        max_bytes: int | None = None,
    ) -> object | None:
        result = self.http.send(method, url, headers=headers, body=body, max_bytes=max_bytes)
        payload = _json_body(result)
        kind = classify_stop(result.status, payload)
        if kind:
            raise StopRun(kind, _stop_detail(kind, result.status, payload))
        if result.status >= 400 or (isinstance(payload, dict) and "error" in payload):
            code, message = _error_parts(payload)
            raise GraphCallError(result.status, code, message)
        return payload

    def get_json(self, path: str, params: dict) -> object | None:
        query = dict(params)
        query["access_token"] = self.token
        url = f"{GRAPH_HOST}/{GRAPH_VERSION}/{path.lstrip('/')}?{urllib.parse.urlencode(query)}"
        return self.request("GET", url)

    def post_form(self, path: str, form: dict) -> object | None:
        url = f"{GRAPH_HOST}/{GRAPH_VERSION}/{path.lstrip('/')}"
        body = urllib.parse.urlencode({**form, "access_token": self.token}).encode("utf-8")
        return self.request(
            "POST",
            url,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            body=body,
        )


class GraphCallError(Exception):
    def __init__(self, status: int, code: int | None, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _safe_next(url: object, token: str) -> str | None:
    if not isinstance(url, str) or not url:
        return None
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.hostname != "graph.facebook.com":
        raise StopRun("paging", "Facebook returned a feed page on an unexpected host. Stopped.")
    query = [
        (key, value)
        for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        if key != "access_token"
    ]
    query.append(("access_token", token))
    return urllib.parse.urlunsplit(
        ("https", "graph.facebook.com", parts.path, urllib.parse.urlencode(query), "")
    )


def fetch_posts(graph: Graph, page_id: str, now: datetime) -> tuple[list[dict], bool]:
    posts: list[dict] = []
    truncated = False
    for since, until in time_windows(START, now):
        params = {
            "fields": FEED_FIELDS,
            "since": str(int(since.timestamp())),
            "until": str(int(until.timestamp())),
            "limit": str(FEED_PAGE_LIMIT),
        }
        payload = graph.get_json(f"{page_id}/feed", params)
        for _page in range(MAX_FEED_PAGES):
            if not isinstance(payload, dict):
                break
            data = payload.get("data")
            if isinstance(data, list):
                posts.extend(item for item in data if isinstance(item, dict))
            paging = payload.get("paging") if isinstance(payload.get("paging"), dict) else {}
            nxt = paging.get("next") if isinstance(paging, dict) else None
            if not nxt:
                break
            if _page == MAX_FEED_PAGES - 1:
                truncated = True
                break
            nxt_url = _safe_next(nxt, graph.token)
            if not nxt_url:
                break
            payload = graph.request("GET", nxt_url)
    return posts, truncated


def publish_story(graph: Graph, page_id: str, video_bytes: bytes) -> str:
    started = graph.post_form(f"{page_id}/video_stories", {"upload_phase": "start"})
    if not isinstance(started, dict):
        raise GraphCallError(200, None, "video_stories start returned no video id")
    upload_url = started.get("upload_url")
    story_video_id = started.get("video_id")
    if not isinstance(upload_url, str) or not isinstance(story_video_id, str):
        raise GraphCallError(200, None, "video_stories start did not return upload_url and video_id")
    parts = urllib.parse.urlsplit(upload_url)
    if parts.scheme != "https" or parts.hostname != UPLOAD_HOST:
        raise StopRun("upload_host", "video_stories upload_url was not on rupload.facebook.com. Stopped.")
    query = [
        (key, value)
        for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        if key != "access_token"
    ]
    query.append(("access_token", graph.token))
    target = urllib.parse.urlunsplit(
        ("https", parts.netloc, parts.path, urllib.parse.urlencode(query), "")
    )
    uploaded = graph.request(
        "POST",
        target,
        headers={
            "offset": "0",
            "file_size": str(len(video_bytes)),
            "Content-Type": "application/octet-stream",
        },
        body=video_bytes,
    )
    if not isinstance(uploaded, dict) or uploaded.get("success") is not True:
        raise GraphCallError(200, None, "video upload did not return success")
    finished = graph.post_form(
        f"{page_id}/video_stories",
        {"upload_phase": "finish", "video_id": story_video_id},
    )
    if not isinstance(finished, dict) or finished.get("success") is not True:
        raise GraphCallError(200, None, "video_stories finish did not return success")
    post_id = finished.get("post_id")
    if isinstance(post_id, int) and not isinstance(post_id, bool):
        return str(post_id)
    if isinstance(post_id, str) and post_id:
        return post_id
    raise GraphCallError(200, None, "video_stories finish did not return post_id")


def download_source(http: HttpClient, source: str) -> bytes:
    parts = urllib.parse.urlsplit(source)
    if parts.scheme != "https" or not parts.hostname:
        raise GraphCallError(0, None, "video source URL was not https")
    result = http.send("GET", source, max_bytes=MAX_DOWNLOAD_BYTES)
    if result.status == 429:
        raise StopRun("rate_limit", "Video source download returned HTTP 429. Stopped.")
    if result.status != 200:
        raise GraphCallError(result.status, None, "video source download failed")
    if len(result.body) > MAX_DOWNLOAD_BYTES:
        raise GraphCallError(result.status, None, "video source is over the local size guard")
    return result.body


def run_job(
    *,
    http: HttpClient,
    page_id: str,
    token: str,
    ledger_path: Path,
    now: datetime,
    dry_run: bool,
    notifier: Callable[[str, str], None],
) -> RunResult:
    result = RunResult(dry_run=dry_run)
    try:
        ledger = load_ledger(ledger_path)
        today = pt_date(now)
        remaining = DAILY_CAP - posted_today(ledger, today)
        if remaining <= 0:
            result.detail = "Daily cap of 20 is already met for this Pacific Time day."
            return result
        graph = Graph(http, token)
        try:
            posts, truncated = fetch_posts(graph, page_id, now)
        except GraphCallError as exc:
            raise StopRun(
                "graph",
                f"Feed read failed HTTP {exc.status} code {exc.code}: {exc.message}",
            ) from exc
        result.feed_truncated = truncated
        queue = dedupe_oldest(
            candidate
            for post in posts
            for candidate in candidates_from_post(post)
        )
        for candidate in queue:
            if len(result.posted) >= remaining:
                break
            posted = ledger.get("posted") or {}
            if candidate.video_id in posted:
                result.skipped.append({"video_id": candidate.video_id, "reason": "already_posted"})
                continue
            try:
                insights = graph.get_json(
                    f"{candidate.video_id}/video_insights",
                    {"metric": "total_video_views"},
                )
            except GraphCallError as exc:
                if "metric" in exc.message.lower():
                    raise StopRun(
                        "metric",
                        "video_insights rejected total_video_views. Stopped. Do not swap in another metric.",
                    ) from exc
                result.failures.append(
                    redact(
                        f"{candidate.video_id} insights HTTP {exc.status} code {exc.code}: {exc.message}",
                        token,
                    )
                )
                continue
            views = lifetime_total_views(insights)
            if views is None:
                result.skipped.append({"video_id": candidate.video_id, "reason": "views_unverified"})
                continue
            if views < MIN_VIEWS:
                result.skipped.append({"video_id": candidate.video_id, "reason": "views"})
                continue
            try:
                video = graph.get_json(candidate.video_id, {"fields": VIDEO_FIELDS})
            except GraphCallError as exc:
                result.failures.append(
                    redact(
                        f"{candidate.video_id} video HTTP {exc.status} code {exc.code}: {exc.message}",
                        token,
                    )
                )
                continue
            if not isinstance(video, dict):
                result.skipped.append({"video_id": candidate.video_id, "reason": "video_unverified"})
                continue
            dimensions = largest_format(video.get("format"))
            if dimensions is None or not format_meets_story_spec(*dimensions):
                result.skipped.append({"video_id": candidate.video_id, "reason": "spec"})
                continue
            source = video.get("source")
            if not isinstance(source, str) or not source.startswith("https://"):
                result.skipped.append({"video_id": candidate.video_id, "reason": "no_source"})
                continue
            try:
                video_bytes = download_source(http, source)
            except GraphCallError as exc:
                result.failures.append(
                    redact(f"{candidate.video_id} source download failed HTTP {exc.status}", token)
                )
                continue
            seconds = parse_mp4_duration_seconds(video_bytes)
            if seconds is None or not duration_ok(seconds):
                result.skipped.append({"video_id": candidate.video_id, "reason": "duration"})
                continue
            if dry_run:
                result.posted.append(
                    {
                        "video_id": candidate.video_id,
                        "source_post_id": candidate.post_id,
                        "dry_run": True,
                    }
                )
                continue
            try:
                story_post_id = publish_story(graph, page_id, video_bytes)
            except GraphCallError as exc:
                result.failures.append(
                    redact(
                        f"{candidate.video_id} story HTTP {exc.status} code {exc.code}: {exc.message}",
                        token,
                    )
                )
                continue
            entry = {
                "source_post_id": candidate.post_id,
                "story_post_id": story_post_id,
                "posted_at": now.astimezone(TZ).isoformat(timespec="seconds"),
            }
            result.posted.append({"video_id": candidate.video_id, **entry})
            ledger.setdefault("posted", {})[candidate.video_id] = entry
            try:
                save_ledger(ledger_path, ledger)
            except OSError as exc:
                raise StopRun(
                    "ledger",
                    "Story "
                    + story_post_id
                    + " was published for source video "
                    + candidate.video_id
                    + ", and the ledger could not be saved. Record that id before running again.",
                ) from exc
    except StopRun as exc:
        result.stopped = exc.kind
        result.detail = redact(exc.detail, token)
        notifier(
            "Blair Facebook Stories stopped",
            _email_body(result, token),
        )
        return result
    if result.failures or result.feed_truncated:
        notifier("Blair Facebook Stories needs a look", _email_body(result, token))
    return result


def _email_body(result: RunResult, token: str) -> str:
    lines = [
        "Blair Facebook Stories run.",
        f"Stopped: {result.stopped or 'no'}",
        result.detail,
        f"Posted this run: {len(result.posted)}",
        f"Skipped: {len(result.skipped)}",
        f"Failures: {len(result.failures)}",
        f"Feed walk truncated: {result.feed_truncated}",
    ]
    if result.failures:
        lines.append("Failure lines:")
        lines.extend(result.failures[:20])
    if result.posted:
        lines.append("Posted source video ids:")
        lines.extend(str(item.get("video_id")) for item in result.posted[:20])
    return redact("\n".join(line for line in lines if line), token)


def send_failure_email(subject: str, body: str) -> None:
    """Best-effort mail to Garrett. Mine still owns the failure email if this cannot send."""
    message = EmailMessage()
    message["To"] = FAILURE_EMAIL
    message["Subject"] = subject
    message.set_content(body)
    sendmail = "/usr/sbin/sendmail"
    if not os.access(sendmail, os.X_OK):
        print(body, file=sys.stderr)
        return
    import subprocess

    subprocess.run(
        [sendmail, "-t", "-oi"],
        input=message.as_bytes(),
        check=False,
        timeout=30,
    )


def execute(
    argv: list[str],
    env: Mapping[str, str],
    http: HttpClient,
    notifier: Callable[[str, str], None],
    now: datetime,
    repo_root: Path,
) -> int:
    parser = argparse.ArgumentParser(prog="blair_fb_stories.py")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        page_id, token, ledger_path = load_config(env, repo_root)
    except ConfigError as exc:
        notifier("Blair Facebook Stories blocked", exc.message)
        print(exc.message, file=sys.stderr)
        return 2
    result = run_job(
        http=http,
        page_id=page_id,
        token=token,
        ledger_path=ledger_path,
        now=now,
        dry_run=args.dry_run,
        notifier=notifier,
    )
    summary = (
        f"posted={len(result.posted)} skipped={len(result.skipped)} "
        f"failures={len(result.failures)} stopped={result.stopped or 'no'} "
        f"dry_run={result.dry_run}"
    )
    print(redact(summary, token))
    if result.detail:
        print(redact(result.detail, token), file=sys.stderr)
    if result.stopped or result.failures:
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    return execute(
        list(sys.argv[1:] if argv is None else argv),
        os.environ,
        UrllibHttp(),
        send_failure_email,
        datetime.now(TZ),
        REPO_ROOT,
    )


if __name__ == "__main__":
    sys.exit(main())
