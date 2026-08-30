// A creator's posting rhythm, and the slot maths that turns "here are 60 videos"
// into 60 scheduled posts without anyone picking 60 times.
//
// A slot is { day: 0-6 (Sunday = 0), time: "09:00" }. Two creators posting at
// the same hour is fine — they are different accounts.

const DEFAULT_SLOTS = [
  { day: 1, time: '09:00' }, { day: 2, time: '09:00' }, { day: 3, time: '09:00' },
  { day: 4, time: '09:00' }, { day: 5, time: '09:00' },
];

function normalizeSlots(slots) {
  if (!Array.isArray(slots)) return [];
  return slots
    .map((s) => ({ day: Number(s.day), time: String(s.time || '') }))
    .filter((s) => Number.isInteger(s.day) && s.day >= 0 && s.day <= 6 && /^\d{2}:\d{2}$/.test(s.time))
    .sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
}

// Everything below works in the creator's own timezone, not the server's.
// "09:00" has to mean 9am where the audience is; a box running in UTC would
// otherwise fire a Laguna Beach morning post at 2am.
const DEFAULT_TZ = process.env.STUDIO_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const partsFormatter = new Map();
function formatterFor(timezone) {
  if (!partsFormatter.has(timezone)) {
    partsFormatter.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      weekday: 'short',
    }));
  }
  return partsFormatter.get(timezone);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// What wall-clock time an instant reads as, in a given zone.
function localParts(instant, timezone) {
  const parts = Object.fromEntries(
    formatterFor(timezone).formatToParts(instant).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Midnight comes back as "24" in some ICU versions; normalise it.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
  };
}

// The inverse: the instant at which a zone's clock reads this wall time.
//
// The offset is always applied to the *wanted* time, never compounded onto the
// previous guess — a zone's offset never converges to zero, so correcting a
// correction just walks away from the answer.
function zonedTimeToInstant({ year, month, day, hour, minute }, timezone) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);

  // How far a zone's clock runs from UTC at a given instant.
  const offsetAt = (instant) => {
    const shown = localParts(new Date(instant), timezone);
    return Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute) - instant;
  };

  const first = wanted - offsetAt(wanted);
  // A second pass, in case the first guess landed the other side of a DST
  // change and so measured the wrong offset.
  return new Date(wanted - offsetAt(first));
}

function isValidTimezone(timezone) {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// The local midnight that starts the week containing `from`, as an instant.
function startOfWeek(from, timezone = DEFAULT_TZ) {
  const local = localParts(new Date(from), timezone);
  const day = addLocalDays(local, -local.weekday);
  return zonedTimeToInstant({ ...day, hour: 0, minute: 0 }, timezone);
}

// Calendar arithmetic on the local date, never on the instant. Adding 24 hours
// of milliseconds slips by an hour across a DST change and eventually lands a
// Sunday slot on a Saturday; counting calendar days cannot.
function addLocalDays({ year, month, day }, days) {
  const counter = new Date(Date.UTC(year, month - 1, day));
  counter.setUTCDate(counter.getUTCDate() + days);
  return {
    year: counter.getUTCFullYear(),
    month: counter.getUTCMonth() + 1,
    day: counter.getUTCDate(),
    weekday: counter.getUTCDay(),
  };
}

function slotDate(localDay, slot, timezone = DEFAULT_TZ) {
  const [hour, minute] = slot.time.split(':').map(Number);
  return zonedTimeToInstant({ ...localDay, hour, minute }, timezone);
}

// Walk forward week by week, handing back slot times that are in the future and
// not already spoken for. `taken` is the set of ISO times this creator already
// has scheduled, so re-running a bulk drop fills the gaps rather than doubling up.
function nextOpenSlots({
  slots, count, taken = [], from = new Date(), horizonWeeks = 78, timezone,
}) {
  const rhythm = normalizeSlots(slots);
  if (!rhythm.length || count <= 0) return [];
  const zone = isValidTimezone(timezone) ? timezone : DEFAULT_TZ;

  const spoken = new Set(taken.map((t) => new Date(t).toISOString()));
  const out = [];

  // Walk forward one local calendar day at a time and take whichever slots
  // fall on that weekday. Day-by-day rather than week-by-week means the
  // weekday is re-derived from the calendar every step and cannot drift.
  const start = localParts(new Date(from), zone);
  let cursor = addLocalDays(start, -start.weekday);

  for (let i = 0; i < horizonWeeks * 7 && out.length < count; i += 1) {
    const todaysSlots = rhythm.filter((slot) => slot.day === cursor.weekday);
    for (const slot of todaysSlots) {
      if (out.length >= count) break;
      const when = slotDate(cursor, slot, zone);
      if (when <= from) continue;
      const iso = when.toISOString();
      if (spoken.has(iso)) continue;
      spoken.add(iso);
      out.push(iso);
    }
    cursor = addLocalDays(cursor, 1);
  }
  return out;
}

function describe(slots) {
  const rhythm = normalizeSlots(slots);
  if (!rhythm.length) return 'No posting rhythm set';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDay = new Map();
  for (const s of rhythm) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s.time);
  }
  const perWeek = rhythm.length;
  const days = [...byDay.keys()].sort().map((d) => names[d]).join(', ');
  return `${perWeek} a week · ${days}`;
}

module.exports = {
  DEFAULT_SLOTS, DEFAULT_TZ, normalizeSlots, nextOpenSlots,
  describe, startOfWeek, isValidTimezone, localParts, zonedTimeToInstant,
};
