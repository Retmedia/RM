'use strict';
/*
 * The RET Media roster as it actually stands, transcribed from the org blueprint
 * and the client playbooks. This is the starting state only — once the store is
 * written, RM OS is the source of truth and this file is never read again.
 *
 * Minute estimates are per unit of work and are meant to be argued with. They are
 * the numbers the capacity model runs on, so keeping them honest is the single
 * highest-leverage piece of maintenance in the whole system.
 */

/* ---------- seats ---------- */
/* capacityMinutes is production time per week, not hours at a desk. */

const seats = [
  {
    id: 'p_garrett', name: 'Garrett', role: 'Founder', reportsTo: null,
    capacityMinutes: 600, employment: 'owner', status: 'active',
    onlyAccounts: [], email: 'info@retmediaagency.com',
    note: 'Ten production hours a week. The rest is sales, strategy and the hook and title formulas the agency runs on. Cuts the first Man Eats Wild long form himself so a standard exists before anybody is hired into it, then gets out of the line.',
  },
  {
    id: 'p_olivia', name: 'Olivia', role: 'Content Manager', reportsTo: 'p_garrett',
    capacityMinutes: 1200, employment: 'part-time', status: 'starting',
    startDate: '2026-08-31', onlyAccounts: [],
    note: 'The layer between Garrett and the editors. Nothing reaches a client account without passing her. Part time by design, which is exactly why her load has to be watched every week.',
  },
  {
    id: 'p_julia', name: 'Julia', role: 'Account Manager', reportsTo: 'p_garrett',
    capacityMinutes: 1800, employment: 'contract', status: 'active',
    onlyAccounts: ['c_paulo', 'c_tara'], locked: true,
    note: 'Real estate end to end. Outside the editing line, outside the gate. The part of the agency that already works, and the pattern to copy for the next vertical.',
  },
  {
    id: 'p_senior', name: null, role: 'Senior Editor', reportsTo: 'p_olivia',
    capacityMinutes: 2400, employment: 'full-time', status: 'open',
    onlyAccounts: [], openSeat: true,
    note: 'The only hire. Man Eats Wild end to end, long form and the short form pulled from the same session, plus running the two editors underneath. Hire for long form storytelling: someone who can build a story out of raw footage can cut a TikTok in their sleep, and the reverse is not true.',
  },
  {
    id: 'p_viktor', name: 'Viktor', role: 'Editor', reportsTo: 'p_senior',
    capacityMinutes: 1500, employment: 'contract', status: 'active',
    onlyAccounts: [], backupFor: ['c_mew'],
    note: 'Xander end to end, and the named backup on the Man Eats Wild long form. If the new hire turns out stronger on volume than on story, swap the two of them. That costs a conversation and no money, which makes it the cheapest insurance on the board.',
  },
  {
    id: 'p_kingdon', name: 'Kingdon', role: 'Intern Editor', reportsTo: 'p_senior',
    capacityMinutes: 600, employment: 'intern', status: 'active',
    onlyAccounts: ['c_blair'],
    note: 'Capped at Blair by skill. Nothing from Man Eats Wild can land here, and that cap is the reason the new seat has to carry the whole account.',
  },
  {
    id: 'p_intern2', name: null, role: 'Intern, distribution', reportsTo: 'p_olivia',
    capacityMinutes: 480, employment: 'intern', status: 'active',
    onlyAccounts: ['c_lucas'], needsName: true,
    note: 'Capped at Lucas Fink by skill, same as Kingdon. Useful, and not a seat that absorbs overflow.',
  },
];

/* ---------- accounts ---------- */
/*
 * gate: every deliverable stops for a named person before it can be scheduled.
 * rework: the share of finished work that comes back for a second pass. New
 * accounts carry more of it, and pretending otherwise is how a plan that fits
 * on paper stops fitting in week three.
 */

