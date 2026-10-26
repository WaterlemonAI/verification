import test from 'node:test';
import assert from 'node:assert/strict';
import { stateCoversRequest } from '../lib/gdelt-local-index.mjs';

const now = Date.parse('2026-10-26T20:00:00Z');
const dailyArchive = {
  coverage_start: '2026-10-22T21:15:00Z',
  coverage_end: '2026-10-26T01:30:00Z'
};

test('daily local archive covers the disclosed rolling window despite normal ingest lag', () => {
  assert.equal(stateCoversRequest(dailyArchive, {}, now), true);
  assert.equal(stateCoversRequest(dailyArchive, { date_from: '2026-10-24' }, now), true);
});

test('archive is incomplete for older requested dates or a missed daily update', () => {
  assert.equal(stateCoversRequest(dailyArchive, { date_from: '2026-10-01' }, now), false);
  assert.equal(stateCoversRequest(dailyArchive, { date_to: '2026-10-26' }, now), false);
  assert.equal(stateCoversRequest(dailyArchive, {}, Date.parse('2026-10-28T00:00:00Z')), false);
});
