from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable

OutreachStatus = str  # 'new' | 'contacted' | 'replied' | 'closed'
VALID_STATUSES = ("new", "contacted", "replied", "closed")


@dataclass
class Channel:
    channel_id: str
    name: str
    url: str
    subscribers: int
    description: str = ""
    country: str | None = None
    niche: str | None = None
    websites: list[str] = field(default_factory=list)
    last_video_at: datetime | None = None
    discovered_at: datetime = field(default_factory=datetime.utcnow)
    score: float = 0.0


@dataclass
class EmailRecord:
    channel_id: str
    email: str
    source: str  # 'website' | 'hunter' | 'apollo' | 'clearbit' | 'channel-description'
    source_url: str | None = None
    verified: bool = False
    discovered_at: datetime = field(default_factory=datetime.utcnow)


@dataclass
class Lead:
    """Flat join used by exporters / Notion / campaigns."""

    channel: Channel
    email: str | None
    email_source: str | None
    status: OutreachStatus
    last_contacted_at: datetime | None

    @property
    def name(self) -> str:
        return self.channel.name

    @property
    def channel_url(self) -> str:
        return self.channel.url


def chunked(seq: Iterable, size: int):
    """Yield lists of size `size` from `seq`."""
    buf: list = []
    for item in seq:
        buf.append(item)
        if len(buf) >= size:
            yield buf
            buf = []
    if buf:
        yield buf