const accounts = [
  {
    id: 'c_mew', name: 'Man Eats Wild', client: 'Mario Kalpou', tier: 'flagship',
    color: 'coral', status: 'onboarding', ownerId: 'p_senior',
    gateRequired: true, gatekeeperId: 'p_olivia', gateMinutes: 8, rework: 0.25,
    retainer: null, billingDay: null,
    note: 'The biggest account on the board, still onboarding, and running on one editor. The cadence that was promised was written for a bench that does not exist, so it comes down for the opening months or the quality does. Access is still the blocker.',
  },
  {
    id: 'c_xander', name: 'Xander Budnick', client: 'Xander Budnick', tier: 'partnership',
    color: 'indigo', status: 'trial', ownerId: 'p_viktor',
    gateRequired: true, gatekeeperId: 'p_olivia', gateMinutes: 5, rework: 0.1,
    retainer: 0, billingDay: null, reviewDate: '2026-08-31',
    note: 'Thirty days free, then retainer, revenue split or a hybrid. Re-evaluate when he is back from Greenland. Running fine on Viktor and the workflow is written down, which is what makes the swap with the new hire cheap if it is ever needed.',
  },
  {
    id: 'c_blair', name: 'Blair Conklin', client: 'Blair Conklin', tier: 'revshare',
    color: 'indigo', status: 'active', ownerId: 'p_kingdon',
    gateRequired: true, gatekeeperId: 'p_olivia', gateMinutes: 4, rework: 0.1,
    revShare: 0.35, retainer: null,
    note: 'Thirty-five percent of platform gross to the agency. Covered by Kingdon and running fine. The gate here is only whether a video is good, not running the account.',
  },
  {
    id: 'c_fw', name: 'Foreign Waters', client: 'Gianni Ottone', tier: 'programme',
    color: 'amber', status: 'active', ownerId: 'p_olivia',
    gateRequired: false, gatekeeperId: null, gateMinutes: 0, rework: 0.05,
    retainer: null,
    note: 'A creator programme, not a posting account, on a daily rhythm nothing else here has. It is the first thing to move off Olivia: least overlap with the rest of her work, and the only piece that runs to a hard daily floor.',
  },
  {
    id: 'c_paulo', name: 'Paulo Prietto', client: 'Paulo Prietto', tier: 'retainer',
    color: 'violet', status: 'active', ownerId: 'p_julia',
    gateRequired: false, gatekeeperId: null, gateMinutes: 0, rework: 0.1,
    retainer: 900, billingDay: 8,
    note: 'Compass, Laguna Beach. Instagram management on a monthly retainer, billed on the 8th. Julia runs it end to end, outside the editing line.',
  },
  {
    id: 'c_tara', name: 'Tara Bunker', client: 'Tara Bunker', tier: 'retainer',
    color: 'violet', status: 'active', ownerId: 'p_julia',
    gateRequired: false, gatekeeperId: null, gateMinutes: 0, rework: 0.1,
    retainer: 900, billingDay: 8,
    note: 'Compass and Alcove Collective. Same shape as Paulo, same billing day.',
  },
  {
    id: 'c_lucas', name: 'Lucas Fink', client: 'Lucas Fink', tier: 'repurpose',
    color: 'amber', status: 'active', ownerId: 'p_intern2',
    gateRequired: true, gatekeeperId: 'p_olivia', gateMinutes: 3, rework: 0.15,
    retainer: null,
    note: 'Repurposing only, run end to end by the second intern. The Facebook portfolio invite still needs accepting before it expires, and that access belongs to the agency rather than a personal login.',
  },
  {
    id: 'c_shane', name: 'Shane Dorian', client: 'Shane Dorian', tier: 'build',
    color: 'moss', status: 'active', ownerId: 'p_garrett',
    gateRequired: false, gatekeeperId: null, gateMinutes: 0, rework: 0.1,
    retainer: 100, setupFee: 5000, netShare: 0.15,
    note: 'Surf Longevity. Five thousand setup, half up front and half on delivery, a hundred a month and fifteen percent of net. Garrett owns it and it never touches the editing line.',
  },
];

