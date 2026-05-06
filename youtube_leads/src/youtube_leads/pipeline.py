from __future__ import annotations

import logging
from dataclasses import dataclass

from youtube_leads.config import Settings
from youtube_leads.enrichment import build_providers, domain_of
from youtube_leads.http import HttpClient
from youtube_leads.models import Channel, EmailRecord
from youtube_leads.scoring import score_lead
from youtube_leads.scraper import WebsiteEmailFinder, best_email
from youtube_leads.storage import LeadStore
from youtube_leads.youtube import YouTubeClient

log = logging.getLogger(__name__)


@dataclass
class SearchReport:
    discovered: int = 0
    new: int = 0
    enriched: int = 0


class LeadPipeline:
    def __init__(self, settings: Settings, store: LeadStore | None = None) -> None:
        self.settings = settings
        self.store = store or LeadStore(settings.db_path)
        self.http = HttpClient(
            user_agent=settings.user_agent,
            timeout=settings.http_timeout,
            max_retries=settings.http_max_retries,
            rate_limit_s=1.0,
        )
        self.youtube = (
            YouTubeClient(settings.youtube_api_key, self.http)
            if settings.has_youtube
            else None
        )
        self.scraper = WebsiteEmailFinder(self.http)
        self.providers = build_providers(
            http=self.http,
            hunter_key=settings.hunter_api_key,
            apollo_key=settings.apollo_api_key,
            clearbit_key=settings.clearbit_api_key,
        )

    # ---------- search ----------

    def search(
        self,
        query: str,
        *,
        max_results: int = 50,
        min_subscribers: int = 200_000,
        days_active: int = 90,
        max_pages: int = 4,
        enrich: bool = True,
    ) -> SearchReport:
        if not self.youtube:
            raise RuntimeError("YOUTUBE_API_KEY not configured")
        report = SearchReport()
        log.info("searching YouTube for %r (target=%d, min_subs=%d)", query, max_results, min_subscribers)
        for ch in self.youtube.discover_channels(
            query,
            min_subscribers=min_subscribers,
            days_active=days_active,
            max_pages=max_pages,
        ):
            if report.discovered >= max_results:
                break
            report.discovered += 1
            inserted = self.store.upsert_channel(ch)
            if inserted:
                report.new += 1
            if enrich:
                got = self.enrich_channel(ch)
                if got:
                    report.enriched += 1
            self._rescore(ch)
        log.info(
            "search done: discovered=%d new=%d enriched=%d",
            report.discovered, report.new, report.enriched,
        )
        return report

    # ---------- enrichment ----------

    def enrich_missing(self, *, niche: str | None = None, limit: int | None = None) -> int:
        targets = self.store.channels_missing_email(niche=niche, limit=limit)
        log.info("enriching %d channels missing email", len(targets))
        n = 0
        for ch in targets:
            if self.enrich_channel(ch):
                n += 1
            self._rescore(ch)
        return n

    def enrich_channel(self, ch: Channel) -> bool:
        """Try website scraping then API providers. Returns True if any email added."""
        added = False
        domains_seen: set[str] = set()
        for site in ch.websites or []:
            d = domain_of(site)
            if not d or d in domains_seen:
                continue
            domains_seen.add(d)
            results = self.scraper.find_for(site)
            if not results:
                continue
            chosen = best_email({r.email for r in results}, domain=d)
            for r in results:
                rec = EmailRecord(
                    channel_id=ch.channel_id,
                    email=r.email,
                    source="website",
                    source_url=r.source_url,
                    verified=False,
                )
                if self.store.add_email(rec):
                    added = True
            if chosen:
                log.info("website hit for %s: %s", ch.name, chosen)
                # one solid result is enough; skip remaining linked sites
                break

        if added:
            return True

        for d in domains_seen or _domains_from(ch):
            for provider in self.providers:
                try:
                    enriched = provider.find_emails_for_domain(d)
                except Exception as exc:
                    log.warning("%s failed for %s: %s", provider.name, d, exc)
                    continue
                for em in enriched:
                    rec = EmailRecord(
                        channel_id=ch.channel_id,
                        email=em.email,
                        source=em.source,
                        source_url=em.source_url,
                        verified=em.verified,
                    )
                    if self.store.add_email(rec):
                        added = True
                if added:
                    log.info("%s hit for %s @ %s", provider.name, ch.name, d)
                    break  # don't burn quota across providers once we have one
            if added:
                break
        return added

    # ---------- scoring ----------

    def _rescore(self, ch: Channel) -> None:
        emails = self.store.emails_for_channel(ch.channel_id)
        score = score_lead(ch, has_email=bool(emails), niche=ch.niche)
        self.store.set_score(ch.channel_id, score)


def _domains_from(ch: Channel) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for site in ch.websites or []:
        d = domain_of(site)
        if d and d not in seen:
            seen.add(d)
            out.append(d)
    return out
