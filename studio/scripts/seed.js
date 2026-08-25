// Populates a demo roster so the planner can be walked through before any
// developer app exists. Safe to re-run; it skips creators that already exist.
const store = require('../server/store');
const connect = require('../server/connect');

const ROSTER = [
  { name: 'Blair Conklin', handle: 'blairconklin', platforms: ['instagram', 'tiktok', 'facebook'] },
  { name: 'Xander Budnick', handle: 'xanderbudnick', platforms: ['instagram', 'tiktok', 'facebook', 'youtube'] },
];

(async function seed() {
  const existing = await store.listCreators();
  for (const entry of ROSTER) {
    if (existing.some((c) => c.name === entry.name)) {
      console.log(`skip ${entry.name} (already there)`);
      continue;
    }
    const creator = await store.createCreator({ name: entry.name, handle: entry.handle });
    for (const platform of entry.platforms) {
      await connect.connectDemoAccount({
        platform,
        creatorId: creator.id,
        username: entry.handle,
        displayName: `${entry.name} · ${platform}`,
      });
    }
    console.log(`seeded ${entry.name} with ${entry.platforms.length} accounts`);
  }
  console.log(`\nData: ${store.DATA_ROOT}`);
}());
