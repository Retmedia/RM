from datetime import datetime, timedelta, timezone

from youtube_leads.models import Channel
from youtube_leads.scoring import score_lead, subscriber_tier


def _ch(**kw) -> Channel:
    base = dict(
        channel_id="UC1",
        name="Big Fitness Channel",
        url="https://www.youtube.com/channel/UC1",
        subscribers=2_500_000,
        description="The biggest fitness channel on the internet.",
        niche="fitness",
        websites=["https://demo.example"],
        last_video_at=datetime.now(timezone.utc) - timedelta(days=7),
    )
    base.update(kw)
    return Channel(**base)


def test_subscriber_tiers() -> None:
    assert subscriber_tier(10_000_000) == 1.0
    assert subscriber_tier(2_000_000) == 0.9
    assert subscriber_tier(700_000) == 0.7
    assert subscriber_tier(250_000) == 0.4
    assert subscriber_tier(1_000) == 0.1


def test_score_increases_with_email_and_recency() -> None:
    # Use a mid-tier channel so we don't saturate at 1.0.
    base = _ch(
        subscribers=350_000,
        last_video_at=datetime.now(timezone.utc) - timedelta(days=200),
    )
    no_email = score_lead(base, has_email=False, niche="fitness")
    with_email = score_lead(base, has_email=True, niche="fitness")
    recent = score_lead(
        _ch(subscribers=350_000),
        has_email=True,
        niche="fitness",
    )
    assert with_email > no_email
    assert recent > with_email
    assert 0.0 <= recent <= 1.0


def test_score_clamped() -> None:
    s = score_lead(
        _ch(subscribers=20_000_000),
        has_email=True,
        niche="fitness",
    )
    assert 0.0 <= s <= 1.0
