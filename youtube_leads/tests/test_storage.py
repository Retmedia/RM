from datetime import datetime
from pathlib import Path

import pytest

from youtube_leads.models import Channel, EmailRecord
from youtube_leads.storage import LeadStore


@pytest.fixture
def store(tmp_path: Path) -> LeadStore:
    return LeadStore(tmp_path / "leads.db")


def _ch(channel_id: str = "UC1", **kw) -> Channel:
    base = dict(
        channel_id=channel_id,
        name="Demo",
        url=f"https://www.youtube.com/channel/{channel_id}",
        subscribers=300_000,
        description="hello",
        country="US",
        niche="fitness",
        websites=["https://demo.example"],
        last_video_at=datetime(2026, 4, 1),
        score=0.7,
    )
    base.update(kw)
    return Channel(**base)


def test_upsert_channel_is_idempotent(store: LeadStore) -> None:
    assert store.upsert_channel(_ch()) is True
    assert store.upsert_channel(_ch()) is False
    leads = store.list_leads(require_email=False)
    assert len(leads) == 1
    assert leads[0].status == "new"


def test_dedup_emails_per_channel(store: LeadStore) -> None:
    store.upsert_channel(_ch())
    rec = EmailRecord(channel_id="UC1", email="HI@demo.example", source="website")
    assert store.add_email(rec) is True
    assert store.add_email(rec) is False  # same email, ignored
    other = EmailRecord(channel_id="UC1", email="press@demo.example", source="hunter")
    assert store.add_email(other) is True
    rows = store.emails_for_channel("UC1")
    assert {r.email for r in rows} == {"hi@demo.example", "press@demo.example"}


def test_set_status_validates(store: LeadStore) -> None:
    store.upsert_channel(_ch())
    store.set_status("UC1", "contacted", last_contacted_at=datetime(2026, 5, 1))
    leads = store.list_leads(status="contacted", require_email=False)
    assert len(leads) == 1
    assert leads[0].last_contacted_at is not None
    with pytest.raises(ValueError):
        store.set_status("UC1", "bogus")


def test_filter_by_niche_and_email(store: LeadStore) -> None:
    store.upsert_channel(_ch("UC1", niche="fitness"))
    store.upsert_channel(_ch("UC2", niche="finance"))
    store.add_email(EmailRecord(channel_id="UC1", email="a@a.com", source="website"))

    fitness_with_email = store.list_leads(niche="fitness", require_email=True)
    assert [l.channel.channel_id for l in fitness_with_email] == ["UC1"]
    finance = store.list_leads(niche="finance", require_email=False)
    assert [l.channel.channel_id for l in finance] == ["UC2"]
