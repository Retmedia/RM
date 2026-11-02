#!/usr/bin/env python3
"""Post new Skid Kids long-form videos to a Facebook page as square videos.

The public channel RSS feed is the source of new uploads. yt-dlp is the
fallback when that feed cannot be read, and it also supplies duration.

Facebook's video_reels publishing API only accepts 9:16 video between 3 and
90 seconds. These uploads are long-form and 1080x1080, so they go through the
Page Videos resumable upload (start, transfer, finish). Facebook treats page
videos as reels in the product sense: any length, square or wide.
"""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

CHANNEL_ID = "UCQ5kqUO7Pkc7YWRNnjetfbw"
CHANNEL_HANDLE = "@SkidKids"
CHANNEL_VIDEOS_URL = "https://www.youtube.com/@SkidKids/videos"
RSS_URL = f"https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL_ID}"
GRAPH_VERSION = os.environ.get("FB_GRAPH_VERSION", "v23.0")
LOOKBACK_DAYS = 7
MIN_DURATION_SECONDS = 180
RSS_PAGE_SIZE = 15
SQUARE = 1080
SCHEDULE_GAP = timedelta(hours=2)
MIN_SCHEDULE_LEAD = timedelta(minutes=15)
MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024
SCALE_FILTER = (
    "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,setsar=1"
)
YTDLP_FORMAT = (
    "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/"
    "bv*[height<=1080][ext=mp4]+ba/"
    "b[ext=mp4][height<=1080]/"
    "bv*[height<=1080]+ba/"
    "b[height<=1080]"
)

ATOM = "http://www.w3.org/2005/Atom"
YT_NS = "http://www.youtube.com/xml/schemas/2015"

ROOT = Path(__file__).resolve().parent
STATE_PATH = Path(os.environ.get("STATE_PATH", ROOT / "posted.json"))
WORK_ROOT = Path(os.environ.get("WORK_ROOT", "/tmp/blair-yt-fb"))

_SECRETS: list[str] = []
Sleeper = Callable[[float], None]


def log(level: str, message: str) -> None:
    text = str(message)
    for secret in _SECRETS:
        if secret:
            text = text.replace(secret, "[redacted]")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{stamp} {level} {text}", flush=True)


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "y"}


def is_youtube_id(value: str) -> bool:
    if len(value) != 11:
        return False
    return all(("a" <= char <= "z") or ("A" <= char <= "Z") or char.isdigit() or char in "-_" for char in value)


def caption_for(title: str) -> str:
    """Facebook caption. The YouTube title is copied unchanged."""
    if title is None or title.strip() == "":
        raise ValueError("YouTube title is empty")
    return title