/* ---------- work lines ---------- */
/*
 * A work line is a standing promise to a client. It is not a task: it is the
 * rule that produces tasks. The scheduler turns these into a week of jobs, the
 * capacity model prices them, and the alert monitors compare what was promised
 * here against what actually got posted.
 *
 * route  full   footage -> editing -> senior review -> gate -> scheduled -> posted
 *        lite   editing -> gate -> scheduled -> posted
 *        direct editing -> scheduled -> posted        (no gate, owner is end to end)
 *        standing  no discrete deliverable, reserves capacity only
 */

const workLines = [
  // Man Eats Wild — the flagship, one seat carrying all of it.
  { id: 'wl_mew_yt', accountId: 'c_mew', ownerId: 'p_senior', route: 'full', priority: 1,
    title: 'Weekly long form for YouTube', cadence: 'weekly', anchorDay: 'Thu', perPeriod: 1,
    minutes: 900, platforms: ['YouTube'], standardId: 'std_mew_longform',
    note: 'Garrett cuts the first one to set the standard. Everything else on this account is pulled from the same timeline.' },
  { id: 'wl_mew_tt', accountId: 'c_mew', ownerId: 'p_senior', route: 'full', priority: 1,
    title: 'Short form for TikTok, from the long form session', cadence: 'daily', perPeriod: 3,
    minutes: 20, platforms: ['TikTok'], standardId: 'std_mew_shortform',
    dependsOn: 'wl_mew_yt',
    note: 'Cut in the same session as the long form while the footage is still open. Run as a separate queue and this seat quietly becomes two jobs.' },
  { id: 'wl_mew_shorts', accountId: 'c_mew', ownerId: 'p_senior', route: 'full', priority: 2,
    title: 'YouTube Shorts, from the same cuts', cadence: 'daily', perPeriod: 1,
    minutes: 10, platforms: ['YouTube Shorts'], standardId: 'std_mew_shortform',
    dependsOn: 'wl_mew_tt' },
  { id: 'wl_mew_ig', accountId: 'c_mew', ownerId: 'p_senior', route: 'full', priority: 1,
    title: 'The Instagram cut, a post a day', cadence: 'daily', perPeriod: 1,
    minutes: 25, platforms: ['Instagram'], standardId: 'std_mew_shortform' },
  { id: 'wl_mew_stories', accountId: 'c_mew', ownerId: 'p_olivia', route: 'direct', priority: 3,
    title: 'Instagram stories through the day', cadence: 'daily', perPeriod: 1,
    minutes: 15, platforms: ['Instagram'], standardId: null },
  { id: 'wl_mew_fb', accountId: 'c_mew', ownerId: 'p_olivia', route: 'lite', priority: 3,
    title: 'Facebook, the Instagram mirror plus a YouTube repost', cadence: 'weekly', anchorDay: 'Fri',
    perPeriod: 1, minutes: 30, platforms: ['Facebook'], standardId: null },
  { id: 'wl_mew_x', accountId: 'c_mew', ownerId: 'p_olivia', route: 'direct', priority: 3,
    title: 'Written posts and repurposed clips on X', cadence: 'weekly', anchorDay: 'Wed',
    perPeriod: 1, minutes: 20, platforms: ['X'], standardId: null },
  { id: 'wl_mew_bench', accountId: 'c_mew', ownerId: 'p_senior', route: 'standing', priority: 2,
    title: 'Run the bench: review, train and set the standard for the two editors',
    cadence: 'ongoing', perPeriod: 1, minutes: 300, platforms: [], standardId: null },

  // Xander Budnick — running fine, and the free contingency.
  { id: 'wl_xan_mid', accountId: 'c_xander', ownerId: 'p_viktor', route: 'full', priority: 1,
    title: 'Midforms for YouTube, eight to fifteen minutes', cadence: 'weekly', anchorDay: 'Tue',
    perPeriod: 2, minutes: 240, platforms: ['YouTube'], standardId: 'std_xander_segment' },
  { id: 'wl_xan_short', accountId: 'c_xander', ownerId: 'p_viktor', route: 'full', priority: 1,
    title: 'Short form bangers, one that teaches and one that entertains', cadence: 'daily',
    perPeriod: 2, minutes: 30, platforms: ['YouTube Shorts', 'TikTok'], standardId: 'std_xander_segment' },
  { id: 'wl_xan_tt', accountId: 'c_xander', ownerId: 'p_olivia', route: 'lite', priority: 3,
    title: 'The midforms repurposed to TikTok', cadence: 'weekly', anchorDay: 'Wed',
    perPeriod: 2, minutes: 15, platforms: ['TikTok'], standardId: null, dependsOn: 'wl_xan_mid' },
  { id: 'wl_xan_fb', accountId: 'c_xander', ownerId: 'p_olivia', route: 'lite', priority: 3,
    title: 'The midforms repurposed to Facebook', cadence: 'weekly', anchorDay: 'Thu',
    perPeriod: 2, minutes: 10, platforms: ['Facebook'], standardId: null, dependsOn: 'wl_xan_mid' },

  // Blair Conklin — covered, and the volume that generates the revenue share.
  { id: 'wl_blair_river', accountId: 'c_blair', ownerId: 'p_kingdon', route: 'lite', priority: 2,
    title: 'Raw river long form for Facebook, shot vertical', cadence: 'weekly', anchorDay: 'Mon',
    perPeriod: 1, minutes: 45, platforms: ['Facebook'], standardId: 'std_skidkids' },
  { id: 'wl_blair_cuts', accountId: 'c_blair', ownerId: 'p_kingdon', route: 'lite', priority: 1,
    title: 'The monthly run of cuts from the iCloud footage', cadence: 'weekly', anchorDay: 'Mon',
    perPeriod: 15, minutes: 12, platforms: ['TikTok', 'YouTube Shorts', 'Facebook'],
    standardId: 'std_skidkids',
    note: 'Roughly sixty a month, staged weekly so the board reflects real load rather than one impossible day.' },
  { id: 'wl_blair_fb', accountId: 'c_blair', ownerId: 'p_olivia', route: 'lite', priority: 3,
    title: 'The YouTube long form repurposed to Facebook', cadence: 'weekly', anchorDay: 'Fri',
    perPeriod: 1, minutes: 15, platforms: ['Facebook'], standardId: 'std_skidkids' },

  // Foreign Waters — a daily floor, not a posting schedule.
  { id: 'wl_fw_organic', accountId: 'c_fw', ownerId: 'p_olivia', route: 'direct', priority: 2,
    title: 'Organic posts for the brand', cadence: 'weekly', anchorDay: 'Tue', perPeriod: 2,
    minutes: 60, platforms: ['Instagram', 'TikTok'], standardId: null },
  { id: 'wl_fw_trybe', accountId: 'c_fw', ownerId: 'p_olivia', route: 'direct', priority: 1,
    title: 'Clear the Trybe creator digest and send the twelve invites', cadence: 'daily',
    perPeriod: 1, minutes: 45, platforms: ['Trybe'], standardId: 'std_fw_floor' },
  { id: 'wl_fw_shop', accountId: 'c_fw', ownerId: 'p_olivia', route: 'direct', priority: 1,
    title: 'Work the TikTok Shop seller centre', cadence: 'daily', perPeriod: 1,
    minutes: 30, platforms: ['TikTok Shop'], standardId: 'std_fw_floor' },
  { id: 'wl_fw_briefs', accountId: 'c_fw', ownerId: 'p_olivia', route: 'standing', priority: 2,
    title: 'Creator briefs, feedback and approvals', cadence: 'ongoing', perPeriod: 1,
    minutes: 120, platforms: [], standardId: 'std_fw_floor' },
  { id: 'wl_fw_athletes', accountId: 'c_fw', ownerId: 'p_olivia', route: 'standing', priority: 3,
    title: 'Roster athlete posts with the product linked', cadence: 'ongoing', perPeriod: 1,
    minutes: 60, platforms: [], standardId: null },

  // Real estate — Julia, end to end, no gate.
  { id: 'wl_paulo', accountId: 'c_paulo', ownerId: 'p_julia', route: 'direct', priority: 1,
    title: 'Real estate posts through the week', cadence: 'weekly', anchorDay: 'Mon', perPeriod: 3,
    minutes: 60, platforms: ['Instagram'], standardId: 'std_re_compliance' },
  { id: 'wl_tara', accountId: 'c_tara', ownerId: 'p_julia', route: 'direct', priority: 1,
    title: 'Real estate posts through the week', cadence: 'weekly', anchorDay: 'Tue', perPeriod: 3,
    minutes: 60, platforms: ['Instagram'], standardId: 'std_re_compliance' },

  // Lucas Fink — the second intern, end to end.
  { id: 'wl_lucas_build', accountId: 'c_lucas', ownerId: 'p_intern2', route: 'lite', priority: 2,
    title: 'Build the posts from his existing videos', cadence: 'weekly', anchorDay: 'Mon',
    perPeriod: 4, minutes: 30, platforms: ['Facebook'], standardId: null },
  { id: 'wl_lucas_post', accountId: 'c_lucas', ownerId: 'p_intern2', route: 'lite', priority: 2,
    title: 'Post them to his Facebook page', cadence: 'weekly', anchorDay: 'Thu', perPeriod: 4,
    minutes: 10, platforms: ['Facebook'], standardId: null, dependsOn: 'wl_lucas_build' },

  // Shane Dorian — Garrett's, off the line entirely.
  { id: 'wl_shane_course', accountId: 'c_shane', ownerId: 'p_garrett', route: 'standing', priority: 2,
    title: 'The Surf Longevity course build', cadence: 'ongoing', perPeriod: 1, minutes: 300,
    platforms: ['Skool'], standardId: null },
  { id: 'wl_shane_skool', accountId: 'c_shane', ownerId: 'p_garrett', route: 'standing', priority: 3,
    title: 'Running the Skool community', cadence: 'ongoing', perPeriod: 1, minutes: 120,
    platforms: ['Skool'], standardId: null },
];

