from youtube_leads.youtube import _extract_urls, _is_active, _parse_iso8601
from datetime import datetime, timedelta, timezone


def test_extract_urls_skips_youtube_and_dedupes() -> None:
    desc = (
        "Subscribe! https://www.youtube.com/something and visit "
        "https://brand.com/about. Also https://brand.com/contact and "
        "https://shop.example.io"
    )
    out = _extract_urls(desc)
    hosts = [u.split("/")[2] for u in out]
    assert "www.youtube.com" not in hosts
    # brand.com appears once, not twice
    assert hosts.count("brand.com") == 1
    assert "shop.example.io" in hosts


def test_extract_urls_strips_trailing_punct() -> None:
    desc = "See: https://brand.com/contact."
    assert _extract_urls(desc) == ["https://brand.com/contact"]


def test_is_active_recent() -> None:
    recent = datetime.now(timezone.utc) - timedelta(days=10)
    old = datetime.now(timezone.utc) - timedelta(days=200)
    assert _is_active(recent, 90) is True
    assert _is_active(old, 90) is False
    assert _is_active(None, 90) is False


def test_parse_iso8601_z() -> None:
    dt = _parse_iso8601("2026-04-12T12:34:56Z")
    assert dt is not None
    assert dt.tzinfo is not None
