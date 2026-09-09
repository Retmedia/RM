import { PLATFORMS, liveState } from './platforms.js';

const ORIGIN = process.env.STUDIO_ORIGIN || '';
const live = liveState();

const rows = PLATFORMS.map((p) => {
  const s = live[p.id];
  const status = s.live ? 'LIVE' : s.configured ? `waiting on ${p.review}` : `missing ${s.missing.join(', ')}`;
  return `  ${p.name.padEnd(10)} ${status}`;
});

console.log('Cadent preflight\n');
console.log(rows.join('\n'));
console.log('');

if (!ORIGIN.startsWith('https://')) {
  console.log('  STUDIO_ORIGIN is not a public https URL.');
  console.log('  Grant links have to open on a client phone, so 127.0.0.1 will not do.');
} else {
  console.log(`  STUDIO_ORIGIN ${ORIGIN}`);
}

const blocked = PLATFORMS.filter((p) => !live[p.id].live);
console.log(
  blocked.length
    ? `\n  ${blocked.length} of ${PLATFORMS.length} platforms stay on Test connect until the above clears.`
    : '\n  All platforms live.'
);
