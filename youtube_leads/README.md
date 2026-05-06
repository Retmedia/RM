# youtube-leads

A local Python tool that discovers YouTube creators (200K+ subs, recently
active), enriches them with publicly-available business contact emails, and
prepares clean outreach batches.

It does **not** scrape protected YouTube emails or bypass captchas. Email
discovery only goes through:

1. URLs the creator linked in their public channel description.
2. Publicly readable contact / footer pages on those websites.
3. Optional API enrichment (Hunter.io, Apollo, Clearbit) — keyed by you.

Everything is stored locally in SQLite with deduplication, retries, and
structured logging. CSV / JSON / Notion exports are produced from the same
store, so re-running a search never overwrites existing outreach status.

## Quickstart

```bash
cd youtube_leads
python -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env  # fill in YOUTUBE_API_KEY at minimum
```

Run a discovery + enrichment pass:

```bash
youtube-leads search fitness 50          # niche=fitness, take up to 50 channels
youtube-leads search "personal finance" 100 --min-subs 500000
youtube-leads enrich --niche fitness     # fill emails on already-discovered channels
youtube-leads export new leads           # short form: status=new -> exports/leads.csv
youtube-leads export --status new --niche fitness --format json
youtube-leads campaign --niche fitness --batch-size 25
youtube-leads notion-sync --niche fitness
youtube-leads stats
```

## CLI

| Command | Purpose |
| --- | --- |
| `search <niche> [N]` | Discover up to N channels matching the niche, persist + enrich |
| `enrich [--niche X] [--limit N]` | Re-run email enrichment on stored channels missing an email |
| `export [--format csv\|json] [--status new] [--niche X] [--out PATH]` | Dump leads |
| `campaign [--niche X] [--batch-size 25] [--out exports/campaigns]` | BCC-ready batches |
| `notion-sync [--niche X] [--limit N]` | Push leads into a Notion database |
| `mark <channel_id> <status>` | Update outreach status (`new`, `contacted`, `replied`, `closed`) |
| `stats` | Quick counts by niche / status |

The short forms `search fitness 50` and `export new leads` from the spec are
both supported.

## Filters & defaults

* `--min-subs` (default `200000`)
* `--days-active` (default `90`) — channel must have uploaded a video within
  this many days
* `--max-pages` for the YouTube search (default `4`, i.e. up to 200 raw
  candidates per run)

## Storage schema

SQLite at `./data/leads.db` (override with `LEADS_DB_PATH`). Three tables:

* `channels` — one row per YouTube channel (PK `channel_id`)
* `emails` — one row per `(channel_id, email)` pair, with `source` field
* `outreach` — outreach status / last-contacted timestamp per channel

The CSV / JSON exporters join these into a flat lead row.

## Notion database

Create a Notion database with these properties (exact names matter):

| Property | Type |
| --- | --- |
| `Name` | Title |
| `Channel` | URL |
| `Email` | Email |
| `Niche` | Select |
| `Subscribers` | Number |
| `Score` | Number |
| `Outreach status` | Select (`new`, `contacted`, `replied`, `closed`) |
| `Last contacted` | Date |

Share the database with your integration, then put the database ID in
`NOTION_DATABASE_ID`.

## Compliance notes

* Respects YouTube Data API quota; uses the cheapest endpoints where possible
  (search.list once per page, then channels.list / playlistItems.list in
  batched form).
* Uses a clearly identifying `User-Agent`. Override with `USER_AGENT`.
* Honors per-host rate limits (1 req/sec by default) and exponential-backoff
  retries on transient errors.
* Does **not** attempt to access the email-protected "view email" form on
  YouTube. Does **not** solve captchas. Does **not** scrape Google search
  results.

## Lead scoring

`scoring.score_lead` produces a 0-1 score combining:

* Subscriber tier (>5M = 1.0, 1-5M = 0.9, 0.5-1M = 0.7, 0.2-0.5M = 0.4)
* Niche match strength (keyword vs. channel description / title)
* Has email (+0.5 if at least one)
* Has linked website (+0.2)
* Recent activity (+0.3 if a video uploaded in the last 30 days)
