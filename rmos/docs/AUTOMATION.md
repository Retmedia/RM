# What runs on its own

Two cron jobs and a webhook. Everything else is on demand.

```bash
automation/install-cron.sh    # idempotent — safe to re-run after moving the checkout
```

| When | What | Output |
| --- | --- | --- |
| Monday 07:00 | `run.js weekly` — build the week from the standing commitments, price it | `data/briefs/<ISO-week>.md`, stdout, webhook |
| Weekdays 07:30 | `run.js daily` — briefs for every seat, alerts, digest | `data/briefs/<date>/*`, stdout, webhook |

Both print to stdout, so cron mails the output if `MAILTO` is set in the crontab.
Both also append to `data/automation.log`.

## The weekly job

Generates a dated deliverable for every unit every work line promises that week.
It is idempotent — a job's id is derived from (work line, day, index), so running
it twice changes nothing, and running it after editing a work line adds only what
is genuinely new. Work already in flight is never touched.

It then prices the week. If a seat is over 100% the output says what to move and
what that move buys, separating load that can be reassigned from gate review that
cannot. That is the whole point of running it on a Monday morning: the week is
made to fit before anybody starts, not after somebody is late.

## The daily job

Writes one brief per seat and a pulse for Garrett. A brief leads with what is
waiting on that person — the gate queue, work from their reports — because that
is the part that is stopping somebody else.

## The webhook

Set `RMOS_WEBHOOK` and each run POSTs JSON. This is how the system reaches Slack,
an email relay, or anything else without needing to know what those are.

```json
{
  "kind": "rmos.daily",
  "on": "2026-08-24",
  "utilization": 71,
  "high": 9,
  "late": 0,
  "inGate": 3,
  "headlines": [{ "title": "Olivia is at 134% for 2026-W35",
                  "action": "Move Foreign Waters off Olivia and the week fits at 63%." }]
}
```

```json
{
  "kind": "rmos.weekly",
  "week": "2026-W35",
  "created": 112,
  "utilization": 71,
  "overloaded": [{ "name": "Olivia", "utilization": 134 }]
}
```

## Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `RMOS_DB` | `data/rmos.json` | Where the store lives. Point it at a synced folder to share it. |
| `RMOS_BRIEFS` | `data/briefs` | Where generated briefs are written. |
| `RMOS_WEBHOOK` | unset | POST target for the digests. |
| `PORT` | `3940` | Dashboard port. Bound to localhost only. |
| `NO_COLOR` | unset | Plain output from the CLI. |

## Wiring it to the tools already in use

The HTTP API is the seam. It is plain JSON over localhost, so anything that can
make a request can drive it.

- **Marking work posted from wherever it is actually posted.** `POST
  /api/jobs/:id/move` with `{"to":"posted","actor":"p_olivia"}`. Until posts are
  marked off, promised-versus-delivered cannot be computed, and that is the number
  that shows an account slipping before the client says anything.
- **QuickBooks.** Retainers and billing days are on the accounts. The monthly
  invoicing itself stays in QuickBooks; this side is the reminder and the check
  that it went.
- **Access chasing.** `POST /api/access/:id` with `{"status":"granted","holder":"agency"}`
  the moment an invite is accepted, which clears the alert.

## When automation is the wrong answer

Do not automate the gate, and do not automate the client conversation about
cadence. Both are judgement, both are the actual job, and a system that
auto-approves work to keep a queue short has removed the only thing protecting
the accounts.