/* ---------- access register ---------- */
/*
 * Access is the thing that stops work without ever appearing on a task board.
 * holder 'agency' is the only safe answer; 'personal' is a resignation away from
 * losing an account, and 'none' means the cadence cannot start at all.
 */

const access = [
  { id: 'ac_mew_meta', accountId: 'c_mew', platform: 'Meta Business Suite', level: 'Partner access',
    holder: 'none', status: 'requested', requestedOn: '2026-08-10', expiresOn: null,
    note: 'Outstanding. Posting cannot start on cadence until this lands.' },
  { id: 'ac_mew_tt', accountId: 'c_mew', platform: 'TikTok', level: 'Shared login',
    holder: 'none', status: 'requested', requestedOn: '2026-08-10', expiresOn: null,
    note: 'Needs a login and somebody reachable for the two-factor code.' },
  { id: 'ac_mew_yt', accountId: 'c_mew', platform: 'YouTube', level: 'Manager',
    holder: 'none', status: 'requested', requestedOn: '2026-08-10', expiresOn: null,
    note: 'Manager on the channel, not Editor. Editor cannot see the analytics that prove the work.' },
  { id: 'ac_xan_yt', accountId: 'c_xander', platform: 'YouTube', level: 'Manager',
    holder: 'personal', account: 'abdullagarrett@gmail.com', status: 'granted',
    grantedOn: '2026-07-28', expiresOn: null,
    note: 'On the Clips channel only. Held on a personal Google account rather than the agency one.' },
  { id: 'ac_xan_tt', accountId: 'c_xander', platform: 'TikTok', level: 'Shared login',
    holder: 'shared', status: 'granted', grantedOn: '2026-07-28', expiresOn: null,
    note: 'He rotates the password without warning. If login fails, text him rather than raising a ticket.' },
  { id: 'ac_xan_fb', accountId: 'c_xander', platform: 'Facebook', level: 'Task access',
    holder: 'agency', account: 'info@retmediaagency.com', status: 'granted',
    grantedOn: '2026-07-28', expiresOn: '2026-08-27',
    note: 'Meta invites expire thirty days after they are sent. Re-invite before the date, not after.' },
  { id: 'ac_blair_tt', accountId: 'c_blair', platform: 'TikTok', level: 'Shared login',
    holder: 'shared', status: 'granted', grantedOn: '2025-01-15', expiresOn: null },
  { id: 'ac_blair_fb', accountId: 'c_blair', platform: 'Facebook', level: 'Task access',
    holder: 'agency', account: 'info@retmediaagency.com', status: 'granted',
    grantedOn: '2025-01-15', expiresOn: null },
  { id: 'ac_lucas_fb', accountId: 'c_lucas', platform: 'Facebook', level: 'Business portfolio',
    holder: 'none', status: 'invited', requestedOn: '2026-08-14', expiresOn: '2026-09-13',
    note: 'Invite sent and not yet accepted. It expires, and the account it lands on should be the agency one.' },
  { id: 'ac_paulo_ig', accountId: 'c_paulo', platform: 'Instagram', level: 'Full access',
    holder: 'agency', account: 'info@retmediaagency.com', status: 'granted', grantedOn: '2025-06-01' },
  { id: 'ac_tara_ig', accountId: 'c_tara', platform: 'Instagram', level: 'Full access',
    holder: 'agency', account: 'info@retmediaagency.com', status: 'granted', grantedOn: '2025-09-01' },
  { id: 'ac_fw_trybe', accountId: 'c_fw', platform: 'Trybe', level: 'Brand admin',
    holder: 'agency', account: 'info@retmediaagency.com', status: 'granted', grantedOn: '2026-06-01',
    note: 'Applicant approval was handed to Garrett. Approve who you want and leave everybody else alone: the reject rate is public to creators.' },
  { id: 'ac_fw_shop', accountId: 'c_fw', platform: 'TikTok Shop', level: 'Seller centre',
    holder: 'shared', status: 'granted', grantedOn: '2026-06-01' },
  { id: 'ac_shane_skool', accountId: 'c_shane', platform: 'Skool', level: 'Admin',
    holder: 'agency', account: 'info@retmediaagency.com', status: 'granted', grantedOn: '2026-05-01' },
];

