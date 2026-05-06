from __future__ import annotations

import csv
import json
import logging
from pathlib import Path
from typing import Iterable

from youtube_leads.models import Lead
from youtube_leads.storage import iter_lead_dicts

log = logging.getLogger(__name__)

CSV_FIELDS = (
    "name",
    "channel",
    "channel_id",
    "niche",
    "subscribers",
    "email",
    "source",
    "status",
    "last_contacted",
    "score",
    "websites",
)


def export_csv(leads: Iterable[Lead], out_path: Path) -> int:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for row in iter_lead_dicts(leads):
            writer.writerow({k: row.get(k, "") for k in CSV_FIELDS})
            n += 1
    log.info("wrote %d leads to %s", n, out_path)
    return n


def export_json(leads: Iterable[Lead], out_path: Path) -> int:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rows = list(iter_lead_dicts(leads))
    with out_path.open("w", encoding="utf-8") as fh:
        json.dump(rows, fh, indent=2, ensure_ascii=False)
    log.info("wrote %d leads to %s", len(rows), out_path)
    return len(rows)
