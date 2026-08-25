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

function slotDate(weekStart, slot) {
  const [hour, minute] = slot.time.split(':').map(Number);
  const d = new Date(weekStart);
  d.setDate(d.getDate() + slot.day);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function startOfWeek(from) {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

// Walk forward week by week, handing back slot times that are in the future and
// not already spoken for. `taken` is the set of ISO times this creator already
// has scheduled, so re-running a bulk drop fills the gaps rather than doubling up.
function nextOpenSlots({ slots, count, taken = [], from = new Date(), horizonWeeks = 78 }) {
  const rhythm = normalizeSlots(slots);
  if (!rhythm.length || count <= 0) return [];

  const spoken = new Set(taken.map((t) => new Date(t).toISOString()));
  const out = [];
  let week = startOfWeek(from);

  for (let w = 0; w < horizonWeeks && out.length < count; w += 1) {
    for (const slot of rhythm) {
      if (out.length >= count) break;
      const when = slotDate(week, slot);
      if (when <= from) continue;
      const iso = when.toISOString();
      if (spoken.has(iso)) continue;
      spoken.add(iso);
      out.push(iso);
    }
    week = new Date(week);
    week.setDate(week.getDate() + 7);
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

module.exports = { DEFAULT_SLOTS, normalizeSlots, nextOpenSlots, describe, startOfWeek };