def norm_text(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", value or "")
    text = text.replace("\u00a0", " ")
    return " ".join(text.split())


class GraphError(RuntimeError):
    def __init__(self, message: str, http_status: int | None = None, code: int | None = None):
        super().__init__(message)
        self.http_status = http_status
        self.code = code


class RetryableError(RuntimeError):
    pass


def is_retryable_status(status: int | None, code: int | None) -> bool:
    if status in {429, 500, 502, 503, 504}:
        return True
    return code in {1, 2, 4, 17, 32, 613}


def with_retries(label: str, fn: Callable[[], object], attempts: int = 3, sleeper: Sleeper = time.sleep):
    delay = 2.0
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except RetryableError as exc:
            last = exc
            log("WARN", f"{label} attempt {attempt} failed: {exc}")
            if attempt == attempts:
                break
            sleeper(delay)
            delay *= 2
    raise RuntimeError(f"{label} failed after {attempts} attempts: {last}")


def _safe_url(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _read_http(req: urllib.request.Request, timeout: float) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        body = exc.read()
        return exc.code, body
    except urllib.error.URLError as exc:
        raise RetryableError(f"network error for {_safe_url(req.full_url)}: {exc.reason}") from exc
    except TimeoutError as exc:
        raise RetryableError(f"timeout for {_safe_url(req.full_url)}") from exc


def request_bytes(method: str, url: str, *, headers: dict[str, str] | None = None,
                  body: bytes | object | None = None, timeout: float = 60) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        return _read_http(req, timeout)
    finally:
        if hasattr(body, "close"):
            body.close()


def parse_graph_body(status: int, raw: bytes) -> dict:
    text = raw.decode("utf-8", "replace")
    try:
        payload = json.loads(text) if text else {}
    except json.JSONDecodeError as exc:
        snippet = text[:500].replace("\n", " ")
        raise GraphError(f"non-JSON Graph response HTTP {status}: {snippet}", http_status=status) from exc
    if not isinstance(payload, dict):
        raise GraphError(f"unexpected Graph payload HTTP {status}", http_status=status)
    if status >= 400 or "error" in payload:
        err = payload.get("error") or {}
        message = err.get("message") or f"HTTP {status}"
        code = err.get("code")
        graph_error = GraphError(f"Graph API HTTP {status} code {code}: {message}", http_status=status, code=code)
        if is_retryable_status(status, code if isinstance(code, int) else None):
            raise RetryableError(str(graph_error)) from graph_error
        raise graph_error
    return payload


def graph_form(url: str, fields: dict[str, str], timeout: float = 120) -> dict:
    body = urllib.parse.urlencode(fields).encode("utf-8")
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    status, raw = request_bytes("POST", url, headers=headers, body=body, timeout=timeout)
    return parse_graph_body(status, raw)


def graph_get(url: str, params: dict[str, str] | None, timeout: float = 60) -> dict:
    if params:
        query = urllib.parse.urlencode(params)
        url = f"{url}?{query}"
    status, raw = request_bytes("GET", url, timeout=timeout)
    return parse_graph_body(status, raw)


@dataclass
class Video:
    video_id: str
    title: str
    published: datetime
    url: str
    duration: float | None = None
    live_status: str | None = None

    @property
    def watch_url(self) -> str:
        return f"https://www.youtube.com/watch?v={self.video_id}"


def is_short_url(url: str) -> bool:
    path = urllib.parse.urlsplit(url).path.lower()
    return path == "/shorts" or path.startswith("/shorts/")


def parse_rss(xml_bytes: bytes) -> list[Video]:
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise RuntimeError(f"YouTube RSS did not parse: {exc}") from exc
    videos: list[Video] = []
    for entry in root.findall(f"{{{ATOM}}}entry"):
        video_id = (entry.findtext(f"{{{YT_NS}}}videoId") or "").strip()
        title = entry.findtext(f"{{{ATOM}}}title")
        published_raw = entry.findtext(f"{{{ATOM}}}published")
        url = ""
        for link in entry.findall(f"{{{ATOM}}}link"):
            if link.get("rel") == "alternate" and link.get("href"):
                url = link.get("href") or ""
                break
        if not video_id or title is None or not published_raw or not url:
            raise RuntimeError("YouTube RSS entry is missing id, title, link, or published time")
        published = datetime.fromisoformat(published_raw)
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
        videos.append(Video(video_id=video_id, title=title, published=published.astimezone(timezone.utc), url=url))
    return videos


def feed_is_truncated(videos: list[Video], cutoff: datetime, page_size: int = RSS_PAGE_SIZE) -> bool:
    """True when the RSS page is full and still inside the lookback window."""
    if len(videos) < page_size:
        return False
    oldest = min(video.published for video in videos)
    return oldest >= cutoff


def text_mentions_video(text: str | None, video_id: str) -> bool:
    if not text or not video_id:
        return False
    needles = (
        f"watch?v={video_id}",
        f"youtu.be/{video_id}",
        f"/shorts/{video_id}",
        f"/embed/{video_id}",
        f"/v/{video_id}",
    )
    return any(needle in text for needle in needles)


def is_duplicate(video: Video, state: dict, fb_texts: list[str]) -> str | None:
    posted = state.get("posted") or {}
    if video.video_id in posted:
        return "state"
    title = norm_text(video.title)
    for text in fb_texts:
        if text_mentions_video(text, video.video_id):
            return "facebook_url"
        if title and norm_text(text) == title:
            return "facebook_title"
    return None


@dataclass
class ScheduleCursor:
    """First successful upload publishes now. Later successes are 2 hours apart."""

    need_immediate: bool = True
    next_time: datetime | None = None

    def peek(self, now: datetime) -> datetime | None:
        if self.need_immediate:
            return None
        if self.next_time is None:
            raise RuntimeError("schedule cursor is missing the next time")
        earliest = now + MIN_SCHEDULE_LEAD
        if self.next_time < earliest:
            return earliest
        return self.next_time

    def commit(self, when: datetime | None, now: datetime) -> None:
        anchor = now if when is None else when
        self.need_immediate = False
        self.next_time = anchor + SCHEDULE_GAP


def load_state(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "posted": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"state file is not valid JSON: {path}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("posted"), dict):
        raise RuntimeError(f"state file is missing a posted object: {path}")
    data.setdefault("version", 1)
    return data


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(state, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(path)


def record_post(state: dict, video: Video, facebook_video_id: str, when: datetime | None, uploaded_at: datetime) -> None:
    state.setdefault("posted", {})
    state["posted"][video.video_id] = {
        "facebook_video_id": facebook_video_id,
        "scheduled_publish_time": None if when is None else when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "title": video.title,
        "uploaded_at": uploaded_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "youtube_id": video.video_id,
        "youtube_published_at": video.published.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "youtube_url": video.watch_url,
    }


def _tool(name: str) -> str:
    env_key = "YT_DLP" if name == "yt-dlp" else name.upper()
    found = os.environ.get(env_key) or shutil.which(name)
    if not found:
        raise RuntimeError(f"{name} is not installed")
    return found


def run_cmd(cmd: list[str], timeout: float, cwd: Path | None = None) -> str:
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            cwd=str(cwd) if cwd else None,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"{cmd[0]} timed out after {timeout:.0f}s") from exc
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace")[-4000:]
        raise RuntimeError(f"{Path(cmd[0]).name} exited {proc.returncode}: {err}")
    return proc.stdout.decode("utf-8", "replace")


def fetch_rss(channel_id: str) -> list[Video]:
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    headers = {"User-Agent": "Mozilla/5.0 (compatible; blair-yt-fb/1.0)"}

    def once():
        status, raw = request_bytes("GET", url, headers=headers, timeout=45)
        if status != 200:
            message = f"YouTube RSS HTTP {status} for channel {channel_id}"
            if status >= 500 or status == 429:
                raise RetryableError(message)
            raise RuntimeError(message)
        return parse_rss(raw)

    videos = with_retries(f"rss {channel_id}", once)
    log("INFO", f"RSS {channel_id} returned {len(videos)} entries")
    return videos


def probe_video(video_id: str) -> dict:
    binary = _tool("yt-dlp")
    url = f"https://www.youtube.com/watch?v={video_id}"
    raw = run_cmd(
        [binary, "-J", "--skip-download", "--no-warnings", "--no-playlist", url],
        timeout=180,
    )
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"yt-dlp probe for {video_id} was not JSON") from exc
    if not isinstance(data, dict) or not data.get("id"):
        raise RuntimeError(f"yt-dlp probe for {video_id} had no id")
    return data


def video_from_probe(data: dict, fallback: Video | None = None) -> Video:
    video_id = str(data.get("id") or (fallback.video_id if fallback else "")).strip()
    title = data.get("title")
    if not isinstance(title, str) or title == "":
        title = fallback.title if fallback else ""
    if fallback and fallback.title:
        title = fallback.title
    timestamp = data.get("timestamp")
    if isinstance(timestamp, (int, float)):
        published = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    elif fallback:
        published = fallback.published
    else:
        upload_date = str(data.get("upload_date") or "")
        if len(upload_date) == 8 and upload_date.isdigit():
            published = datetime.strptime(upload_date, "%Y%m%d").replace(tzinfo=timezone.utc)
        else:
            raise RuntimeError(f"yt-dlp result for {video_id} has no publish time")
    url = str(data.get("webpage_url") or (fallback.url if fallback else "") or f"https://www.youtube.com/watch?v={video_id}")
    if fallback and is_short_url(fallback.url):
        url = fallback.url
    duration = data.get("duration")
    duration_value = float(duration) if isinstance(duration, (int, float)) else None
    live_status = data.get("live_status")
    live_value = str(live_status) if live_status else None
    if not video_id or not title:
        raise RuntimeError(f"yt-dlp result for {video_id or '?'} is missing id or title")
    return Video(
        video_id=video_id,
        title=title,
        published=published,
        url=url,
        duration=duration_value,
        live_status=live_value,
    )


def resolve_channel_id_with_ytdlp() -> str:
    binary = _tool("yt-dlp")
    raw = run_cmd(
        [binary, "--print", "%(channel_id)s", "--playlist-items", "1", "--no-warnings", "--skip-download", CHANNEL_VIDEOS_URL],
        timeout=180,
    )
    channel_id = raw.strip().splitlines()[-1].strip() if raw.strip() else ""
    if not channel_id.startswith("UC") or len(channel_id) < 20:
        raise RuntimeError(f"yt-dlp did not return a channel id for {CHANNEL_HANDLE}: {channel_id!r}")
    log("INFO", f"yt-dlp resolved {CHANNEL_HANDLE} to {channel_id}")
    return channel_id


def list_videos_with_ytdlp(cutoff: datetime) -> list[Video]:
    binary = _tool("yt-dlp")
    raw = run_cmd(
        [
            binary,
            "--flat-playlist",
            "--no-warnings",
            "--playlist-end", "40",
            "--print", "%(id)s",
            CHANNEL_VIDEOS_URL,
        ],
        timeout=300,
    )
    ids = [line.strip() for line in raw.splitlines() if is_youtube_id(line.strip())]
    found: list[Video] = []
    hit_older = False
    for video_id in ids:
        probed = video_from_probe(probe_video(video_id))
        if probed.published < cutoff:
            hit_older = True
            break
        found.append(probed)
    if not hit_older and len(ids) >= 40:
        raise RuntimeError("yt-dlp scanned 40 videos and all were still inside the 7 day window")
    log("INFO", f"yt-dlp listed {len(found)} videos inside the lookback window")
    return found


def list_recent_entries(now: datetime) -> tuple[list[Video], list[str]]:
    cutoff = now - timedelta(days=LOOKBACK_DAYS)
    errors: list[str] = []
    try:
        entries = fetch_rss(CHANNEL_ID)
    except Exception as exc:
        log("WARN", f"RSS for hardcoded channel id failed: {exc}")
        try:
            resolved = resolve_channel_id_with_ytdlp()
            if resolved != CHANNEL_ID:
                entries = fetch_rss(resolved)
            else:
                raise RuntimeError("resolved channel id matches the hardcoded id and RSS still failed")
        except Exception as fallback_exc:
            log("WARN", f"RSS fallback failed, listing with yt-dlp: {fallback_exc}")
            return list_videos_with_ytdlp(cutoff), errors

    if feed_is_truncated(entries, cutoff):
        log("WARN", "RSS page is still inside the 7 day window. Supplementing with yt-dlp.")
        try:
            extra = list_videos_with_ytdlp(cutoff)
        except Exception as exc:
            errors.append(f"yt-dlp supplement failed: {exc}")
            extra = []
        by_id = {video.video_id: video for video in entries}
        for video in extra:
            by_id.setdefault(video.video_id, video)
        entries = list(by_id.values())
    recent = [video for video in entries if video.published >= cutoff]
    recent.sort(key=lambda video: (video.published, video.video_id))
    return recent, errors


def classify(video: Video) -> tuple[bool, str]:
    if is_short_url(video.url):
        return False, "shorts_url"
    if video.live_status in {"is_live", "is_upcoming"}:
        return False, f"live:{video.live_status}"
    if video.duration is None:
        return False, "duration_unknown"
    if video.duration < MIN_DURATION_SECONDS:
        return False, "under_3_min"
    return True, "longform"


def enrich_with_duration(videos: list[Video]) -> tuple[list[Video], list[str]]:
    ready: list[Video] = []
    errors: list[str] = []
    for video in videos:
        if is_short_url(video.url):
            ready.append(video)
            continue
        if video.duration is not None and video.live_status is not None:
            ready.append(video)
            continue
        try:
            probed = video_from_probe(probe_video(video.video_id), fallback=video)
        except Exception as exc:
            errors.append(f"{video.video_id} probe failed: {exc}")
            log("ERROR", errors[-1])
            continue
        ready.append(probed)
    return ready, errors


def ytdlp_download_cmd(binary: str, url: str, output_template: str, cache_dir: str) -> list[str]:
    return [
        binary,
        "--no-warnings",
        "--no-progress",
        "--no-playlist",
        "--retries", "3",
        "--fragment-retries", "3",
        "--merge-output-format", "mp4",
        "--cache-dir", cache_dir,
        "-f", YTDLP_FORMAT,
        "-o", output_template,
        url,
    ]


def download_source(video: Video, work: Path) -> Path:
    binary = _tool("yt-dlp")
    cache = work / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    template = str(work / "source.%(ext)s")
    cmd = ytdlp_download_cmd(binary, video.watch_url, template, str(cache))
    log("INFO", f"downloading {video.video_id} up to 1080p mp4")
    run_cmd(cmd, timeout=1800, cwd=work)
    files = [path for path in work.iterdir() if path.is_file() and path.name.startswith("source.")]
    if len(files) != 1:
        raise RuntimeError(f"expected one downloaded file for {video.video_id}, found {[p.name for p in files]}")
    return files[0]


def encode_square(source: Path, dest: Path) -> None:
    ffmpeg = _tool("ffmpeg")
    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(source),
        "-vf", SCALE_FILTER,
        "-map", "0:v:0",
        "-map", "0:a:0",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "160k",
        "-ac", "2",
        "-movflags", "+faststart",
        str(dest),
    ]
    log("INFO", f"encoding {dest.name} to {SQUARE}x{SQUARE} H.264/AAC")
    run_cmd(cmd, timeout=2400)


def ffprobe_streams(path: Path) -> list[dict]:
    ffprobe = _tool("ffprobe")
    raw = run_cmd(
        [
            ffprobe, "-v", "error",
            "-show_entries", "stream=codec_name,codec_type,width,height,channels",
            "-of", "json",
            str(path),
        ],
        timeout=60,
    )
    payload = json.loads(raw)
    streams = payload.get("streams")
    if not isinstance(streams, list):
        raise RuntimeError("ffprobe returned no streams")
    return streams


def validate_streams(streams: list[dict]) -> None:
    video = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if len(video) != 1 or len(audio) != 1:
        raise RuntimeError(f"expected one H.264 video stream and one AAC audio stream, got {streams}")
    if video[0].get("codec_name") != "h264" or audio[0].get("codec_name") != "aac":
        raise RuntimeError(f"expected H.264/AAC, got video={video[0].get('codec_name')} audio={audio[0].get('codec_name')}")
    if int(audio[0].get("channels") or 0) != 2:
        raise RuntimeError(f"expected stereo AAC, got {audio[0].get('channels')} channels")
    if int(video[0].get("width") or 0) != SQUARE or int(video[0].get("height") or 0) != SQUARE:
        raise RuntimeError(f"expected {SQUARE}x{SQUARE}, got {video[0].get('width')}x{video[0].get('height')}")


def media_duration(path: Path) -> float:
    ffprobe = _tool("ffprobe")
    raw = run_cmd(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        timeout=60,
    )
    try:
        return float(raw.strip())
    except ValueError as exc:
        raise RuntimeError(f"could not read duration for {path}") from exc


def read_frame_rgb(path: Path, seconds: float, width: int, height: int) -> bytes:
    ffmpeg = _tool("ffmpeg")
    proc = subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error",
            "-ss", f"{max(0.0, seconds):.3f}",
            "-i", str(path),
            "-frames:v", "1",
            "-f", "rawvideo",
            "-pix_fmt", "rgb24",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=60,
    )
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace")[-2000:]
        raise RuntimeError(f"ffmpeg frame extract failed: {err}")
    expected = width * height * 3
    if len(proc.stdout) < expected:
        raise RuntimeError(f"frame extract returned {len(proc.stdout)} bytes, expected at least {expected}")
    return proc.stdout[:expected]


