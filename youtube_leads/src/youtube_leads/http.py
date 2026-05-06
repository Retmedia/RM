from __future__ import annotations

import logging
import random
import threading
import time
from collections import defaultdict
from typing import Any
from urllib.parse import urlparse

import requests

log = logging.getLogger(__name__)


class RateLimiter:
    """Per-host token bucket: minimum interval between requests to the same host."""

    def __init__(self, min_interval_s: float = 1.0) -> None:
        self._min_interval = float(min_interval_s)
        self._last: dict[str, float] = defaultdict(float)
        self._lock = threading.Lock()

    def wait(self, host: str) -> None:
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last[host]
            wait_for = self._min_interval - elapsed
            if wait_for > 0:
                time.sleep(wait_for)
            self._last[host] = time.monotonic()


class HttpClient:
    """Requests wrapper with retries, exponential backoff, and per-host rate limit."""

    RETRYABLE_STATUS = {429, 500, 502, 503, 504}

    def __init__(
        self,
        user_agent: str,
        timeout: float = 15.0,
        max_retries: int = 4,
        rate_limit_s: float = 1.0,
    ) -> None:
        self._session = requests.Session()
        self._session.headers["User-Agent"] = user_agent
        self._session.headers["Accept-Language"] = "en-US,en;q=0.8"
        self._timeout = timeout
        self._max_retries = max_retries
        self._limiter = RateLimiter(rate_limit_s)

    def request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
        allow_status: tuple[int, ...] = (200,),
    ) -> requests.Response:
        host = urlparse(url).netloc or url
        attempt = 0
        last_exc: Exception | None = None
        while attempt <= self._max_retries:
            self._limiter.wait(host)
            try:
                resp = self._session.request(
                    method,
                    url,
                    params=params,
                    json=json,
                    headers=headers,
                    timeout=timeout or self._timeout,
                )
            except requests.RequestException as exc:
                last_exc = exc
                wait = self._backoff(attempt)
                log.warning("HTTP %s %s failed: %s; retry in %.1fs", method, url, exc, wait)
                time.sleep(wait)
                attempt += 1
                continue

            if resp.status_code in allow_status:
                return resp
            if resp.status_code in self.RETRYABLE_STATUS and attempt < self._max_retries:
                wait = self._retry_after(resp) or self._backoff(attempt)
                log.warning(
                    "HTTP %s %s -> %s; retry in %.1fs",
                    method, url, resp.status_code, wait,
                )
                time.sleep(wait)
                attempt += 1
                continue
            # non-retryable failure: return for caller to inspect
            return resp

        if last_exc:
            raise last_exc
        raise RuntimeError(f"giving up after {self._max_retries} retries: {method} {url}")

    def get(self, url: str, **kwargs: Any) -> requests.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> requests.Response:
        return self.request("POST", url, **kwargs)

    @staticmethod
    def _backoff(attempt: int) -> float:
        # 2s, 4s, 8s, 16s with jitter
        return (2 ** (attempt + 1)) + random.uniform(0, 0.5)

    @staticmethod
    def _retry_after(resp: requests.Response) -> float | None:
        ra = resp.headers.get("Retry-After")
        if not ra:
            return None
        try:
            return float(ra)
        except ValueError:
            return None