/* ---------- standards ---------- */
/*
 * The formulas that were in Garrett's head. A work line with no standard attached
 * raises an alert, because a new manager and a new senior editor in the same month
 * is the moment undocumented taste stops being tolerable.
 */

const standards = [
  {
    id: 'std_mew_longform', name: 'Man Eats Wild — long form', scope: 'c_mew', status: 'draft',
    owner: 'p_garrett',
    checklist: [
      'Hook lands in the first eight seconds and states the objective, not the location',
      'One clear problem introduced before the two minute mark',
      'Escalation is visible: each act is harder than the last',
      'Payoff or lesson resolves the problem that was set up',
      'Title is a question or a claim, never a description',
      'Thumbnail reads at phone size with no more than three words',
    ],
    titleBank: [],
    note: 'DRAFT. Garrett cuts the first long form and writes this from that cut. Until it exists, the account has a standard that only one person can apply, and that person is trying to get out of the line.',
  },
  {
    id: 'std_mew_shortform', name: 'Man Eats Wild — short form', scope: 'c_mew', status: 'draft',
    owner: 'p_olivia',
    checklist: [
      'Pulled from the same session as the long form, not sourced separately',
      'Hook in the first two seconds',
      'Complete on its own: someone who has not seen the long form still gets it',
      'Crop and safe area checked on the actual platform, not in the editor',
      'Caption true to the footage',
    ],
    titleBank: [],
    note: 'DRAFT. Olivia sets this in her first week using cuts from Garrett’s first long form, so the new editor inherits an example rather than a description.',
  },
  {
    id: 'std_skidkids', name: 'Blair Conklin — the Skid Kids caption system', scope: 'c_blair',
    status: 'proven', owner: 'p_garrett',
    checklist: [
      'Post RAW: no edits, no added audio, no filters, no trimming. HD toggle stays on',
      'Extract frames and look at them before writing. Never caption from the filename',
      'Reword a proven title from the bank rather than inventing phrasing',
      'Short punchy hook ending in ! or ?!',
      'At most one emoji, from 😳 🌊 🌧️',
      'TikTok: two or three tags from #skimboarding #oddlysatisfying #waves #riverwave #stormsurf #thewedge, with a space after the emoji',
      'Facebook: no hashtags, under twelve words',
    ],
    titleBank: [
      { title: 'Pro Skimboarder Catches Dream Wave!', views: 493000000 },
      { title: 'Weirdest Wave of My Life?', views: 412000000 },
      { title: 'A Skimboarders Dream Wave', views: 283000000 },
      { title: 'Surfer Gets Swept out to Sea by River Rapids', views: 116000000 },
      { title: 'IT ACTUALLY WORKED!!!', views: 114000000 },
      { title: 'One Wave at a Pro Skimboarding Contest', views: 95000000 },
      { title: 'Breaking a sand dam connecting river to ocean', views: 79000000 },
      { title: 'Small trench Connects River to Ocean!', views: 72000000 },
      { title: 'Beach Trench Forms Massive Waves', views: 62000000 },
      { title: 'River wave community goes crazy!', views: 56000000 },
      { title: 'Biggest River Wave Ever Surfed?!', views: 43000000 },
      { title: 'That Did Not Go As Planned', views: 40000000 },
      { title: 'How does he slide so far?!', views: 39000000 },
    ],
    note: 'Accuracy is a hard requirement. A caption once claimed a surfer almost got swept out to sea over a controlled ride and Blair rejected it.',
  },
  {
    id: 'std_xander_segment', name: 'Xander Budnick — segment scouting', scope: 'c_xander',
    status: 'proven', owner: 'p_garrett',
    checklist: [
      'Three acts required: hook, escalation, resolution. The segment must feel complete on its own',
      'Eight to fifteen minutes continuous, pulled from inside a long form. Never re-upload a whole short video',
      'Deliver spoken dialogue markers, not minute marks. The transcript vault has no reliable timecodes',
      'First two and last two sentences quoted exactly as the in and out points',
      'One paragraph on why this segment over the others',
      'Minimal editing needed: it should work almost as is',
      'Post to the Clips channel only. Never to the main channel or Xander Budnick 2',
    ],
    titleBank: [],
    note: 'Keep asks tiny, batched and deadline free. He describes himself as slow and terrible to work with, and he is not wrong.',
  },
  {
    id: 'std_re_compliance', name: 'Real estate — compliance and accuracy', scope: 'shared',
    status: 'proven', owner: 'p_julia',
    checklist: [
      'Own or licensed media only. No stock, no web images, no competitor photos',
      'Price, beds, baths, square footage and status verified against the live listing',
      'Fair Housing: no language targeting or excluding protected classes. Describe the property, never the buyer',
      'Brokerage attribution present where required',
      'Read the rendered text back before delivery to catch typos and crowding',
    ],
    titleBank: [],
    note: 'This runs before every publish on Paulo and Tara. It is the one checklist with legal consequences attached.',
  },
  {
    id: 'std_fw_floor', name: 'Foreign Waters — the daily floor', scope: 'c_fw',
    status: 'proven', owner: 'p_garrett',
    checklist: [
      'IG requests box cleared to zero',
      'Pickaxe DMs: ten sent, the platform hard cap',
      'IG partnership messages: twenty sent',
      'Trybe discovery: twelve invites, the daily hard cap',
      'Every reply in every inbox answered the same day',
      'Euka TikTok agents stay stopped: 417 non-renewable slots, do not spend them before the Shop product is approved',
      'Never hit reject on Trybe. Approve who you want, leave everyone else alone',
    ],
    titleBank: [],
    note: 'The honest ceiling is about twenty-two outbound a day and no amount of tuning beats it. Registering the Euka email sender is the only change that moves the order of magnitude, so it gets surfaced every single session until it is done.',
  },
];

