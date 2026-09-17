# Trybe Daily Invites (15/day)

**Status:** RECIPE ONLY as of 2026-09-17. Not Created in Cursor Mine.  
**Priority:** CRITICAL for Foreign Waters.  
**Owner:** Foreign Waters agent / Cursor (Olivia is not involved).  
**Failure:** Email Garrett at info@.

Mine Create is required. A signed-in Trybe desk is required. The 2026-09-16 babysit **login failed**; do not assume the Grok server check is healthy.

Do **not** add a new Grok routine for this. Prefer a Cursor Mine timer. Do **not** store the Trybe password in this repo (rotated 2026-09-15).

## Goal

When Trybe invite credits refresh (midnight ET), burn them to **0** the same day. Cap is **15 invites/day**. Do not exceed 15.

## Schedule

- Credit refresh: midnight America/New_York
- Preferred run: shortly after refresh (~12:05am ET)
- HQ calendars stay America/Los_Angeles; this job is ET because that is when credits land
- Timer: Cursor Mine (not a new Grok cron)

## Who to invite

- Brand: **US only**
- Creators: fitness / healthy look
- Skip anyone outside that brief

## Runbook (high level)

1. Confirm the Mine automation is **Created** (not just this markdown recipe) and the desk session is signed in.
2. At refresh, read remaining invite credits.
3. Send invites up to the daily cap (15) or until credits are 0, whichever comes first.
4. Stop. Do not queue a second wave the same day.
5. If login fails, session is expired, or the run cannot complete: **email Garrett (info@)** and stop. Do not retry credentials from the repo (there are none).

## Non-goals

- Do not store passwords, cookies, or tokens here
- Do not involve Olivia / Maxine
- Do not stand up a new Grok server routine
- Do not send Foreign Waters contract/retainer mail unless Garrett names the send (QBO Contracts only)

## Related

- Snapshot: [`../context/ops-snapshot-2026-09-17.md`](../context/ops-snapshot-2026-09-17.md)
- Locks: [`../context/commercial-locks.md`](../context/commercial-locks.md)
- Automations index: [`README.md`](README.md)
