const test = require('node:test');
const assert = require('node:assert/strict');
const { freshEnv, cleanup } = require('./helpers');

const dir = freshEnv();
test.after(() => cleanup(dir));

const cadence = require('../server/cadence');

test('slots roll forward past times that have already gone', () => {
  const from = new Date('2026-08-25T12:00:00');
  const slots = [{ day: 2, time: '09:00' }, { day: 2, time: '17:00' }];
  const [first] = cadence.nextOpenSlots({ slots, count: 1, from });
  assert.ok(new Date(first) > from, 'never schedules into the past');
  assert.equal(new Date(first).getHours(), 17, 'takes the later slot the same day');
});

test('slots already taken are skipped rather than doubled up', () => {
  const from = new Date('2026-08-25T12:00:00');
  const slots = [{ day: 3, time: '09:00' }];
  const three = cadence.nextOpenSlots({ slots, count: 3, from });
  const afterTaking = cadence.nextOpenSlots({ slots, count: 2, from, taken: [three[0]] });
  assert.deepEqual(afterTaking, [three[1], three[2]]);
});

test('a month of clips lands on distinct times in order', () => {
  const slots = [
    { day: 1, time: '09:00' }, { day: 1, time: '17:00' },
    { day: 4, time: '09:00' }, { day: 4, time: '17:00' },
  ];
  const sixty = cadence.nextOpenSlots({ slots, count: 60, from: new Date('2026-08-25T12:00:00') });
  assert.equal(sixty.length, 60);
  assert.equal(new Set(sixty).size, 60, 'no two posts share a slot');
  const sorted = [...sixty].sort();
  assert.deepEqual(sixty, sorted, 'comes back in chronological order');
});

test('malformed slots are dropped, not trusted', () => {
  const slots = cadence.normalizeSlots([
    { day: 1, time: '09:00' },
    { day: 9, time: '09:00' },
    { day: 2, time: 'lunchtime' },
    { day: 'x', time: '10:00' },
  ]);
  assert.deepEqual(slots, [{ day: 1, time: '09:00' }]);
});

test('no rhythm yields no slots instead of looping forever', () => {
  assert.deepEqual(cadence.nextOpenSlots({ slots: [], count: 5 }), []);
});
