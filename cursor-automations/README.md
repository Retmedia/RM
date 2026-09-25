# Cursor Automations (Mine)

Recipes in this folder are **not live** until they are **Created in Cursor Mine**. Markdown here is the spec. Mine Create is the deploy.

As of 2026-09-17 several HQ jobs were still RECIPE ONLY (not Created in Mine), including Trybe Daily Invites.

## Required

| Recipe | File | Mine status (2026-09-17) |
| --- | --- | --- |
| Trybe Daily Invites (15/day, midnight ET refresh) | [`trybe-daily-15.md`](trybe-daily-15.md) | **RECIPE ONLY** — Create in Mine. 2026-09-16 login failed; needs a signed-in desk. |
| Blair Facebook Stories (20/day) | [`blair-fb-stories-20.md`](blair-fb-stories-20.md) | **RECIPE ONLY** as of 2026-09-25. Create in Mine. Blocked until the Page token and Page ID are on the machine (not in git). |

Blair Facebook Stories republishes existing Page videos into Stories only: 20 a day, Facebook posts only, 10,000 or more views, from 2026-01-01 PT, oldest first. Publisher and mock tests sit next to the recipe. They are not live until Mine Create.

Other HQ lanes mentioned in the snapshot (Lucas YT→FB, Blair YT long, fill_loop babysit, Xander long, Dylan lanes) still need recipes and Mine Create if they are not already in Mine. Do not invent new Grok routines for them.

## Rules

- Prefer Cursor Mine timers. Grok may direct; Grok must not grow new server routines.
- Failures email Garrett (info@).
- No passwords, tokens, or session files in this repo.
- HQ timezone for calendars is America/Los_Angeles. Trybe credits refresh midnight ET.

## Source

[`../context/ops-snapshot-2026-09-17.md`](../context/ops-snapshot-2026-09-17.md)  
[`../context/commercial-locks.md`](../context/commercial-locks.md)  
[`../context/hands-off.md`](../context/hands-off.md) — no new Grok routines, Trybe password stays out of the repo.