/* ---------- the plan carried over from the blueprint ---------- */

const decisions = [
  { id: 'd1', kind: 'hire', status: 'open', title: 'One Senior Editor, owning Man Eats Wild end to end',
    body: 'Long form and short form become one job rather than two, and not only for budget reasons. Whoever cuts the long form has already watched, logged and learned the footage, so the clips fall out of the same session. Two editors would each ingest the same material, which is the most expensive part of the work done twice.' },
  { id: 'd2', kind: 'hire', status: 'open', title: 'Hire for the long form. The short form falls out of it',
    body: 'Write the role around building a story out of raw footage over eight to twenty minutes. Ask for a reel with a story in it, not a montage. Hiring a short form specialist and hoping they grow into long form is how you end up back here in three months.' },
  { id: 'd3', kind: 'fix', status: 'open', title: 'The cadence has to come down, and it is no longer optional',
    body: 'A weekly long form plus a post a day plus several TikToks a day was scoped for two editors. Go back to Mario before the first week and agree a lighter opening period. Asking now reads as planning. Missing it silently in week three reads as failure.' },
  { id: 'd4', kind: 'rescope', status: 'open', title: 'Batch it. One session a week, not two queues',
    body: 'Cut the long form and pull the week of short form out of the same timeline while the footage is still open. That is what makes one seat work instead of quietly turning it into two.' },
  { id: 'd5', kind: 'fix', status: 'open', title: 'Everything goes through Olivia for the first month',
    body: 'With one person owning the biggest account, her gate does the work a second editor and a lead would otherwise do. No exceptions in the first month. It is also how she learns the account fast enough to cover it.' },
  { id: 'd6', kind: 'watch', status: 'open', title: 'Viktor is the free contingency',
    body: 'If the new editor is stronger on volume than story, swap them with Viktor. The workflow Viktor hands over is already written down. Name him the long form backup on day one so it never has to be a surprise.' },
  { id: 'd7', kind: 'rescope', status: 'open', title: 'Take Foreign Waters off Olivia',
    body: 'A creator programme on a daily rhythm, sitting on the person who is also the hard gate on the flagship. Least overlap with everything else she does, so it is the piece that moves.' },
  { id: 'd8', kind: 'hold', status: 'done', title: 'Leave Julia exactly where she is',
    body: 'Real estate already works. Recurring retainers, nothing waiting on anybody else, nothing queued behind a quality gate. It is the pattern to copy for the next vertical.' },
];

function seed() {
  return {
    version: 1,
    org: {
      name: 'RET Media LLC',
      owner: 'Garrett Abdulla',
      email: 'info@retmediaagency.com',
      gateFreeze: { accountId: 'c_mew', until: '2026-09-30',
        note: 'First month: nothing from Man Eats Wild posts without Olivia looking at it. No exceptions, no shortcuts for a deadline.' },
    },
    seats, accounts, workLines, access, standards, decisions,
    jobs: [],
    postLog: [],
    generated: {},
  };
}

module.exports = { seed };
