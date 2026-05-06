from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from youtube_leads.http import HttpClient

log = logging.getLogger(__name__)

# RFC-5322-ish but pragmatic. Excludes spaces and angle brackets.
EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+\-])"
    r"([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24})"
    r"(?![A-Za-z0-9._%+\-])"
)

# Common file extensions we mistake for emails (foo@2x.png, etc.)
BAD_LOCAL_PARTS = {"2x", "3x", "image", "img", "icon", "logo"}
BAD_DOMAIN_TLDS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "css", "js"}

# Pages on the same domain we try after the homepage to find a contact email.
CONTACT_PATHS = (
    "/contact",
    "/contact-us",
    "/contact/",
    "/about",
    "/about-us",
    "/about/",
    "/press",
    "/work-with-me",
    "/business",
    "/partnerships",
    "/sponsor",
)


@dataclass
class FoundEmail:
    email: str
    source_url: str


def extract_emails(html: str) -> set[str]:
    """Find plausible business emails in HTML. Decodes obvious obfuscations."""
    if not html:
        return set()
    text = _normalize(html)
    found: set[str] = set()
    for match in EMAIL_RE.finditer(text):
        email = match.group(1).lower().strip(".")
        if _is_plausible(email):
            found.add(email)
    return found


def _normalize(html: str) -> str:
    # Decode the cheap obfuscations: "name [at] example [dot] com", entity-encoded @, etc.
    out = html
    out = out.replace("&#64;", "@").replace("&#46;", ".")
    out = re.sub(r"\s*\[\s*at\s*\]\s*", "@", out, flags=re.IGNORECASE)
    out = re.sub(r"\s*\(\s*at\s*\)\s*", "@", out, flags=re.IGNORECASE)
    out = re.sub(r"\s+at\s+", "@", out)  # aggressive but useful for "name at example dot com"
    out = re.sub(r"\s*\[\s*dot\s*\]\s*", ".", out, flags=re.IGNORECASE)
    out = re.sub(r"\s*\(\s*dot\s*\)\s*", ".", out, flags=re.IGNORECASE)
    out = re.sub(r"\s+dot\s+", ".", out)
    return out


def _is_plausible(email: str) -> bool:
    if "@" not in email:
        return False
    local, _, domain = email.partition("@")
    if not local or not domain:
        return False
    if local.lower() in BAD_LOCAL_PARTS:
        return False
    tld = domain.rsplit(".", 1)[-1].lower()
    if tld in BAD_DOMAIN_TLDS:
        return False
    if "." not in domain:
        return False
    if len(email) > 254:
        return False
    # filter obvious test/noreply addresses
    bad_locals = {"noreply", "no-reply", "donotreply", "do-not-reply", "test", "example"}
    if local.lower() in bad_locals:
        return False
    return True


def best_email(found: set[str], domain: str | None = None) -> str | None:
    """Choose the most useful email from a set. Prefer business-y locals on same domain."""
    if not found:
        return None
    domain = (domain or "").lower()
    preferred_locals = ("business", "partnerships", "press", "media", "contact", "hello", "hi", "team", "info")

    def score(email: str) -> tuple[int, int, str]:
        local, _, dom = email.partition("@")
        same_domain = 1 if domain and dom.endswith(domain) else 0
        local_score = 0
        for i, p in enumerate(preferred_locals):
            if local.lower() == p or local.lower().startswith(p + "@"):
                local_score = len(preferred_locals) - i
                break
        return (same_domain, local_score, email)

    return sorted(found, key=score, reverse=True)[0]


class WebsiteEmailFinder:
    def __init__(self, http: HttpClient, max_pages_per_site: int = 4) -> None:
        self._http = http
        self._max_pages = max_pages_per_site

    def find_for(self, root_url: str) -> list[FoundEmail]:
        """Look for emails on a creator's linked website. Returns list of FoundEmail."""
        try:
            home_resp = self._http.get(root_url, allow_status=(200,))
        except Exception as exc:
            log.info("could not fetch %s: %s", root_url, exc)
            return []
        if home_resp.status_code != 200:
            log.info("skip %s (HTTP %s)", root_url, home_resp.status_code)
            return []

        results: list[FoundEmail] = []
        seen: set[str] = set()
        domain = urlparse(home_resp.url).netloc.lower()

        def consume(page_url: str, html: str) -> None:
            for em in extract_emails(html):
                if em in seen:
                    continue
                seen.add(em)
                results.append(FoundEmail(email=em, source_url=page_url))

        consume(home_resp.url, home_resp.text)

        # Discover candidate contact links from the homepage HTML.
        candidates = list(_discover_contact_links(home_resp.text, home_resp.url))
        for path in CONTACT_PATHS:
            candidates.append(urljoin(home_resp.url, path))
        # Dedupe while preserving order.
        seen_urls: set[str] = {home_resp.url}
        ordered: list[str] = []
        for u in candidates:
            if u in seen_urls:
                continue
            if urlparse(u).netloc.lower() != domain:
                continue
            seen_urls.add(u)
            ordered.append(u)

        for url in ordered[: self._max_pages]:
            try:
                resp = self._http.get(url, allow_status=(200,))
            except Exception as exc:
                log.debug("fetch %s failed: %s", url, exc)
                continue
            if resp.status_code != 200:
                continue
            consume(resp.url, resp.text)
            if results:
                # If we already found something on the homepage, one extra page is enough.
                break
        return results


def _discover_contact_links(html: str, base_url: str):
    soup = BeautifulSoup(html or "", "html.parser")
    for a in soup.find_all("a", href=True):
        href: str = a["href"]
        text = (a.get_text() or "").lower()
        if href.startswith("mailto:"):
            continue
        if any(k in href.lower() for k in ("contact", "about", "press", "partnership", "sponsor", "business")):
            yield urljoin(base_url, href)
            continue
        if any(k in text for k in ("contact", "about", "press", "partnership", "sponsor", "business")):
            yield urljoin(base_url, href)
