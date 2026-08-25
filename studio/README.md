# RET Studio

A publishing planner built around **creators**, not around one brand.

Buffer and Metricool model an agency as *one brand with many channels*. RET Media is
*many creators, each with their own channels*. Every screen here starts from the
creator: Blair's Instagram, TikTok and Facebook are Blair's, Xander's are Xander's,
and the planner shows one swimlane per creator so a week reads at a glance.

## Running it

```bash
cd studio
npm install
cp .env.example .env          # set STUDIO_SECRET at minimum
node scripts/seed.js          # optional: two demo creators with test accounts
npm start                     # http://localhost:4400
```

It starts in **dry run**: the whole flow — schedule, queue, publish, retry, status —
runs end to end without touching a real account. Set `STUDIO_DRY_RUN=0` once the
developer apps below are approved.

## What connecting an account actually looks like

The most common expectation is that the software can see the accounts already
signed in on your phone — the four profiles you switch between in the TikTok app,
the channels sitting in your YouTube account picker. Half of that is true, and the
half that isn't is worth knowing before any of this gets built on.

| | One login gives you | Reality |
|---|---|---|
| **Facebook** | Every Page you have a publishing role on | Works exactly as expected. One agency login, all Pages. |
| **Instagram** | Every IG Professional account attached to those Pages | Same login as Facebook. Accounts must be Business/Creator and Page-linked. |
| **YouTube** | The channel you pick at sign-in | Google's picker lists every channel you own **or were granted Manager access to**, Brand Accounts included. Run the connect once per channel, pick a different one each time. No extra passwords. |
| **TikTok** | Exactly one account | No API can read the account list inside the phone app — it never leaves the device. Each creator taps Connect once on their own phone, and it holds until revoked. |

So the phone-login shortcut works for Meta and YouTube, and for TikTok it becomes a
one-time tap per creator instead. The Accounts screen states this per platform
rather than burying it.

## What has to exist before it publishes for real

Each platform needs its own developer app, and each has a review gate. These are
the real blockers on a go-live date — the code is ready before the approvals are.

- **Meta** (covers Instagram *and* Facebook, one app): App Review for
  `instagram_content_publish` and `pages_manage_posts`, plus Business Verification.
- **TikTok**: Content Posting API product. Until the app passes audit, everything
  it posts is forced to `SELF_ONLY` (private). Audit is what unlocks public posting.
- **YouTube**: Google Cloud project, YouTube Data API v3, verified OAuth consent
  screen. The real ceiling is quota, not posts: 10,000 units/day and 1,600 per
  upload, so about six uploads a day until you request an increase.

## The three things Buffer does not do

**A posting rhythm per creator, and bulk drops that fill it.** Each creator carries
their own slots — "Mon and Thu, 9am and 5pm". Hand the bulk composer sixty clips and
they become sixty posts landing in the next sixty open slots, in order, each fanned
to every account that creator posts to. Re-running a drop fills the gaps rather than
doubling up, because slots already spoken for are skipped.

**Client approval before anything publishes.** Turn it on per creator and every post
gets a review link: one page, no login, showing the media, the caption, where it is
going and when. The client approves or asks for changes. Nothing unapproved publishes
from any path — not the scheduler, not the Publish button. Asking for changes pulls
the post back to draft; approving puts it back in the queue. Re-opening review after
an edit mints a new link and kills the old one, so a client can never wave through
content they did not see.

**Performance pulled back per creator.** Each adapter knows how to read its own
numbers — Instagram insights, Facebook page insights, TikTok video query, YouTube
statistics. They are cached on the post and refreshed slowly, because a post's
numbers matter over days. In dry run the Performance screen says it has nothing
rather than showing invented figures.

## Layout

```
server/
  server.js       HTTP API
  store.js        creators, accounts, posts, media — JSON on disk, atomic writes
  connect.js      OAuth handshake; one login can return several accounts
  cadence.js      posting slots, and the maths that fills them
  publisher.js    fans one post out to its targets, with per-target retry
  scheduler.js    30-second tick, picks up anything due
  insights.js     pulls each platform's numbers back and rolls them up
  platforms/      one adapter per platform, same shape for each
public/
  index.html      the internal app — no build step, no framework
  review.html     the one page clients see, standalone
```

Every adapter exports `meta`, `authUrl`, `exchangeCode`, `discover`, `validate`,
`publish` and `fetchMetrics`, so the publisher, the scheduler and the UI never branch
on platform. Adding LinkedIn or
Threads means writing one file in `platforms/` and nothing else.

### A few decisions worth knowing

- **Tokens are encrypted at rest** with `STUDIO_SECRET` and never leave the server —
  the API's account objects have the token bundle stripped.
- **One failing platform does not stop the others.** A TikTok rejection leaves the
  Instagram post published; the post is marked `partial` and only the failed target
  retries (1, 5, 20, 60 minutes).
- **Validation happens before scheduling, per platform**, against that platform's
  own rules — so a 130-character first line is flagged as a too-long YouTube title
  at compose time rather than at 6am when the post fires.
- **Captions are written once, overridden per platform** where a platform needs it.

## Not built yet

Instagram Stories, TikTok photo posts, LinkedIn/Threads/X, drag-to-reschedule in the
planner, per-creator caption templates, and follower-count tracking over time. The
adapter shape is where the new networks land.
