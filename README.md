# RET Media (RM)

Agency HQ notes and tools for RET Media.

## HQ ops (start here)

- **Commercial locks (standing):** [`context/commercial-locks.md`](context/commercial-locks.md) — Xander $2k/3mo (month 1 paid), QuickBooks Contracts only (never DocuSign), Lost shelf dead, Smit HOLD, Paulo leave alone, no new Grok routines.
- **Ops snapshot 2026-09-17:** [`context/ops-snapshot-2026-09-17.md`](context/ops-snapshot-2026-09-17.md)
- **Trybe Daily Invites (15/day):** [`cursor-automations/trybe-daily-15.md`](cursor-automations/trybe-daily-15.md) — recipe only until Created in Cursor Mine. See [`cursor-automations/README.md`](cursor-automations/README.md).

Do not put passwords or tokens in this repo. Do not chase Lost, Smit, or Paulo from these notes.

## Blair YouTube to Facebook

Daily Action at 17:00 UTC (9:00am Pacific Standard Time, 10:00am during daylight time). It posts new `@SkidKids` long-form videos to Blair's Facebook page as 1080x1080 square videos. Code and the full notes: [`automations/blair-yt-fb/README.md`](automations/blair-yt-fb/README.md).

Add both repository secrets under **Settings, Secrets and variables, Actions**:

- `FB_PAGE_ID`: numeric Facebook Page id
- `FB_PAGE_ACCESS_TOKEN`: long-lived Page token with `pages_manage_posts`, `pages_read_engagement`, and `publish_video` (also include `pages_show_list`)

Manual run: **Actions**, **Blair YouTube to Facebook**, **Run workflow**. Turn on **Dry run** to skip the upload. The dry run still lists, dedupes, downloads, and encodes, and it still needs the two secrets.

## Other trees in this repo

- [`ekkoarchive/`](ekkoarchive/) — standalone YouTube channel archiver
