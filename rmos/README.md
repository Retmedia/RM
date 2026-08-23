# RM OS

The operating system for RET Media. It holds what has been promised to every
client, turns those promises into a dated week of work, prices that week against
the people who actually exist, and refuses to let anything reach a client account
without passing the person whose job it is to check it.

No dependencies, no build step, no account to sign up for. Node 18 or newer and
one JSON file.

**On a Mac, double-click `RM-OS.command`.** It sets itself up on first run, builds
the board, and opens the dashboard. Nothing else to install.

If macOS says *"RM-OS.command Not Opened — Apple could not verify…"*, click
**Done** (never *Move to Trash*). That is quarantine, applied to everything that
arrives inside a downloaded zip, and it is not a judgement about this file. Clear
it once:

```bash
xattr -cr .        # from the folder this README is in
```

Cloning with git instead of downloading a zip avoids it entirely.

The same thing by hand, from a terminal:

```bash
cd rmos
node cli/rmos.js init            # write the starting state
node cli/rmos.js week --weeks 2  # build this week and the next
node cli/rmos.js pulse           # the founder view
node cli/rmos.js serve           # the dashboard on http://localhost:3940
npm test                         # 26 tests over the rules that matter
```

Generating a week never dates work into the past — install on a Thursday and you
get the rest of that week, not a board that is already late. `--backfill`
reconstructs a past week deliberately.

## What problem this solves

The agency plan says four things that no task board enforces on its own:

- One editor carries the flagship. **The board proves it fits before the week
  starts**, instead of finding out on Thursday.
- Nothing posts without passing Olivia. **The gate is a state, not a habit** —
  the editor cannot wave their own work through, and during the freeze on Man
  Eats Wild nobody can, including Garrett.
- Two interns are capped by skill. **A capped seat cannot be handed work outside
  its cap**, so the bench never looks deeper on a chart than it is in practice.
- Access is still on personal logins. **Access is a tracked asset** with an owner,
  an expiry and an alert, because it stops work without ever appearing as a task.

The first thing it tells you, out of the box, is that Olivia is at 134% of a
part-time week and that moving Foreign Waters off her — and only that — brings her
to 63%. That is the same conclusion the org plan reached. The difference is that
this recomputes it every Monday against whatever is actually on the books.

## The pieces

| | |
| --- | --- |
| **Seat** | A person or an open role, with real hours per week and any skill caps. |
| **Account** | A client. Carries the gate, the gatekeeper, and a rework rate. |
| **Work line** | A standing promise: *three TikToks a day for Man Eats Wild*. Not a task — the rule that produces tasks. |
| **Job** | One dated deliverable, generated from a work line, moving through states. |
| **Access grant** | Who holds which platform, at what level, expiring when. |
| **Standard** | The written checklist for what "good" means, attached to the work lines it governs. |

## How work moves

```
footage → editing → senior review → gate → scheduled → posted
```

Which of those a deliverable passes through depends on its route:

- `full` — all six. Man Eats Wild, Xander.
- `lite` — editing, gate, scheduled, posted. Blair, Lucas.
- `direct` — no gate. Julia's real estate, where one person is end to end.
- `standing` — no dated deliverable at all. Reserves capacity and nothing else.

States cannot be skipped, posted work is terminal, and blocked work remembers
where it stopped. Every transition goes through one function, so the rules cannot
be walked around by using the dashboard instead of the CLI.

## The three numbers capacity counts

Leave any of them out and the week looks fine until Wednesday:

1. **Production** — the minutes on dated jobs.
2. **Rework** — the share that comes back for a second pass, per account. Man
   Eats Wild is set at 25% because it is still onboarding.
3. **Review** — the gate. It scales with everybody else's output, which is why
   the bottleneck is invisible on a normal board. Eight minutes per Man Eats Wild
   deliverable is nearly six hours a week on its own.

When a seat is over, `rmos relief <seat>` separates what can move from what
cannot. Most of Olivia's Man Eats Wild load is her gate, and a gate does not move
when the account does — it moves only if the gatekeeper changes, which is a
different decision with a different cost.

## Daily

```bash
rmos pulse                      # what needs you, in order
rmos brief olivia               # one person's day
rmos board --owner viktor       # the live board, filtered
rmos alerts --severity high     # what is actually on fire
rmos week --weeks 2             # build a fortnight ahead
rmos move <job> gate --as senior
rmos post <job> --as olivia     # marks it published and logs the delivery
```

`rmos --help` lists the rest. `rmos doctor` checks the whole store for
contradictions and is worth running after any hand edit.

## Automation

```bash
automation/install-cron.sh
```

- **Monday 07:00** — build the week, and say plainly if it does not fit.
- **Weekdays 07:30** — briefs for every seat, alerts, and a digest.

Both write markdown into `data/briefs/` and print to stdout so cron can mail it.
Set `RMOS_WEBHOOK` and the digest is POSTed as JSON to Slack, an email relay, or
anything else that accepts a webhook. See `docs/AUTOMATION.md`.

## Layout

```
RM-OS.command   double-click launcher for macOS
server/         db, seed, and the HTTP API
  domain/       pipeline, scheduler, capacity, alerts, brief
public/         the dashboard — vanilla, theme-aware, no framework
cli/rmos.js     the command line
automation/     the cron jobs
test/run.js     the rules, as tests
docs/           the written system that surrounds the software
data/rmos.json  everything (set RMOS_DB to move it)
```

The store is one JSON file written atomically. A few hundred records does not
need a database server, and a single file is something you can open, read, and
back up by copying.