@dataclass
class EdgeStats:
    side: str
    mean: float
    stdev: float

    @property
    def is_black(self) -> bool:
        return self.mean < 14 and self.stdev < 5


def edge_stats(rgb: bytes, width: int, height: int, side: str, thickness: int = 8) -> EdgeStats:
    lumas: list[float] = []
    thickness = min(thickness, width, height)
    if side == "top":
        coords = ((x, y) for y in range(thickness) for x in range(width))
    elif side == "bottom":
        coords = ((x, y) for y in range(height - thickness, height) for x in range(width))
    elif side == "left":
        coords = ((x, y) for x in range(thickness) for y in range(height))
    elif side == "right":
        coords = ((x, y) for x in range(width - thickness, width) for y in range(height))
    else:
        raise ValueError(f"unknown edge {side}")
    for x, y in coords:
        index = (y * width + x) * 3
        red, green, blue = rgb[index], rgb[index + 1], rgb[index + 2]
        lumas.append(0.2126 * red + 0.7152 * green + 0.0722 * blue)
    mean = sum(lumas) / len(lumas)
    variance = sum((value - mean) ** 2 for value in lumas) / len(lumas)
    return EdgeStats(side=side, mean=mean, stdev=variance ** 0.5)


def black_edges_on_frame(rgb: bytes, width: int, height: int) -> list[EdgeStats]:
    return [edge_stats(rgb, width, height, side) for side in ("top", "bottom", "left", "right")]


