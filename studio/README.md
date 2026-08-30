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
npm start                     # http://localhost:4400
```

The first visit asks you to create the owner account. That route closes for good
once someone exists, so it cannot be used to mint a second admin later.

```bash
npm test                      # 63 tests, no network, no fixtures to maintain
npm run preflight             # says whether this can go live, and what is missing
npm run backup                # snapshot now
npm run tidy                  # clear media no post points at any more
node scripts/seed.js          # optional: demo creators with test accounts
```

It starts in **dry run**: the whole flow — schedule, queue, publish, retry, approve,
status — runs end to end without touching a real account. Set `STUDIO_DRY_RUN=0` once
the developer apps below are approved; it refuses to start in that mode without
`STUDIO_SECRET`, because that is the key the stored refresh tokens are encrypted with.

## Keeping it alive

Three things break a scheduler months after it is set up, so all three are
handled rather than left to be discovered.

**Connections rot.** Meta's long-lived tokens last about sixty days and *cannot*
renew themselves — someone has to sign in again. TikTok, X and YouTube carry refresh
tokens and can be kept warm. A sweep every half hour renews what it can and flags
what it cannot, a week before it dies, with the fix named. The renewal window is
deliberately narrow: the publisher already refreshes on demand ten minutes before it
uses a token, and TikTok rotates its refresh token on every use, so needless churn is
a way to *lose* an account rather than protect one.

**Data goes.** Every write is atomic, but atomic writes do nothing about a bad edit or
a lying disk. Rotating snapshots are kept (20 by default, at most one per fifteen
minutes). If the live file is ever unreadable the newest good snapshot is restored
automatically and the damaged file kept for inspection — and if nothing can be
restored, it refuses to start rather than presenting an empty studio as a working one.

**Disks fill.** Sixty clips a month with nowhere to go will eventually stop the app
for a reason nobody would guess. `npm run tidy` clears media that no post points at,
taking a snapshot first, and never touches a file a post still expects.

## Timezones

A slot written as `09:00` means **the creator's** nine o'clock, not the server's.
Each creator carries their own zone; new ones inherit `STUDIO_TIMEZONE`. This is not
cosmetic — a box hosted in UTC would otherwise fire a Laguna Beach morning post at
2am, and the drift reverses twice a year at the daylight-saving change. Slot times
are computed by walking the local calendar, so `09:00` stays `09:00` through the
transition and a Sunday slot never lands on a Saturday.

## Signing in

Everyone gets their own account — nothing runs off a shared login, which is the
point if anyone other than you is going to post.

- **Owner** runs the agency: adds and removes people, deletes creators.
- **Manager** does the daily work: plans, composes, publishes, sends invites. Cannot
  change the team or promote themselves.

Sessions are httpOnly `SameSite=Lax` cookies lasting 30 days. Switching someone off
ends their live sessions immediately rather than waiting for a cookie to lapse.
Sign-in throttling is keyed per account, not per IP, so one person fumbling their
password never locks out an office sharing an address.

## Deploying it

It binds to `127.0.0.1` unless told otherwise, so a development run is never
accidentally public. A real deployment needs three things:

1. **A public HTTPS origin.** Every platform demands an HTTPS OAuth callback, Meta
   fetches Instagram media by URL, and creators open invite links from their phones.
   Put a reverse proxy or a tunnel in front — never expose the process directly.
2. `STUDIO_HOST=0.0.0.0` and `STUDIO_PUBLIC_URL=https://your-domain`.
3. Each platform's redirect URI registered as `https://your-domain/auth/<platform>/callback`.

`STUDIO_TRUST_PROXY` is on by default so `req.protocol` and the client IP come from
the forwarding headers; set it to `0` only if nothing sits in front. On SIGTERM the
process finishes in-flight requests before exiting, so a restart never lands
mid-publish.

**One thing to know about media.** Uploaded files are served without a session, because
Meta's servers fetch them and clients open review links without an account. Their
filenames are 64 bits of randomness, which is what keeps them private — treat a media
URL as a secret.

## The thing this solves that nothing else does

Every scheduler asks *you* to connect *your* accounts. That breaks the moment a
client won't raise your role — most sharply on YouTube, where the API only accepts
a token held by an **Owner** and a Manager sees nothing at all.

The API does not require *you* to be the Owner. It requires **the token holder** to
be. The creator already is one.

