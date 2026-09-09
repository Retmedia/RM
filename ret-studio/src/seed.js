import { randomBytes } from 'node:crypto';
import { load, save } from './store.js';
import { PLATFORM_IDS } from './platforms.js';

const ROSTER = [
  { name: 'Blair Conklin', handle: 'blairconklin', tz: 'America/Los_Angeles' },
  { name: 'Lucas Fink', handle: 'lucasfink', tz: 'America/Los_Angeles' },
  { name: 'Dylan Rice', handle: 'dylanrice', tz: 'America/Los_Angeles' },
  { name: 'Paulo Prietto', handle: 'powlowpre', tz: 'America/Los_Angeles' },
  { name: 'Xander Budnick', handle: 'xanderbudnick', tz: 'America/Denver' },
  { name: 'Tara Bunker', handle: 'tarabunker', tz: 'America/Los_Angeles' }
];

export function blankAccounts() {
  const accounts = {};
  for (const id of PLATFORM_IDS) {
    accounts[id] = { state: 'idle', handle: '', connectedAt: null, mode: null };
  }
  return accounts;
}

export function newId() {
  return randomBytes(6).toString('hex');
}

export function newToken() {
  return randomBytes(24).toString('base64url');
}

export function seed({ force = false } = {}) {
  const data = load();
  if (data.creators.length && !force) return data;

  data.creators = ROSTER.map((r) => ({
    id: newId(),
    name: r.name,
    handle: r.handle,
    timezone: r.tz,
    approvalRequired: false,
    accounts: blankAccounts(),
    plan: { cadence: 'weekdays', time: '09:00', routes: [], captionFrom: 'title' }
  }));
  data.grants = {};
  return save(data);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = seed({ force: process.argv.includes('--force') });
  console.log(`seeded ${data.creators.length} creators`);
}