def assert_no_black_edges(path: Path) -> None:
    streams = ffprobe_streams(path)
    validate_streams(streams)
    duration = media_duration(path)
    black_counts = {side: 0 for side in ("top", "bottom", "left", "right")}
    details: dict[str, list[str]] = {side: [] for side in black_counts}
    for fraction in (0.25, 0.5, 0.75):
        rgb = read_frame_rgb(path, duration * fraction, SQUARE, SQUARE)
        for stats in black_edges_on_frame(rgb, SQUARE, SQUARE):
            details[stats.side].append(f"mean={stats.mean:.1f} stdev={stats.stdev:.1f}")
            if stats.is_black:
                black_counts[stats.side] += 1
    bad = [side for side, count in black_counts.items() if count == 3]
    if bad:
        summary = ", ".join(f"{side} ({'; '.join(details[side])})" for side in bad)
        raise RuntimeError(f"encoded frame has black edges on {summary}")
    log("INFO", f"frame check passed for {path.name}")


def jpeg_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 4 or data[0:2] != b"\xff\xd8":
        return None
    index = 2
    while index + 9 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        if marker in {0xC0, 0xC1, 0xC2}:
            height = int.from_bytes(data[index + 5:index + 7], "big")
            width = int.from_bytes(data[index + 7:index + 9], "big")
            return width, height
        if marker in {0xD8, 0x01}:
            index += 2
            continue
        if marker == 0xD9:
            break
        if index + 4 > len(data):
            break
        segment = int.from_bytes(data[index + 2:index + 4], "big")
        if segment < 2:
            break
        index += 2 + segment
    return None


