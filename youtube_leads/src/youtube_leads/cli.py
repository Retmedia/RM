from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

from youtube_leads.campaigns import build_batches
from youtube_leads.config import configure_logging, load_settings
from youtube_leads.exporters import export_csv, export_json
from youtube_leads.http import HttpClient
from youtube_leads.notion import NotionSync
from youtube_leads.pipeline import LeadPipeline
from youtube_leads.storage import LeadStore

log = logging.getLogger("youtube_leads")


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="youtube-leads",
        description="Discover YouTube creators and prepare outreach lead lists.",
    )
    p.add_argument("--db", help="Path to SQLite store (overrides LEADS_DB_PATH).")
    p.add_argument("--log-level", default=None, help="DEBUG/INFO/WARNING/ERROR")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="Discover and enrich channels by niche keyword.")
    s.add_argument("query", help="Niche / keyword(s), e.g. 'fitness'")
    s.add_argument("count", nargs="?", type=int, default=50, help="Max channels (default 50)")
    s.add_argument("--min-subs", type=int, default=200_000)
    s.add_argument("--days-active", type=int, default=90)
    s.add_argument("--max-pages", type=int, default=4)
    s.add_argument("--no-enrich", action="store_true", help="Skip email enrichment")

    e = sub.add_parser("enrich", help="Enrich stored channels missing an email.")
    e.add_argument("--niche")
    e.add_argument("--limit", type=int)

    x = sub.add_parser("export", help="Export leads to CSV/JSON.")
    # support both `export new leads` and `export --status new`
    x.add_argument("positional", nargs="*", help="Optional shorthand: 'new leads', 'contacted', etc.")
    x.add_argument("--format", choices=("csv", "json"), default="csv")
    x.add_argument("--status", help="new | contacted | replied | closed")
    x.add_argument("--niche")
    x.add_argument("--require-email", action="store_true", default=True)
    x.add_argument("--include-no-email", dest="require_email", action="store_false")
    x.add_argument("--out", help="Output file path")
    x.add_argument("--limit", type=int)

    c = sub.add_parser("campaign", help="Build BCC-ready campaign batches.")
    c.add_argument("--niche")
    c.add_argument("--batch-size", type=int, default=25)
    c.add_argument("--out", default="exports/campaigns")

    n = sub.add_parser("notion-sync", help="Push leads into a Notion database.")
    n.add_argument("--niche")
    n.add_argument("--limit", type=int)
    n.add_argument("--require-email", action="store_true", default=True)
    n.add_argument("--include-no-email", dest="require_email", action="store_false")

    m = sub.add_parser("mark", help="Update outreach status on a channel.")
    m.add_argument("channel_id")
    m.add_argument("status", choices=("new", "contacted", "replied", "closed"))
    m.add_argument("--note")
    m.add_argument(
        "--contacted-now",
        action="store_true",
        help="Set last_contacted_at to now",
    )

    sub.add_parser("stats", help="Print quick counts.")

    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    settings = load_settings()
    configure_logging(args.log_level or settings.log_level)
    if args.db:
        settings = dataclasses.replace(settings, db_path=Path(args.db))

    store = LeadStore(settings.db_path)

    if args.cmd == "search":
        return _cmd_search(args, settings, store)
    if args.cmd == "enrich":
        return _cmd_enrich(args, settings, store)
    if args.cmd == "export":
        return _cmd_export(args, store)
    if args.cmd == "campaign":
        return _cmd_campaign(args, store)
    if args.cmd == "notion-sync":
        return _cmd_notion(args, settings, store)
    if args.cmd == "mark":
        return _cmd_mark(args, store)
    if args.cmd == "stats":
        return _cmd_stats(store)
    return 2


def _cmd_search(args, settings, store) -> int:
    if not settings.has_youtube:
        print("error: YOUTUBE_API_KEY is not set (see .env.example)", file=sys.stderr)
        return 2
    pipeline = LeadPipeline(settings, store=store)
    report = pipeline.search(
        args.query,
        max_results=args.count,
        min_subscribers=args.min_subs,
        days_active=args.days_active,
        max_pages=args.max_pages,
        enrich=not args.no_enrich,
    )
    print(
        f"discovered={report.discovered}  new={report.new}  enriched={report.enriched}"
    )
    return 0


def _cmd_enrich(args, settings, store) -> int:
    pipeline = LeadPipeline(settings, store=store)
    n = pipeline.enrich_missing(niche=args.niche, limit=args.limit)
    print(f"enriched {n} channels")
    return 0


def _cmd_export(args, store) -> int:
    status = args.status
    fmt = args.format
    out = args.out
    # shorthand: `export new leads` / `export contacted` / `export new leads json`
    pos = list(args.positional or [])
    while pos:
        tok = pos.pop(0).lower()
        if tok in ("new", "contacted", "replied", "closed") and not status:
            status = tok
        elif tok in ("csv", "json"):
            fmt = tok
        elif tok in ("leads", "lead"):
            continue
        else:
            print(f"warning: ignoring unknown shorthand token {tok!r}", file=sys.stderr)

    leads = store.list_leads(
        niche=args.niche,
        status=status,
        require_email=args.require_email,
        limit=args.limit,
    )
    if not leads:
        print("no leads matched")
        return 0

    if not out:
        ts = datetime.utcnow().strftime("%Y%m%d-%H%M")
        suffix = fmt
        bits = ["leads"]
        if status:
            bits.append(status)
        if args.niche:
            bits.append(args.niche.replace(" ", "-"))
        bits.append(ts)
        out = str(Path("exports") / f"{'-'.join(bits)}.{suffix}")

    out_path = Path(out)
    if fmt == "csv":
        n = export_csv(leads, out_path)
    else:
        n = export_json(leads, out_path)
    print(f"exported {n} leads -> {out_path}")
    return 0


def _cmd_campaign(args, store) -> int:
    leads = store.list_leads(niche=args.niche, require_email=True)
    if not leads:
        print("no leads with emails to batch")
        return 0
    paths = build_batches(leads, out_dir=Path(args.out), batch_size=args.batch_size)
    print(f"wrote {len(paths)} batches under {args.out}")
    return 0


def _cmd_notion(args, settings, store) -> int:
    if not settings.has_notion:
        print(
            "error: NOTION_API_KEY and NOTION_DATABASE_ID must be set",
            file=sys.stderr,
        )
        return 2
    leads = store.list_leads(niche=args.niche, require_email=args.require_email, limit=args.limit)
    if not leads:
        print("no leads to sync")
        return 0
    http = HttpClient(
        user_agent=settings.user_agent,
        timeout=settings.http_timeout,
        max_retries=settings.http_max_retries,
        rate_limit_s=0.34,  # Notion permits ~3 req/sec
    )
    sync = NotionSync(settings.notion_api_key, settings.notion_database_id, http)
    existing = {l.channel.channel_id: store.get_notion_page(l.channel.channel_id) for l in leads}
    existing = {k: v for k, v in existing.items() if v}
    page_ids = sync.upsert_leads(leads, existing_page_ids=existing)
    for cid, pid in page_ids.items():
        store.set_notion_page(cid, pid)
    print(f"synced {len(page_ids)} leads to Notion")
    return 0


def _cmd_mark(args, store) -> int:
    last = datetime.utcnow() if args.contacted_now or args.status == "contacted" else None
    store.set_status(args.channel_id, args.status, last_contacted_at=last, notes=args.note)
    print(f"updated {args.channel_id} -> {args.status}")
    return 0


def _cmd_stats(store) -> int:
    print(json.dumps(store.stats(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
