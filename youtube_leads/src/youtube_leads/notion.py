from __future__ import annotations

import logging
from typing import Iterable

from youtube_leads.http import HttpClient
from youtube_leads.models import Lead

log = logging.getLogger(__name__)

NOTION_VERSION = "2022-06-28"
NOTION_API = "https://api.notion.com/v1"


class NotionSync:
    """Push leads into a Notion database. Idempotent on `notion_page_id`.

    Required database properties (exact names):
      Name (title), Channel (url), Email (email), Niche (select),
      Subscribers (number), Score (number),
      Outreach status (select: new/contacted/replied/closed),
      Last contacted (date)
    """

    def __init__(self, api_key: str, database_id: str, http: HttpClient) -> None:
        if not api_key or not database_id:
            raise ValueError("NOTION_API_KEY and NOTION_DATABASE_ID are required")
        self._db = database_id
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        }
        self._http = http

    def upsert_leads(
        self,
        leads: Iterable[Lead],
        *,
        existing_page_ids: dict[str, str] | None = None,
    ) -> dict[str, str]:
        """Create or update a Notion page per lead. Returns {channel_id: page_id}."""
        existing_page_ids = dict(existing_page_ids or {})
        result: dict[str, str] = {}
        for lead in leads:
            cid = lead.channel.channel_id
            page_id = existing_page_ids.get(cid)
            try:
                if page_id:
                    self._update_page(page_id, lead)
                    result[cid] = page_id
                else:
                    new_id = self._create_page(lead)
                    if new_id:
                        result[cid] = new_id
            except Exception as exc:
                log.warning("notion sync failed for %s: %s", cid, exc)
        return result

    # ---- internals ----

    def _create_page(self, lead: Lead) -> str | None:
        body = {
            "parent": {"database_id": self._db},
            "properties": _properties_for(lead),
        }
        resp = self._http.post(f"{NOTION_API}/pages", headers=self._headers, json=body)
        if resp.status_code >= 300:
            log.warning(
                "notion create page %s -> %s: %s",
                lead.channel.channel_id, resp.status_code, resp.text[:300],
            )
            return None
        return (resp.json() or {}).get("id")

    def _update_page(self, page_id: str, lead: Lead) -> None:
        body = {"properties": _properties_for(lead)}
        resp = self._http.request(
            "PATCH",
            f"{NOTION_API}/pages/{page_id}",
            headers=self._headers,
            json=body,
        )
        if resp.status_code >= 300:
            log.warning(
                "notion update page %s -> %s: %s",
                page_id, resp.status_code, resp.text[:300],
            )


def _properties_for(lead: Lead) -> dict:
    ch = lead.channel
    props: dict = {
        "Name": {"title": [{"text": {"content": ch.name[:200]}}]},
        "Channel": {"url": ch.url},
        "Subscribers": {"number": ch.subscribers},
        "Score": {"number": round(ch.score, 3)},
        "Outreach status": {"select": {"name": lead.status}},
    }
    if lead.email:
        props["Email"] = {"email": lead.email}
    if ch.niche:
        props["Niche"] = {"select": {"name": ch.niche[:80]}}
    if lead.last_contacted_at:
        props["Last contacted"] = {"date": {"start": lead.last_contacted_at.date().isoformat()}}
    return props