def download_thumbnail(video_id: str, dest: Path) -> Path | None:
    headers = {"User-Agent": "Mozilla/5.0 (compatible; blair-yt-fb/1.0)"}
    candidates = [
        f"https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg",
        f"https://i.ytimg.com/vi/{video_id}/sddefault.jpg",
        f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
    ]
    best: tuple[int, bytes] | None = None
    for url in candidates:
        try:
            status, raw = request_bytes("GET", url, headers=headers, timeout=30)
        except Exception as exc:
            log("WARN", f"thumbnail fetch failed for {url}: {exc}")
            continue
        if status != 200 or not raw:
            continue
        size = jpeg_size(raw)
        if not size:
            continue
        width, height = size
        if best is None or width * height > best[0]:
            best = (width * height, raw)
        if width >= 640:
            dest.write_bytes(raw)
            log("INFO", f"thumbnail {width}x{height} from {url}")
            return dest
    if best:
        dest.write_bytes(best[1])
        log("WARN", f"using the largest available thumbnail for {video_id}; maxres was small or missing")
        return dest
    log("WARN", f"no YouTube thumbnail for {video_id}")
    return None


def require_free_space(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(path).free
    if free < MIN_FREE_BYTES:
        raise RuntimeError(f"only {free / (1024 ** 3):.1f} GiB free under {path}; need 3 GiB before a download")


def graph_base(host: str) -> str:
    return f"https://{host}/{GRAPH_VERSION}"


def auth_fields(token: str, fields: dict[str, str]) -> dict[str, str]:
    merged = {"access_token": token}
    merged.update(fields)
    return merged


def verify_page(page_id: str, token: str) -> str:
    url = f"{graph_base('graph.facebook.com')}/{page_id}"
    payload = graph_get(url, {"fields": "id,name", "access_token": token})
    found = str(payload.get("id") or "")
    name = str(payload.get("name") or "")
    if found != page_id:
        raise RuntimeError(f"token page id {found} does not match FB_PAGE_ID {page_id}")
    log("INFO", f"Facebook page: {name} ({found})")
    return name


def _collect_edge(page_id: str, token: str, edge: str, field_attempts: list[str]) -> list[dict]:
    last_error: Exception | None = None
    for fields in field_attempts:
        try:
            return _page_edge(page_id, token, edge, fields)
        except GraphError as exc:
            last_error = exc
            log("WARN", f"{edge} fields '{fields}' failed: {exc}")
            if exc.http_status in {401, 403} or exc.code in {190, 200, 10}:
                raise
    raise RuntimeError(f"could not read Facebook {edge}: {last_error}")


def _page_edge(page_id: str, token: str, edge: str, fields: str, max_items: int = 200) -> list[dict]:
    items: list[dict] = []
    url = f"{graph_base('graph.facebook.com')}/{page_id}/{edge}"
    params: dict[str, str] | None = {
        "fields": fields,
        "limit": "25",
        "access_token": token,
    }
    while url and len(items) < max_items:
        payload = graph_get(url, params)
        params = None
        batch = payload.get("data") or []
        if not isinstance(batch, list):
            raise GraphError(f"{edge} data was not a list")
        items.extend(item for item in batch if isinstance(item, dict))
        url = ((payload.get("paging") or {}).get("next")) or ""
    log("INFO", f"Facebook {edge}: {len(items)} items")
    return items


def fetch_facebook_texts(page_id: str, token: str) -> list[str]:
    groups = [
        ("video_reels", ["id,description,title,updated_time", "id,description,title", "description,title"]),
        ("videos", ["id,description,title,created_time", "id,description,title", "description,title"]),
        ("scheduled_posts", ["id,message,created_time,scheduled_publish_time", "id,message", "message"]),
    ]
    texts: list[str] = []
    for edge, attempts in groups:
        for item in _collect_edge(page_id, token, edge, attempts):
            for key in ("title", "description", "message"):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    texts.append(value)
    log("INFO", f"Facebook dedupe texts: {len(texts)}")
    return texts


class SequenceReader:
    """File-like body: small header bytes plus a slice of the video, no second full copy."""

    def __init__(self, parts: list[bytes | tuple[str, Path, int, int]]):
        self._parts: list[tuple[str, bytes | Path, int, int]] = []
        self.length = 0
        for part in parts:
            if isinstance(part, bytes):
                self._parts.append(("bytes", part, 0, len(part)))
                self.length += len(part)
            else:
                kind, path, start, end = part
                if end < start:
                    raise ValueError("invalid file slice")
                self._parts.append((kind, path, start, end))
                self.length += end - start
        self._index = 0
        self._pos = 0
        self._fh = None

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            size = self.length
        out = bytearray()
        while size > 0 and self._index < len(self._parts):
            kind, payload, start, end = self._parts[self._index]
            if kind == "bytes":
                assert isinstance(payload, bytes)
                chunk = payload[self._pos:self._pos + size]
                self._pos += len(chunk)
                out += chunk
                size -= len(chunk)
                if self._pos >= len(payload):
                    self._advance()
            else:
                span = end - start
                if self._fh is None:
                    self._fh = open(payload, "rb")
                    self._fh.seek(start + self._pos)
                take = min(size, span - self._pos)
                data = self._fh.read(take)
                if not data:
                    raise RuntimeError("unexpected end of video slice")
                out += data
                self._pos += len(data)
                size -= len(data)
                if self._pos >= span:
                    self._advance()
        return bytes(out)

    def _advance(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None
        self._index += 1
        self._pos = 0

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None


def _multipart(fields: list[tuple[str, str]], file_field: tuple[str, str, str, Path, int, int] | None) -> SequenceReader:
    boundary = f"blair{uuid.uuid4().hex}{random.randrange(10**6)}"
    chunks: list[bytes | tuple[str, Path, int, int]] = []
    for name, value in fields:
        header = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
        ).encode("utf-8")
        chunks.append(header)
        chunks.append(value.encode("utf-8"))
        chunks.append(b"\r\n")
    if file_field:
        field_name, filename, content_type, path, start, end = file_field
        header = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode("utf-8")
        chunks.append(header)
        chunks.append(("slice", path, start, end))
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    reader = SequenceReader(chunks)
    reader.boundary = boundary  # type: ignore[attr-defined]
    return reader


def post_multipart(url: str, fields: list[tuple[str, str]], file_field, timeout: float) -> dict:
    reader = _multipart(fields, file_field)
    boundary = reader.boundary  # type: ignore[attr-defined]
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(reader.length),
    }
    status, raw = request_bytes("POST", url, headers=headers, body=reader, timeout=timeout)
    return parse_graph_body(status, raw)


