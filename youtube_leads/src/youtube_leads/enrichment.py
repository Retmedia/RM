from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlparse

from youtube_leads.http import HttpClient

log = logging.getLogger(__name__)


@dataclass
class EnrichedEmail:
    email: str
    source: str        # 'hunter' | 'apollo' | 'clearbit'
    source_url: str | None = None
    verified: bool = False


class EnrichmentProvider(Protocol):
    name: str

    def find_emails_for_domain(self, domain: str) -> list[EnrichedEmail]: ...


def domain_of(url: str) -> str | None:
    host = urlparse(url).netloc.lower()
    if not host:
        return None
    if host.startswith("www."):
        host = host[4:]
    return host or None


# ---------------- Hunter.io ----------------

class HunterProvider:
    name = "hunter"

    def __init__(self, api_key: str, http: HttpClient) -> None:
        self._key = api_key
        self._http = http

    def find_emails_for_domain(self, domain: str) -> list[EnrichedEmail]:
        if not self._key or not domain:
            return []
        try:
            resp = self._http.get(
                "https://api.hunter.io/v2/domain-search",
                params={"domain": domain, "api_key": self._key, "limit": 10},
            )
        except Exception as exc:
            log.warning("hunter domain-search %s failed: %s", domain, exc)
            return []
        if resp.status_code != 200:
            log.warning(
                "hunter domain-search %s -> %s: %s",
                domain, resp.status_code, resp.text[:200],
            )
            return []
        body = resp.json().get("data", {}) or {}
        out: list[EnrichedEmail] = []
        for entry in body.get("emails", []) or []:
            email = (entry.get("value") or "").strip().lower()
            if not email:
                continue
            verified = (entry.get("verification") or {}).get("status") == "valid" or (
                entry.get("confidence") or 0
            ) >= 80
            out.append(
                EnrichedEmail(
                    email=email,
                    source=self.name,
                    source_url=f"https://hunter.io/?domain={domain}",
                    verified=bool(verified),
                )
            )
        return out


# ---------------- Apollo (stub-ish) ----------------

class ApolloProvider:
    """
    Apollo's people/organization search uses POST endpoints and varies by plan.
    We expose the smallest working query (organization/search) and only return
    publicly listed business emails. The endpoint is left configurable.
    """

    name = "apollo"

    def __init__(self, api_key: str, http: HttpClient) -> None:
        self._key = api_key
        self._http = http

    def find_emails_for_domain(self, domain: str) -> list[EnrichedEmail]:
        if not self._key or not domain:
            return []
        try:
            resp = self._http.post(
                "https://api.apollo.io/v1/mixed_people/search",
                json={
                    "q_organization_domains": domain,
                    "page": 1,
                    "per_page": 5,
                },
                headers={
                    "Cache-Control": "no-cache",
                    "Content-Type": "application/json",
                    "X-Api-Key": self._key,
                },
            )
        except Exception as exc:
            log.warning("apollo search %s failed: %s", domain, exc)
            return []
        if resp.status_code != 200:
            log.warning(
                "apollo search %s -> %s: %s",
                domain, resp.status_code, resp.text[:200],
            )
            return []
        body = resp.json() or {}
        out: list[EnrichedEmail] = []
        for person in body.get("people", []) or []:
            email = (person.get("email") or "").strip().lower()
            if not email or email == "email_not_unlocked@domain.com":
                continue
            out.append(
                EnrichedEmail(
                    email=email,
                    source=self.name,
                    source_url=f"https://app.apollo.io/#/people?qOrganizationDomains={domain}",
                    verified=person.get("email_status") == "verified",
                )
            )
        return out


# ---------------- Clearbit (best-effort) ----------------

class ClearbitProvider:
    """
    Uses Clearbit Prospector-style domain → people lookup. Many Clearbit
    endpoints have moved behind HubSpot; if your key doesn't authorize this
    endpoint, the provider just no-ops.
    """

    name = "clearbit"

    def __init__(self, api_key: str, http: HttpClient) -> None:
        self._key = api_key
        self._http = http

    def find_emails_for_domain(self, domain: str) -> list[EnrichedEmail]:
        if not self._key or not domain:
            return []
        try:
            resp = self._http.get(
                "https://prospector.clearbit.com/v1/people/search",
                params={"domain": domain, "limit": 5, "email": "true"},
                headers={"Authorization": f"Bearer {self._key}"},
            )
        except Exception as exc:
            log.warning("clearbit prospector %s failed: %s", domain, exc)
            return []
        if resp.status_code != 200:
            log.info(
                "clearbit prospector %s -> %s (skipping)",
                domain, resp.status_code,
            )
            return []
        body = resp.json() or {}
        out: list[EnrichedEmail] = []
        for person in body.get("results", []) or body.get("people", []) or []:
            email = (person.get("email") or "").strip().lower()
            if not email:
                continue
            out.append(
                EnrichedEmail(
                    email=email,
                    source=self.name,
                    source_url=f"https://clearbit.com/{domain}",
                    verified=False,
                )
            )
        return out


def build_providers(
    *,
    http: HttpClient,
    hunter_key: str | None,
    apollo_key: str | None,
    clearbit_key: str | None,
) -> list[EnrichmentProvider]:
    providers: list[EnrichmentProvider] = []
    if hunter_key:
        providers.append(HunterProvider(hunter_key, http))
    if apollo_key:
        providers.append(ApolloProvider(apollo_key, http))
    if clearbit_key:
        providers.append(ClearbitProvider(clearbit_key, http))
    return providers
