from __future__ import annotations

import json
import logging
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterable, Iterator

from youtube_leads.models import (
    VALID_STATUSES,
    Channel,
    EmailRecord,
    Lead,
)

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS channels (
    channel_id      TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    url             TEXT NOT NULL,
    subscribers     INTEGER NOT NULL DEFAULT 0,
    description     TEXT,
    country         TEXT,
    niche           TEXT,
    websites_json   TEXT,
    last_video_at   TEXT,
    discovered_at   TEXT NOT NULL,
    score           REAL NOT NULL DEFAULT 0,
    notion_page_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_channels_niche ON channels(niche);
CREATE INDEX IF NOT EXISTS idx_channels_subs  ON channels(subscribers);

CREATE TABLE IF NOT EXISTS emails (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id      TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    source          TEXT NOT NULL,
    source_url      TEXT,
    verified        INTEGER NOT NULL DEFAULT 0,
    discovered_at   TEXT NOT NULL,
    UNIQUE(channel_id, email)
);
CREATE INDEX IF NOT EXISTS idx_emails_channel ON emails(channel_id);

CREATE TABLE IF NOT EXISTS outreach (
    channel_id        TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
    status            TEXT NOT NULL DEFAULT 'new',
    last_contacted_at TEXT,
    notes             TEXT
);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach(status);
"""


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


class LeadStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._tx() as conn:
            conn.executescript(SCHEMA)

    # ---------- channels ----------

    def upsert_channel(self, ch: Channel) -> bool:
        """Insert or update a channel. Returns True if newly inserted."""
        with self._tx() as conn:
            existing = conn.execute(
                "SELECT 1 FROM channels WHERE channel_id = ?", (ch.channel_id,)
            ).fetchone()
            conn.execute(
                """
                INSERT INTO channels (
                    channel_id, name, url, subscribers, description, country,
                    niche, websites_json, last_video_at, discovered_at, score
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(channel_id) DO UPDATE SET
                    name = excluded.name,
                    url = excluded.url,
                    subscribers = excluded.subscribers,
                    description = excluded.description,
                    country = excluded.country,
                    niche = COALESCE(excluded.niche, channels.niche),
                    websites_json = excluded.websites_json,
                    last_video_at = excluded.last_video_at,
                    score = excluded.score
                """,
                (
                    ch.channel_id,
                    ch.name,
                    ch.url,
                    ch.subscribers,
                    ch.description,
                    ch.country,
                    ch.niche,
                    json.dumps(ch.websites or []),
                    _iso(ch.last_video_at),
                    _iso(ch.discovered_at),
                    ch.score,
                ),
            )
            conn.execute(
                "INSERT OR IGNORE INTO outreach (channel_id, status) VALUES (?, 'new')",
                (ch.channel_id,),
            )
            return existing is None

    def set_score(self, channel_id: str, score: float) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE channels SET score = ? WHERE channel_id = ?",
                (score, channel_id),
            )

    def get_channel(self, channel_id: str) -> Channel | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM channels WHERE channel_id = ?", (channel_id,)
            ).fetchone()
        return _row_to_channel(row) if row else None

    def channels_missing_email(
        self, *, niche: str | None = None, limit: int | None = None
    ) -> list[Channel]:
        sql = """
            SELECT c.* FROM channels c
            LEFT JOIN emails e ON e.channel_id = c.channel_id
            WHERE e.id IS NULL
        """
        args: list = []
        if niche:
            sql += " AND c.niche = ?"
            args.append(niche)
        sql += " ORDER BY c.subscribers DESC"
        if limit:
            sql += " LIMIT ?"
            args.append(limit)
        with self._connect() as conn:
            rows = conn.execute(sql, args).fetchall()
        return [_row_to_channel(r) for r in rows]

    # ---------- emails ----------

    def add_email(self, rec: EmailRecord) -> bool:
        """Insert email record. Returns True if newly stored."""
        with self._tx() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO emails (
                        channel_id, email, source, source_url, verified, discovered_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rec.channel_id,
                        rec.email.lower().strip(),
                        rec.source,
                        rec.source_url,
                        1 if rec.verified else 0,
                        _iso(rec.discovered_at),
                    ),
                )
                return True
            except sqlite3.IntegrityError:
                return False

    def emails_for_channel(self, channel_id: str) -> list[EmailRecord]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM emails WHERE channel_id = ? ORDER BY verified DESC, id ASC",
                (channel_id,),
            ).fetchall()
        return [
            EmailRecord(
                channel_id=r["channel_id"],
                email=r["email"],
                source=r["source"],
                source_url=r["source_url"],
                verified=bool(r["verified"]),
                discovered_at=_parse_dt(r["discovered_at"]) or datetime.utcnow(),
            )
            for r in rows
        ]

    # ---------- outreach ----------

    def set_status(
        self,
        channel_id: str,
        status: str,
        *,
        last_contacted_at: datetime | None = None,
        notes: str | None = None,
    ) -> None:
        if status not in VALID_STATUSES:
            raise ValueError(
                f"invalid status {status!r}; expected one of {VALID_STATUSES}"
            )
        with self._tx() as conn:
            conn.execute(
                """
                INSERT INTO outreach (channel_id, status, last_contacted_at, notes)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(channel_id) DO UPDATE SET
                    status = excluded.status,
                    last_contacted_at = COALESCE(excluded.last_contacted_at, outreach.last_contacted_at),
                    notes = COALESCE(excluded.notes, outreach.notes)
                """,
                (channel_id, status, _iso(last_contacted_at), notes),
            )

    def set_notion_page(self, channel_id: str, page_id: str | None) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE channels SET notion_page_id = ? WHERE channel_id = ?",
                (page_id, channel_id),
            )

    def get_notion_page(self, channel_id: str) -> str | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT notion_page_id FROM channels WHERE channel_id = ?",
                (channel_id,),
            ).fetchone()
        return row["notion_page_id"] if row else None

    # ---------- queries ----------

    def list_leads(
        self,
        *,
        niche: str | None = None,
        status: str | None = None,
        require_email: bool = False,
        limit: int | None = None,
    ) -> list[Lead]:
        sql = """
            SELECT
                c.*,
                o.status              AS o_status,
                o.last_contacted_at   AS o_last,
                e.email               AS e_email,
                e.source              AS e_source,
                e.verified            AS e_verified
            FROM channels c
            LEFT JOIN outreach o ON o.channel_id = c.channel_id
            LEFT JOIN (
                SELECT channel_id, email, source, verified
                FROM emails
                WHERE id IN (
                    SELECT MIN(id) FROM emails GROUP BY channel_id
                )
            ) e ON e.channel_id = c.channel_id
            WHERE 1=1
        """
        args: list = []
        if niche:
            sql += " AND c.niche = ?"
            args.append(niche)
        if status:
            sql += " AND COALESCE(o.status, 'new') = ?"
            args.append(status)
        if require_email:
            sql += " AND e.email IS NOT NULL"
        sql += " ORDER BY c.score DESC, c.subscribers DESC"
        if limit:
            sql += " LIMIT ?"
            args.append(limit)
        with self._connect() as conn:
            rows = conn.execute(sql, args).fetchall()
        out: list[Lead] = []
        for r in rows:
            out.append(
                Lead(
                    channel=_row_to_channel(r),
                    email=r["e_email"],
                    email_source=r["e_source"],
                    status=r["o_status"] or "new",
                    last_contacted_at=_parse_dt(r["o_last"]),
                )
            )
        return out

    def stats(self) -> dict:
        with self._connect() as conn:
            total = conn.execute("SELECT COUNT(*) FROM channels").fetchone()[0]
            with_email = conn.execute(
                "SELECT COUNT(DISTINCT channel_id) FROM emails"
            ).fetchone()[0]
            by_niche = {
                r["niche"] or "(none)": r["n"]
                for r in conn.execute(
                    "SELECT niche, COUNT(*) AS n FROM channels GROUP BY niche"
                ).fetchall()
            }
            by_status = {
                r["status"]: r["n"]
                for r in conn.execute(
                    "SELECT status, COUNT(*) AS n FROM outreach GROUP BY status"
                ).fetchall()
            }
        return {
            "channels_total": total,
            "channels_with_email": with_email,
            "by_niche": by_niche,
            "by_status": by_status,
        }


def _row_to_channel(row: sqlite3.Row) -> Channel:
    websites = []
    if row["websites_json"]:
        try:
            websites = json.loads(row["websites_json"]) or []
        except json.JSONDecodeError:
            websites = []
    return Channel(
        channel_id=row["channel_id"],
        name=row["name"],
        url=row["url"],
        subscribers=row["subscribers"] or 0,
        description=row["description"] or "",
        country=row["country"],
        niche=row["niche"],
        websites=websites,
        last_video_at=_parse_dt(row["last_video_at"]),
        discovered_at=_parse_dt(row["discovered_at"]) or datetime.utcnow(),
        score=row["score"] or 0.0,
    )


def iter_lead_dicts(leads: Iterable[Lead]) -> Iterator[dict]:
    for lead in leads:
        yield {
            "name": lead.channel.name,
            "channel": lead.channel.url,
            "channel_id": lead.channel.channel_id,
            "niche": lead.channel.niche or "",
            "subscribers": lead.channel.subscribers,
            "email": lead.email or "",
            "source": lead.email_source or "",
            "status": lead.status,
            "last_contacted": lead.last_contacted_at.isoformat() if lead.last_contacted_at else "",
            "score": round(lead.channel.score, 3),
            "websites": ";".join(lead.channel.websites),
        }
