from datetime import datetime
from pathlib import Path

from youtube_leads.campaigns import build_batches
from youtube_leads.models import Channel, Lead


def _lead(cid: str, niche: str, score: float = 0.5, email: str = "x@x.com") -> Lead:
    return Lead(
        channel=Channel(
            channel_id=cid,
            name=f"Channel {cid}",
            url=f"https://yt/{cid}",
            subscribers=300_000,
            niche=niche,
            score=score,
        ),
        email=email,
        email_source="website",
        status="new",
        last_contacted_at=None,
    )


def test_build_batches_groups_and_chunks(tmp_path: Path) -> None:
    leads = (
        [_lead(f"f{i}", "fitness", score=i / 10) for i in range(50)]
        + [_lead(f"$$money{i}", "personal finance", score=i / 100) for i in range(15)]
    )
    written = build_batches(leads, out_dir=tmp_path, batch_size=20)
    fitness = sorted((tmp_path / "fitness").glob("batch_*.csv"))
    finance = sorted((tmp_path / "personal-finance").glob("batch_*.csv"))
    assert len(fitness) == 3  # 20+20+10
    assert len(finance) == 1
    assert len(written) == 4


def test_build_batches_skips_no_email(tmp_path: Path) -> None:
    leads = [
        _lead("a", "fitness", email="a@a.com"),
        _lead("b", "fitness", email=""),
    ]
    paths = build_batches(leads, out_dir=tmp_path, batch_size=25)
    assert len(paths) == 1
    contents = paths[0].read_text()
    assert "a@a.com" in contents
    assert "b@" not in contents
