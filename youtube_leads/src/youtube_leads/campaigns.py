from __future__ import annotations

import csv
import logging
from collections import defaultdict
from pathlib import Path
from typing import Iterable

from youtube_leads.models import Lead, chunked

log = logging.getLogger(__name__)


def build_batches(
    leads: Iterable[Lead],
    *,
    out_dir: Path,
    batch_size: int = 25,
) -> list[Path]:
    """Group leads by niche and write BCC-ready CSV batches.

    Files: <out_dir>/<niche>/batch_<n>.csv with columns name,email,channel.
    Returns the list of paths written.
    """
    if batch_size < 1 or batch_size > 50:
        raise ValueError("batch_size must be between 1 and 50")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    by_niche: dict[str, list[Lead]] = defaultdict(list)
    for lead in leads:
        if not lead.email:
            continue
        by_niche[lead.channel.niche or "uncategorized"].append(lead)

    written: list[Path] = []
    for niche, items in by_niche.items():
        # highest score first so the best leads land in batch_1
        items.sort(key=lambda l: (l.channel.score, l.channel.subscribers), reverse=True)
        niche_dir = out_dir / _safe(niche)
        niche_dir.mkdir(parents=True, exist_ok=True)
        for i, batch in enumerate(chunked(items, batch_size), start=1):
            path = niche_dir / f"batch_{i:03d}.csv"
            _write_batch(path, batch)
            written.append(path)
            log.info("wrote campaign batch %s (%d leads)", path, len(batch))
    return written


def _write_batch(path: Path, batch: list[Lead]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["name", "email", "channel", "subscribers", "score"])
        for lead in batch:
            writer.writerow(
                [
                    lead.channel.name,
                    lead.email or "",
                    lead.channel.url,
                    lead.channel.subscribers,
                    round(lead.channel.score, 3),
                ]
            )


def _safe(name: str) -> str:
    keep = "abcdefghijklmnopqrstuvwxyz0123456789-_"
    s = name.strip().lower().replace(" ", "-")
    return "".join(c for c in s if c in keep) or "uncategorized"