So Studio inverts the flow: you generate an **invite link**, the creator opens it and
authorises with their own login, and the refresh token that comes back can publish
indefinitely. Nobody is promoted. No password is shared. They revoke it themselves
from their own account settings whenever they like. The same link handles TikTok and
X — which need a per-account tap anyway — so one link finishes a whole creator.

When a connection does come back empty, Studio says which specific thing is wrong
rather than showing an empty list. The YouTube one names the actual cause: this login
is not an Owner, and the fix is an invite rather than a role change.

## What connecting an account actually looks like

The most common expectation is that the software can see the accounts already
signed in on your phone — the four profiles you switch between in the TikTok app,
the channels sitting in your YouTube account picker. Half of that is true, and the
half that isn't is worth knowing before any of this gets built on.

| | One login gives you | Reality |
|---|---|---|
| **Facebook** | Every Page you have a publishing role on | Works exactly as expected. One agency login, all Pages. |
| **Instagram** | Every IG Professional account attached to those Pages | Same login as Facebook. Accounts must be Business/Creator and Page-linked. |
| **YouTube** | The channel you pick at sign-in | Only channels this login reaches **through the API** appear. Manager/Editor granted in Studio -> Settings -> Permissions have no API access at all — **Owner** is the minimum. Send the owner an invite instead of asking to be promoted. |
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
  server.js       HTTP API, default-deny on every /api route
  auth.js         scrypt passwords, sessions, role guards
  store.js        creators, accounts, posts, media — JSON on disk, atomic writes
  connect.js      OAuth handshake, agency-side and creator-side, with PKCE
  cadence.js      posting slots, and the maths that fills them
  publisher.js    fans one post out to its targets, with per-target retry
  scheduler.js    30-second tick, picks up anything due
  insights.js     pulls each platform's numbers back and rolls them up
  platforms/      one adapter per platform, same shape for each
public/
  index.html      the internal app — no build step, no framework
  login.html      sign-in, and first-run owner setup
  invite.html     the creator connects their own accounts here
  review.html     the client approves a post here
test/             42 tests over auth, publishing, approvals, invites, uploads
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

## One more thing worth knowing

Uploads stream to disk and then go straight to the platform with a resumable
transfer — nothing is ever held in memory whole. So there is no file-size ceiling of
Studio's own making: a long YouTube cut is not capped the way a hosted scheduler caps
it. Whatever the platform itself accepts, this accepts, up to
`STUDIO_MAX_UPLOAD_MB` (2GB by default).

## Editing a post

Caption, time and destinations can all be changed after the fact. An account that
already published is locked, so an edit cannot re-send it.

One rule worth knowing: **changing the caption or the media on an approved post
withdraws the approval** and mints a new review link. The client said yes to what
they were shown; changing the words after that means their yes no longer covers what
would go out. Moving only the time leaves the approval standing.

## Things that were wrong, and now are not

Written down because each one is a trap worth knowing about if this is ever
extended.

- **A post could publish twice.** The scheduler tick and someone clicking Publish
  could both pick up the same due post, both read a target as still pending, and
  both send it — two live posts on the client's account, one recorded here. There is
  now one publish run per post at a time, and a target is claimed before any awaiting
  happens.
- **An approved post could be stranded.** Hitting Publish before the client answered
  moved the post to `awaiting_approval`, a state nothing then picked up — so
  approving it did nothing and it never went out.
- **Slot times used the server's clock.** See Timezones above.
- **A send interrupted by a restart is genuinely ambiguous** — it may or may not have
  reached the platform. Retrying risks a double post and dropping it loses the post,
  so it is flagged as `needs_check` for a person rather than guessed at.
- **Missing media failed misleadingly.** A post referencing a file that had gone was
  reported as "needs at least one photo" rather than naming the real cause.

## Not built yet

Instagram Stories, TikTok photo posts, LinkedIn and Threads, drag-to-drop in the
planner, per-creator caption templates, follower-count tracking over time, and email
alerts when something fails (failures surface on Today, but only if someone looks).
The adapter shape is where the new networks land.

## On storage

Storage is a JSON file with serialized atomic writes, snapshots and automatic
recovery. That is the right answer for one process and an agency-sized roster, and
deliberately not Postgres: a managed database is real ops burden for a solo operator,
and it would not have prevented any bug found so far.

The trigger to move is a second process — two of these writing one file will corrupt
it, and no amount of care in this codebase prevents that. Everything else is already
stateless, so the swap is contained to `store.js`. Until then, the honest risk is a
single machine, which snapshots plus an off-box copy of `.studio-data/backups` covers.
