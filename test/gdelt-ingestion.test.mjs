import test from 'node:test';
import assert from 'node:assert/strict';
import { entityRows, intervalTimestamp, parseTimestamp } from '../scripts/gdelt-ingest.mjs';

test('GDELT interval timestamps are UTC and rounded to fifteen minutes', () => {
  assert.equal(intervalTimestamp(new Date('2026-10-25T20:59:59Z')), '20261025204500');
  assert.equal(parseTimestamp('20261025204500').toISOString(), '2026-10-25T20:45:00.000Z');
});

test('GDELT GKG rows become deterministic person and organization index entities', () => {
  const fields = Array(27).fill('');
  fields[0] = '20261025204500-T7';
  fields[1] = '20261025204500';
  fields[3] = 'example.test';
  fields[4] = 'https://example.test/article';
  fields[8] = 'CRIME_FRAUD,10;EPU_CATS_CORRUPTION,20';
  fields[11] = 'Jane Doe;jane doe;JANE DOE';
  fields[13] = 'Example Holdings';
  fields[25] = 'srclc:ara;eng:1';
  fields[26] = '<PAGE_TITLE>Jane Doe &amp; Example Holdings</PAGE_TITLE>';
  const parsed = entityRows(`${fields.join('\t')}\n`);
  assert.equal(parsed.records, 1);
  assert.equal(parsed.mentions, 2);
  const entities = [...parsed.byPartition.values()].flat();
  assert.equal(entities.length, 2);
  assert.deepEqual(new Set(entities.map((item) => item.matchedName)), new Set(['Jane Doe', 'Example Holdings']));
  assert.equal(entities[0].title, 'Jane Doe & Example Holdings');
  assert.equal(entities[0].language, 'ara');
  assert.match(entities[0].rowKey, /^[a-f0-9]{64}_20261025204500-T7$/);
});
