---
name: rm-access-migration
description: >-
  Moves RET Media's platform access off Garrett's phone and off client personal
  logins into agency custody under info@retmediaagency.com. Covers the 1Password
  vault build-out, Meta partner access (not person invites), keeping the Notion
  Access & Logins register true, and the asks only a client can action. Trigger
  whenever Garrett says "run the access migration", "set up 1Password", "fix the
  access", "get the logins sorted", "who can get into X", "partner access", "the
  iMessage passwords", "the invite is expiring", or names an account that is
  blocked behind a login.
---

# RET Media — access migration

Four of twenty-eight access points are held by the agency. The rest sit on
Garrett's personal devices, inside a client's login, or nowhere anybody wrote
down. This skill moves them, and keeps the register honest while it happens.

The source of truth is the **Access & Logins** database in the Notion RM
Operating System. Read it before doing anything and write every finding back to
it. Never keep a second copy anywhere.

---

## The rule that governs every step

**Never handle a credential value.** Not read, not typed, not repeated, not
stored. That includes passwords sitting in Garrett's iMessage threads, one-time
codes, recovery codes, TOTP seeds, and the 1Password Secret Key.

Build the structure around the secret and hand the secret itself to a human:

> Vault **Foreign Waters** is ready with an item called *Instagram — brand
> account*. Paste the password from the Gianni thread into it, then delete the
> message. I have filled in everything else on the item.

This is not caution for its own sake. The entire point of the migration is to
put credentials somewhere only named humans control. Routing them through a
model on the way there would defeat it.

If a step cannot proceed without a secret, stop and say exactly what is needed
and who has it. Do not improvise around it.

---

## What only Garrett can do

Do not attempt these, and do not wait on them either — work everything else
while they are outstanding.

1. **Create the 1Password account**, set the master password, and store the
   Emergency Kit. Tell him to print it and put it somewhere physical. The Secret
   Key must never appear in a chat, a file, Notion, or a screenshot.
2. **Enter payment details.**
3. **Approve two-factor prompts** during any signup.
4. **The four unblocking clicks** — these are revenue, not admin:
   - Euka email sender registration (Outreach → Email Campaigns). One OAuth
     grant, takes Foreign Waters from ~130 sends a day to 500–1,000.
   - Accept the Lucas Fink Meta portfolio invite **as info@retmediaagency.com**.
   - Euka TikTok social account re-authorisation (Settings → Social accounts),
     overdue since 19 Aug 2026.
   - Send the client asks in Phase 3.

Surface any of these that are still outstanding at the top of every run.

---

## Phase 1 — 1Password structure

Runs after Garrett has created the account and invited the team. Everything here
is structure; no secrets.

**One vault per account**, named exactly as in the Notion Accounts database:
Man Eats Wild · Xander Budnick · Blair Conklin · Foreign Waters · Paulo Prietto ·
Tara Bunker · Lucas Fink · Shane Dorian. Plus **RET Media internal** for
QuickBooks, Google, Notion and the domain.

**Vault access follows the Notion owner field.** Julia gets the two real estate
vaults and nothing else. Kingdon gets Blair. The distribution intern gets Lucas
Fink. Olivia gets all of them. Do not give an intern a vault for an account they
are capped away from — that cap exists in the org model for a reason.

**One item per row** in the Access & Logins database. Fill in everything except
the secret:

- Title matching the register row (e.g. *TikTok Shop Seller Center — Energy Flow*)
- URL, and any ids already recorded (shop_id, business_id, asset_id, brand id)
- **How the 2FA code is obtained** — the field that matters most here. Who is
  reachable, on what number, and what happens when they are not. Example, for
  Energy Flow: *codes go to Gianni, +1 831 277-8854, over iMessage; logging in
  from outside the US triggers extra verification, so he must be awake.*
- Expiry date where one exists, so it can be watched
- A link back to the Notion row

**Ask clients for the TOTP seed, not the code.** When setting up any shared
login, request the authenticator setup QR or secret at the moment 2FA is
configured, and have a human store it in the 1Password item. That is the single
change that ends the "text Gianni for a code" pattern. Asking later usually
means asking them to reset 2FA, so raise it whenever an account is touched
anyway.

---

## Phase 2 — Meta, done properly

The recurring failure is **person invites**, which expire after thirty days and
have already lapsed or nearly lapsed twice. The fix is **partner access** between
the client's business portfolio and RET Media's, which does not expire.

