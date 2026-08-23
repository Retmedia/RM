# How RET Media runs

The software enforces the parts of this that can be enforced. This file is the
rest: what to do when the board says something, and who decides what.

---

## The week

**Monday 07:00 — the week is built.** Cron runs `automation/run.js weekly`. Every
standing commitment becomes dated work, and the capacity model says plainly
whether it fits. If it does not, the answer is on the same screen: what to move,
what to shed, and who has room.

**Monday, first thing — the week is made to fit.** This is a decision, and it
happens before anybody starts working, not after somebody is late. Take the
options in this order:

1. **Move a whole account** to a seat with slack. Cleanest, and it survives the
   week. Note that a gate does not move with the account — that is a separate
   decision about who the gatekeeper is.
2. **Shed priority-3 work lines** for the week. Set `active: false`, or drop the
   generated jobs. Say so to the client if it is visible to them.
3. **Renegotiate the cadence** on the account. Slower, permanent, and the right
   answer when the same seat is over three weeks running.

What is never an option is leaving a seat at 130% and hoping. The gap does not
disappear; it comes out of quality, out of somebody's weekend, or out of the gate.

**Every weekday 07:30 — briefs go out.** Each seat gets what is theirs today,
what is waiting on them, and what is flagged. Garrett gets the pulse.

**Every weekday — the gate is cleared before anything new is started.** See below.

**Friday — check delivery against promise.** `rmos accounts` shows promised per
week against scheduled. Anything under 85% two weeks running is a conversation
with the client, initiated by us.

---

## The gate

Nothing reaches a client account without passing the gatekeeper. On Man Eats Wild,
Xander, Blair and Lucas that is Olivia. On Paulo and Tara there is no gate,
because Julia is end to end and the compliance checklist is the gate.

**The software enforces:** only the named gatekeeper can pass or reject. The
editor cannot wave their own work through and neither can Garrett — during the
freeze on Man Eats Wild (to 2026-09-30) there is no override at all.

**What the gatekeeper is checking**, in this order:

1. Is it true to the footage? Captions that overstate what happened get the whole
   account rejected by the client, not just the post. This has already happened
   once on Blair.
2. Does the hook land in the first two seconds?
3. Is the crop and safe area right on the actual platform, not in the editor?
4. Does the standard for this account say anything this cut ignores?
5. Would you be comfortable if the client saw this without the caption?

**Sending it back** is `rmos move <job> gate --as olivia --reject --why "..."`. It
returns to senior review, and the reason is kept on the job. Reasons accumulate
into the standard: three rejections for the same thing means the checklist is
missing a line.

**Queue discipline.** More than eight at the gate, or anything sitting two days,
raises an alert. The gate is the only thing between a rough cut and a client's
feed, so a queue there stops every account at once. Clear it before starting
anything new.

**The deputy rule.** A single gatekeeper with no deputy means every gated account
stops the day that person is unavailable. Name a deputy, write down what they are
allowed to wave through — and what they must hold — and set `deputyId` on the seat.
Until that exists, the alert stays up, and it is correct to stay up.

---

## Taking on a new client

Do these in order. The account is not real until step 6.

1. **Close it** (see the sales playbook). Price against what they already make.
2. **Access, on the call, while they are warm.** Nothing here is done by email
   later — every one of these has been chased for weeks at some point:
   - TikTok: shared login. Suggest a throwaway-tier password.
   - YouTube: they create the channel under their own Google account, then add us
     as **Manager**, not Editor. Editor cannot see the analytics that prove the work.
   - Facebook: Meta Business Suite → page access → invite `info@retmediaagency.com`
     with full task access. **The invite expires in 30 days.**
   - Raw footage: a shared album or folder. iCloud for iPhone, Google Photos for
     Android, Drive or Dropbox otherwise.
   - Book the 30-day re-evaluation date before hanging up.
3. **Record every grant** in the access register with its expiry. Anything on a
   personal login is logged as `personal` and stays flagged until it moves to the
   agency account. That flag is not noise: personal access leaves when the person
   does and cannot be handed to a new hire.
4. **Write the work lines.** What is promised, how often, who owns it, how long
   one unit takes. Be honest about the minutes — the capacity model is only as
   good as these, and optimism here becomes somebody's weekend later.
5. **Check it fits** before confirming the cadence to the client. `rmos capacity`.
   If it does not, the cadence you agree is the one that fits, not the one you
   would like.
6. **Write the standard**, even if it is six lines. An account with no standard is
   an account only one person can run.
7. QuickBooks customer, contract, and recurring invoice. Retainers default to the
   8th of the month so all the recurring billing lands together.

---

## Hiring into a seat

The open seat is the Senior Editor, and the software already knows it is at 94%
on a perfect week before anybody sits in it. Two consequences:

- **Bring the cadence down before the start date**, not after. Ramp is not free
  and it is not in those numbers.
- **Write the role around long form storytelling.** Building a story out of raw
  footage over eight to twenty minutes is the hard part and the part that cannot
  be taught quickly. Someone who can do that can cut a TikTok in their sleep; the
  reverse is not true. Ask for a reel with a story in it, not a montage.

Before the first day: the standard for the account exists (Garrett cuts the first
long form and writes it from that cut), and the backup is named out loud.

**The contingency.** Viktor is the named backup on Man Eats Wild. If the new hire
turns out stronger on volume than on story, swap them — Viktor takes Man Eats
Wild, the new hire takes Xander, and the workflow they inherit is already written
down. That costs one conversation and no money. It only works if Viktor has walked
the workflow once before he needs it; until he has, the alert stays up.

---

## When something goes wrong

**A post went out wrong.** Take it down first, tell the client before they find
it, then find which checklist line would have caught it and add it if it is
missing. Do not add a new approval step — the gate already exists, and a second
gate is how a bottleneck becomes two bottlenecks.

**An account is behind on cadence.** The alert fires at under 85% for a week.
Go to the client before they raise it. Asking for a lighter cadence in week one
reads as planning; missing it silently in week three reads as failure.

**Access lapsed.** Everything on that account stops. Re-invite immediately, and
if it was on a personal login, take the opportunity to move it to the agency
account instead of restoring the same problem.

**A seat is unavailable.** Check who is named as backup. If nobody is, that
account is stopped, and the alert that has been up since the account was created
was telling you this would happen.

---

## Monthly

- **Re-estimate the minutes.** The capacity model is the most useful thing here
  and it decays fastest. Pick the three work lines that felt wrong and fix their
  numbers.
- **Account reviews.** Trials that drift past their review date become free work.
  Xander re-evaluates on 2026-08-31: retainer, revenue split, or a hybrid.
- **Billing.** Recurring invoices on the 8th. Revenue-share numbers when the
  platform figures land — Blair is 35% of platform gross to the agency, and the
  arithmetic gets shown, never eyeballed.
- **Standards.** Any draft still in draft after a month is a decision not to
  write it. Either finish it or delete it and admit the account runs on one
  person's taste.