def _offsets(payload: dict) -> tuple[int, int]:
    try:
        return int(payload["start_offset"]), int(payload["end_offset"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(f"upload response missing offsets: {payload}") from exc


def upload_video_file(page_id: str, token: str, path: Path) -> tuple[str, str]:
    size = path.stat().st_size
    if size <= 0:
        raise RuntimeError(f"encoded file is empty: {path}")
    url = f"{graph_base('graph-video.facebook.com')}/{page_id}/videos"
    log("INFO", f"starting resumable upload ({size} bytes)")
    started = graph_form(url, auth_fields(token, {"upload_phase": "start", "file_size": str(size)}))
    session_id = str(started.get("upload_session_id") or "")
    video_id = str(started.get("video_id") or "")
    if not session_id or not video_id:
        raise RuntimeError(f"upload start did not return session and video ids: {started}")
    if started.get("skip_upload"):
        start = end = size
    else:
        start, end = _offsets(started)
    log("INFO", f"facebook video_id={video_id} session={session_id}")
    transfers = 0
    while start != end:
        if not (0 <= start < end <= size):
            raise RuntimeError(f"bad upload offsets {start}-{end} for {size} byte file")
        previous = start

        def send(start=start, end=end):
            return post_multipart(
                url,
                [
                    ("access_token", token),
                    ("upload_phase", "transfer"),
                    ("upload_session_id", session_id),
                    ("start_offset", str(start)),
                ],
                ("video_file_chunk", "square.mp4", "video/mp4", path, start, end),
                timeout=max(180, int((end - start) / 200_000)),
            )

        transferred = with_retries(f"transfer {start}-{end}", send)
        start, end = _offsets(transferred)
        transfers += 1
        if start < previous or (start == previous and start != end):
            raise RuntimeError(f"upload offset did not advance from {previous} (now {start}-{end})")
        if transfers > 100000:
            raise RuntimeError("upload made too many transfer calls")
        log("INFO", f"upload progress {start}/{size}")
    return video_id, session_id


def finish_video(page_id: str, token: str, session_id: str, title: str, when: datetime | None) -> dict:
    fields = {
        "upload_phase": "finish",
        "upload_session_id": session_id,
        "title": title,
        "description": caption_for(title),
    }
    if when is None:
        fields["published"] = "true"
    else:
        fields["published"] = "false"
        fields["unpublished_content_type"] = "SCHEDULED"
        fields["scheduled_publish_time"] = str(int(when.timestamp()))
    url = f"{graph_base('graph-video.facebook.com')}/{page_id}/videos"
    payload = graph_form(url, auth_fields(token, fields), timeout=180)
    if payload.get("success") is False:
        raise RuntimeError(f"Facebook finish returned success=false: {payload}")
    return payload


def upload_thumbnail(video_id: str, token: str, thumb: Path, sleeper: Sleeper = time.sleep) -> bool:
    url = f"{graph_base('graph.facebook.com')}/{video_id}/thumbnails"
    attempts = 4
    for attempt in range(1, attempts + 1):
        try:
            payload = post_multipart(
                url,
                [("access_token", token), ("is_preferred", "true")],
                ("source", "thumb.jpg", "image/jpeg", thumb, 0, thumb.stat().st_size),
                timeout=120,
            )
            log("INFO", f"thumbnail set on {video_id}: {payload.get('success', payload)}")
            return True
        except GraphError as exc:
            log("WARN", f"thumbnail attempt {attempt} was not accepted: {exc}")
            if attempt == attempts:
                log("WARN", "Facebook did not accept the YouTube thumbnail. The video itself was published.")
                return False
            sleeper(5)
        except RetryableError as exc:
            log("WARN", f"thumbnail attempt {attempt} failed: {exc}")
            if attempt == attempts:
                log("WARN", "Facebook did not accept the YouTube thumbnail. The video itself was published.")
                return False
            sleeper(5)
    return False


def upload_square(page_id: str, token: str, video: Video, square: Path, thumb: Path | None, when: datetime | None) -> str:
    mode = "publish now" if when is None else f"schedule {when.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}"
    log("INFO", f"uploading {video.video_id} ({mode})")
    video_id, session_id = upload_video_file(page_id, token, square)
    finish_video(page_id, token, session_id, video.title, when)
    if thumb is not None:
        upload_thumbnail(video_id, token, thumb)
    else:
        log("WARN", f"no thumbnail uploaded for {video.video_id}")
    return video_id


def prepare_square(video: Video) -> tuple[Path, tempfile.TemporaryDirectory]:
    require_free_space(WORK_ROOT)
    work = tempfile.TemporaryDirectory(prefix=f"blair-{video.video_id}-", dir=str(WORK_ROOT))
    try:
        root = Path(work.name)
        source = download_source(video, root)
        square = root / "square.mp4"
        encode_square(source, square)
        source.unlink()
        assert_no_black_edges(square)
        return square, work
    except Exception:
        work.cleanup()
        raise


def process_video(video: Video, when: datetime | None, page_id: str, token: str, dry_run: bool,
                  state: dict, state_path: Path) -> str:
    square, work = prepare_square(video)
    try:
        thumb = None
        try:
            thumb = download_thumbnail(video.video_id, Path(work.name) / "thumb.jpg")
        except Exception as exc:
            log("WARN", f"thumbnail download failed for {video.video_id}: {exc}")
        if dry_run:
            log("INFO", f"DRY_RUN skip upload {video.video_id} title={video.title!r} when={when}")
            return "dry_run"
        facebook_id = upload_square(page_id, token, video, square, thumb, when)
        uploaded_at = datetime.now(timezone.utc)
        mode = "scheduled" if when else "published"
        log("INFO", f"UPLOADED youtube_id={video.video_id} facebook_video_id={facebook_id} mode={mode}")
        record_post(state, video, facebook_id, when, uploaded_at)
        save_state(state_path, state)
        return facebook_id
    finally:
        work.cleanup()


def run() -> int:
    dry_run = env_flag("DRY_RUN")
    page_id = os.environ.get("FB_PAGE_ID", "").strip()
    token = os.environ.get("FB_PAGE_ACCESS_TOKEN", "").strip()
    if token:
        _SECRETS.append(token)
    log("INFO", f"start dry_run={dry_run} channel={CHANNEL_ID} graph={GRAPH_VERSION}")
    if not page_id or not token:
        log("ERROR", "FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN are required")
        return 1
    now = datetime.now(timezone.utc)
    errors: list[str] = []
    try:
        verify_page(page_id, token)
        state = load_state(STATE_PATH)
        fb_texts = fetch_facebook_texts(page_id, token)
        entries, list_errors = list_recent_entries(now)
        errors.extend(list_errors)
        enriched, probe_errors = enrich_with_duration(entries)
        errors.extend(probe_errors)
    except Exception as exc:
        log("ERROR", f"setup failed: {exc}")
        return 1

    longform: list[Video] = []
    for video in enriched:
        keep, reason = classify(video)
        if keep:
            longform.append(video)
            log("INFO", f"longform {video.video_id} {video.duration:.0f}s {video.published.isoformat()} {video.title}")
        else:
            log("INFO", f"skip {video.video_id} reason={reason} title={video.title}")
            if reason == "duration_unknown":
                errors.append(f"{video.video_id} duration unknown")

    missing: list[Video] = []
    for video in longform:
        reason = is_duplicate(video, state, fb_texts)
        if reason:
            log("INFO", f"dedupe {video.video_id} via {reason}")
            continue
        missing.append(video)
    missing.sort(key=lambda video: (video.published, video.video_id))
    log("INFO", f"missing={len(missing)} longform={len(longform)} errors_so_far={len(errors)}")

    cursor = ScheduleCursor()
    uploaded = 0
    for video in missing:
        try:
            caption_for(video.title)
        except ValueError as exc:
            errors.append(f"{video.video_id} {exc}")
            log("ERROR", errors[-1])
            continue
        now = datetime.now(timezone.utc)
        when = cursor.peek(now)
        try:
            result = process_video(video, when, page_id, token, dry_run, state, STATE_PATH)
        except Exception as exc:
            message = f"{video.video_id} failed: {exc}"
            errors.append(message)
            log("ERROR", message)
            continue
        cursor.commit(when, datetime.now(timezone.utc))
        if result != "dry_run":
            uploaded += 1

    log(
        "INFO",
        f"SUMMARY longform={len(longform)} missing={len(missing)} uploaded={uploaded} "
        f"errors={len(errors)} dry_run={dry_run}",
    )
    for message in errors:
        log("ERROR", message)
    if errors:
        return 1
    if not missing:
        log("INFO", "nothing new to post")
    return 0


def main() -> int:
    try:
        return run()
    except Exception as exc:
        log("ERROR", f"unhandled error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
