from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - dotenv is a runtime dep
    def load_dotenv(*_a, **_kw):  # type: ignore[misc]
        return False


@dataclass(frozen=True)
class Settings:
    youtube_api_key: str | None
    hunter_api_key: str | None
    apollo_api_key: str | None
    clearbit_api_key: str | None
    notion_api_key: str | None
    notion_database_id: str | None
    db_path: Path
    user_agent: str
    http_timeout: float
    http_max_retries: int
    log_level: str

    @property
    def has_youtube(self) -> bool:
        return bool(self.youtube_api_key)

    @property
    def has_notion(self) -> bool:
        return bool(self.notion_api_key and self.notion_database_id)


def load_settings(env_file: str | os.PathLike[str] | None = None) -> Settings:
    if env_file:
        load_dotenv(env_file, override=False)
    else:
        load_dotenv(override=False)

    db_path = Path(os.getenv("LEADS_DB_PATH") or "data/leads.db").expanduser()
    return Settings(
        youtube_api_key=os.getenv("YOUTUBE_API_KEY") or None,
        hunter_api_key=os.getenv("HUNTER_API_KEY") or None,
        apollo_api_key=os.getenv("APOLLO_API_KEY") or None,
        clearbit_api_key=os.getenv("CLEARBIT_API_KEY") or None,
        notion_api_key=os.getenv("NOTION_API_KEY") or None,
        notion_database_id=os.getenv("NOTION_DATABASE_ID") or None,
        db_path=db_path,
        user_agent=os.getenv("USER_AGENT") or "YouTubeLeadsBot/0.1",
        http_timeout=float(os.getenv("HTTP_TIMEOUT") or "15"),
        http_max_retries=int(os.getenv("HTTP_MAX_RETRIES") or "4"),
        log_level=(os.getenv("LOG_LEVEL") or "INFO").upper(),
    )


def configure_logging(level: str = "INFO") -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s :: %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("urllib3").setLevel(logging.WARNING)
