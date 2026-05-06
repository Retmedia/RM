from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Iterator
from urllib.parse import urlparse

from youtube_leads.http import HttpClient
from youtube_leads.models import Channel

log = logging.getLogger(__name__)

API_BASE = "https://www.googleapis.com/youtube/v3"

URL_RE = re.compile(
    r"https?://[^\s<>\"'\)\]\}]+",
    re.IGNORECASE,
)

# Hosts we never treat as the creator's "linked website".
EXCLUDE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
    "google.com",
    "www.google.com",
    "bit.ly",  # shorteners get resolved by the website scraper anyway
    "t.co",
    "goo.gl",
}


class YouTubeClient:
    def __init__(self, api_key: str, http: HttpClient) -> None:
        if not api_key:
            raise ValueError("YOUTUBE_API_KEY is required")
        self._key = api_key
        self._http = http

    # ---- low-level ----

    def _get(self, path: str, params: dict) -> dict:
        params = {**params, "key": self._key}
        resp = self._http.get(f"{API_BASE}/{path}", params=params)
        if resp.status_code != 200:
            log.error(
                "YouTube API %s -> %s: %s",
                path, resp.status_code, resp.text[:300],
            )
            resp.raise_for_status()
        return resp.json()

    # ---- high level ----

    def discover_channels(
        self,
        query: str,
        *,
        min_subscribers: int = 200_000,
        days_active: int = 90,
        max_pages: int = 4,
        per_page: int = 50,
    ) -> Iterator[Channel]:
        """Search YouTube for channels matching `query`, yielding qualifying Channels.

        A channel qualifies when:
          * subscriber count >= min_subscribers
          * a video was uploaded within the last `days_active` days
        """
        seen_ids: set[str] = set()
        page_token: str | None = None
        for page in range(max_pages):
            data = self._get(
                "search",
                {
                    "part": "snippet",
                    "q": query,
                    "type": "channel",
                    "maxResults": min(per_page, 50),
                    "pageToken": page_token or "",
                },
            )
            ids = [
                item["snippet"]["channelId"]
                for item in data.get("items", [])
                if item.get("snippet", {}).get("channelId")
            ]
            ids = [i for i in ids if i not in seen_ids]
            seen_ids.update(ids)
            log.info("search.list page %d -> %d new ids", page + 1, len(ids))
            if not ids:
                break
            yield from self._fetch_qualifying(
                ids,
                niche=query,
                min_subscribers=min_subscribers,
                days_active=days_active,
            )
            page_token = data.get("nextPageToken")
            if not page_token:
                break

    def _fetch_qualifying(
        self,
        channel_ids: list[str],
        *,
        niche: str,
        min_subscribers: int,
        days_active: int,
    ) -> Iterator[Channel]:
        # channels.list takes up to 50 IDs per call.
        for batch in _chunks(channel_ids, 50):
            data = self._get(
                "channels",
                {
                    "part": "snippet,statistics,brandingSettings,contentDetails",
                    "id": ",".join(batch),
                    "maxResults": len(batch),
                },
            )
            for item in data.get("items", []):
                ch = self._parse_channel(item, niche=niche)
                if ch is None:
                    continue
                if ch.subscribers < min_subscribers:
                    continue
                last_video = self._latest_upload_at(item)
                ch.last_video_at = last_video
                if not _is_active(last_video, days_active):
                    continue
                yield ch

    def _parse_channel(self, item: dict, *, niche: str) -> Channel | None:
        try:
            cid = item["id"]
            sn = item.get("snippet", {})
            stats = item.get("statistics", {})
            branding = item.get("brandingSettings", {}).get("channel", {})
            subs = int(stats.get("subscriberCount", 0)) if not stats.get("hiddenSubscriberCount") else 0
            description = branding.get("description") or sn.get("description") or ""
            websites = _extract_urls(description)
            return Channel(
                channel_id=cid,
                name=sn.get("title") or branding.get("title") or cid,
                url=f"https://www.youtube.com/channel/{cid}",
                subscribers=subs,
                description=description,
                country=sn.get("country") or branding.get("country"),
                niche=niche,
                websites=websites,
            )
        except (KeyError, ValueError) as exc:
            log.warning("could not parse channel item: %s", exc)
            return None

    def _latest_upload_at(self, channel_item: dict) -> datetime | None:
        uploads_id = (
            channel_item.get("contentDetails", {})
            .get("relatedPlaylists", {})
            .get("uploads")
        )
        if not uploads_id:
            return None
        try:
            data = self._get(
                "playlistItems",
                {
                    "part": "snippet",
                    "playlistId": uploads_id,
                    "maxResults": 1,
                },
            )
        except Exception as exc:
            log.warning("playlistItems.list failed for %s: %s", uploads_id, exc)
            return None
        items = data.get("items") or []
        if not items:
            return None
        published = items[0].get("snippet", {}).get("publishedAt")
        return _parse_iso8601(published)


def _chunks(seq: list, size: int) -> Iterator[list]:
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def _parse_iso8601(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        # YouTube uses RFC 3339; replace trailing Z for fromisoformat compat.
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _is_active(last_video_at: datetime | None, days: int) -> bool:
    if not last_video_at:
        return False
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    if last_video_at.tzinfo is None:
        last_video_at = last_video_at.replace(tzinfo=timezone.utc)
    return last_video_at >= cutoff


def _extract_urls(text: str) -> list[str]:
    if not text:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for m in URL_RE.finditer(text):
        url = m.group(0).rstrip(".,);:!?\"'")
        host = (urlparse(url).netloc or "").lower()
        if not host or host in EXCLUDE_HOSTS:
            continue
        # crude domain dedup
        key = host
        if key in seen:
            continue
        seen.add(key)
        out.append(url)
    return out
