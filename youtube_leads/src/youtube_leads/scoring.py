from __future__ import annotations

from datetime import datetime, timedelta, timezone

from youtube_leads.models import Channel


def subscriber_tier(subs: int) -> float:
    if subs >= 5_000_000:
        return 1.0
    if subs >= 1_000_000:
        return 0.9
    if subs >= 500_000:
        return 0.7
    if subs >= 200_000:
        return 0.4
    return 0.1


def niche_match(channel: Channel, niche: str | None) -> float:
    if not niche:
        return 0.5
    haystack = " ".join(
        filter(
            None,
            [channel.name.lower(), (channel.description or "").lower(), (channel.niche or "").lower()],
        )
    )
    terms = [t.strip().lower() for t in niche.split() if t.strip()]
    if not terms:
        return 0.5
    hits = sum(1 for t in terms if t in haystack)
    return min(1.0, hits / len(terms))


def recent_activity_bonus(channel: Channel) -> float:
    last = channel.last_video_at
    if not last:
        return 0.0
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    if last >= datetime.now(timezone.utc) - timedelta(days=30):
        return 0.3
    if last >= datetime.now(timezone.utc) - timedelta(days=90):
        return 0.1
    return 0.0


def score_lead(channel: Channel, *, has_email: bool, niche: str | None = None) -> float:
    base = subscriber_tier(channel.subscribers) * 0.5
    base += niche_match(channel, niche or channel.niche) * 0.2
    base += 0.3 if has_email else 0.0
    if channel.websites:
        base += 0.05
    base += recent_activity_bonus(channel) * 0.5
    return round(min(1.0, base), 3)
