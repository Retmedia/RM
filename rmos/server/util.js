'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ---------- ids ---------- */

let counter = 0;
function uid(prefix) {
  counter = (counter + 1) % 4096;
  return `${prefix || 'x'}_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}`;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
}

/* Stable id for a generated job, so regenerating a week never duplicates it. */
function stableId(prefix, ...parts) {
  const h = crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
  return `${prefix}_${h}`;
}

/* ---------- dates ---------- */
/* Everything is a plain YYYY-MM-DD string. No timezone maths, no Date drift. */

const DAY_MS = 86400000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function today() {
  return toDay(new Date());
}

function toDay(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${day}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function addDays(day, n) {
  return toDay(new Date(parseDay(day).getTime() + n * DAY_MS));
}

function daysBetween(a, b) {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / DAY_MS);
}

function dayOfWeek(day) {
  return parseDay(day).getUTCDay(); // 0 Sun .. 6 Sat
}

function dayName(day) {
  return DAY_NAMES[dayOfWeek(day)];
}

function dayOfMonth(day) {
  return parseDay(day).getUTCDate();
}

/* Monday-based week start. The agency's week turns over on Monday. */
function weekStart(day) {
  const dow = dayOfWeek(day);
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}

function weekDays(start) {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/* ISO week label, e.g. 2026-W35. Used as the key a generated week is stored under. */
function isoWeek(day) {
  const d = parseDay(day);
  const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
  const thursday = new Date(d.getTime() + (3 - dow) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/* ---------- formatting ---------- */

function hours(minutes) {
  return Math.round((minutes / 60) * 10) / 10;
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

function money(n) {
  return `$${Number(n || 0).toLocaleString('en-US')}`;
}

/* ---------- storage ---------- */

function writeJSONAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJSONIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

module.exports = {
  uid, slugify, stableId,
  today, toDay, parseDay, addDays, daysBetween,
  dayOfWeek, dayName, dayOfMonth, weekStart, weekDays, isoWeek,
  hours, pct, money,
  writeJSONAtomic, readJSONIfExists,
  DAY_NAMES,
};
