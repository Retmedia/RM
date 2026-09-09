# Cadent

One desk for every creator brand. Clients connect their own accounts from their own phone.

Node 18+, no dependencies, one JSON file for storage.

```bash
npm run seed          # six demo creators
CADENT_PASSWORD=... npm start
open http://127.0.0.1:3941
```

## The two screens

**`/g?t=TOKEN` — the grant page.** This is the product. A creator opens it on their phone
and taps Connect on each account they want handled. Built for one hand, one thumb, and
someone who is deciding whether to trust you:

- Their first name in the headline, so it reads as sent to them, not blasted.
- Three plain promises above the fold: no password, they stay owner, link is theirs only.
- One card per platform. Connected accounts collapse to a single line, so the page gets
  shorter as they make progress rather than longer.
- YouTube carries a "Who has to tap this?" disclosure, because Google only ever grants the
  channel of whoever taps Allow. A Studio Editor cannot finish that OAuth, and finding out
  after three taps is the worst version of this page.
- Cadence and routes appear only once something is connected. Routes are built from
  accounts that are actually connected, so nobody can schedule a post to a place we
  cannot reach.

**`/` — the operator desk.** One login, every brand. Status pills per platform, the
creator's current schedule, and the grant link with Copy as the primary button, because
sending that link is the job.

## What is real and what is not

Every platform is on **setup mode** until two things are true: the app credentials exist,
and the platform's review has landed. Both screens say so out loud rather than pretending.

| Platform  | Needs | Flip on with |
|-----------|-------|--------------|
| YouTube   | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, Google OAuth verification | `YOUTUBE_LIVE=1` |
| TikTok    | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, TikTok app audit | `TIKTOK_LIVE=1` |
| Facebook  | `META_APP_ID`, `META_APP_SECRET`, Meta App Review | `META_LIVE=1` |
| Instagram | same Meta app and review | `META_LIVE=1` |

`npm run preflight` prints exactly what is missing.

Grant links have to open on a client's phone, so `STUDIO_ORIGIN` must be a public HTTPS
URL before any of this leaves your laptop.

## Wiring up live posting

`POST /api/grant/connect` is the seam. In setup mode it records the creator's choice. Once
a platform is live it returns `{ mode: 'live', authUrl }` and the page redirects there.
`/api/oauth/start` currently answers 501; drop the real OAuth start/callback in behind that
path and the front end needs no changes.

## Rules this holds to

- Tokens attach to one creator. Minting a new grant link retires the previous one.
- Disconnecting a platform drops any route that pointed at it, so a saved schedule can
  never reference an account we lost.
- The grant token is not a session. It can read and change that one creator and nothing else.
- Single process. The JSON snapshot is written by rename; two writers would race it. Move
  to SQLite in `src/store.js` before running more than one.
- No browser automation, no client passwords, no posting on someone's behalf without
  a token they granted.

## Env

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3941` | |
| `STUDIO_ORIGIN` | `http://127.0.0.1:PORT` | must be public HTTPS in production |
| `CADENT_PASSWORD` | `changeme` | operator login, set it |
| `CADENT_BRAND` | `Cadent` | name shown to clients |
