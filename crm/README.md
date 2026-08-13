# RET Media Command — gamified CRM

A single-file, self-contained gamified CRM for RET Media LLC. No build, no server, no login.
Open `index.html` in any browser (desktop or phone) and it just runs.

## What it does
- **XP + levels + rank** — you earn XP for advancing deals, closing clients, and clearing quests. Level up = new rank (Rookie Closer → … → Legend of Laguna).
- **Daily quests** — your real follow-ups (Kill Tony, Adas Global, Chosen Advisory whale, collecting outstanding invoices, etc.). Tap to complete, bank the XP.
- **Deal pipeline** — every prospect as a card. Tap a card to push it to the next stage (New → Contacted → Follow-up → Negotiation → Won) and earn XP. Closing a deal pays out big.
- **Your roster** — your 6 won clients as "party members" with rarity tiers and MRR.
- **Achievements** — unlock badges (First Blood, Whale Hunter, $30K Club, Media Mogul…).
- **Live business stats** — MRR, 2026 collected, outstanding A/R, pipeline value.

## Data
Seeded on **2026-08-13** from:
- **Notion** — "Ret Media CRM Prospects and Tasks Tracker" (prospects, statuses, tasks)
- **QuickBooks** — RET MEDIA LLC invoices + recurring billing (revenue, clients, A/R)

Your progress (completed quests, advanced deals, XP, streak, new leads) saves in the
browser via `localStorage` — it's yours and stays on your device.

## Refresh the numbers
The seed is a snapshot. To re-pull live data, ask Claude: **"refresh my CRM data"** —
it will re-query Notion + QuickBooks and update the `SEED` object at the top of the
`<script>` in `index.html`.

## Reset
Open the browser console and run `hardReset()` to wipe progress back to the seed.