For each of Man Eats Wild, Xander, Blair and Lucas Fink:

1. Open Meta Business Settings and record what is actually there — portfolio id,
   which pages and IG accounts are attached, who currently has access, and any
   pending invite with its expiry date.
2. Where access is missing, prepare the **partner access** request rather than a
   person invite, granted to RET Media's portfolio.
3. Confirm the Instagram account is linked to the business portfolio. Do not
   assume it is because the page is — this is recorded as unverified for Man
   Eats Wild.
4. Write all of it back to the Notion register, including the ids, so the next
   person does not have to rediscover it.

Blair's page access works but nobody recorded whose credential grants it. Find
out and record it; that is a five-minute task that prevents a bad week later.

---

## Phase 3 — the asks only clients can action

Draft these for Garrett to send. Keep them short and specific — every one of
these people is busy and two of them are slow by reputation.

**Mario (Man Eats Wild)** — send before week one, alongside the cadence
conversation:

> Three things to get me set up properly, all quick:
> 1. Meta Business Suite → Business settings → Partners → add RET Media as a
>    partner with access to the page and the Instagram account. Partner access
>    rather than adding me as a person — person invites expire after 30 days.
> 2. YouTube → Settings → Permissions → invite info@retmediaagency.com as
>    **Manager**. Editor can't schedule or see monetisation.
> 3. TikTok login, plus whoever I should text when it asks for a verification
>    code. A login without someone to read the code isn't access.

**Xander** — text, not email (Android, so SMS not iMessage). Keep it tiny and
raise it every check-in until done:

> When you're back — an upload got blocked worldwide on the 28th. Need you to
> whitelist the clips channel in your Content ID settings, otherwise the revenue
> routes away from us both. Two minutes in YouTube Studio.

**Gianni (Foreign Waters)** — the goal is getting the stack out of the iMessage
thread:

> Setting up a proper password vault so I'm not asking you for codes at
> midnight. Can I add the Foreign Waters IG and the TikTok Shop login to it, and
> when 2FA is set up next, share the authenticator setup code rather than the
> one-time code? Means anyone on my side can get in without waking you.

**Julia** — internal, and the fastest win on the board:

> How do you get into Paulo's and Tara's Instagram? Nothing's written down, and
> if you're ever unreachable we'd lose both accounts. Two lines is enough.

**Shane** — only when a course change is already scheduled. Deleting a course
sends a code to shanedorian88@gmail.com that dies in thirty minutes and needs
him at a computer. Coordinate the timing; never assume it can be automated.

---

## Phase 4 — the scheduler

Only after access has landed. A scheduler cannot post to an account nobody can
log into, so buying one first spends money on the wrong problem.

**Metricool** is the pick: it covers TikTok, Instagram, Facebook, YouTube and X,
and prices per brand rather than per seat, which suits eight accounts and a small
team. Verify current pricing and platform support before buying — both move.

Two accounts stay native regardless:

- **Blair — TikTok Studio only.** He posts raw, no edits, no re-encode, HD
  toggle on. Third-party schedulers re-encode. This is a client rule.
- **Man Eats Wild long form — YouTube Studio.** Titles and thumbnails live there.

So Metricool earns its keep on real estate, the Facebook and Instagram mirrors,
and repurposing. Say that plainly rather than implying it replaces everything.

---

## Keeping the register true

Every run ends by updating the Notion Access & Logins database — status, holder,
expiry, and what changed. An access register that is three weeks stale is worse
than none, because people trust it.

Watch these dates without being asked:

- Any Meta grant, thirty days from when it was sent
- Euka's social account authorisation, which expires periodically
- Xander's page access, already flagged as expiring

Report at the end of every run: how many of the twenty-eight items are now
agency-held, what moved, and what is still blocked on a human.

---

## Never

- Read, type, repeat or store a credential, a one-time code, a recovery code, a
  TOTP seed, or the 1Password Secret Key.
- Enter payment details or accept terms on the business's behalf.
- Accept a client invite onto a personal login when the agency address is the
  point of the exercise.
- Grant an intern a vault for an account they are capped away from.
- Delete an iMessage thread, a password, or an access grant. Say what should go
  and let a human do it.
- Record a credential in Notion, in this repo, or in a message. The register
  records *where* a credential lives and *how* a code is obtained — never the
  credential.
