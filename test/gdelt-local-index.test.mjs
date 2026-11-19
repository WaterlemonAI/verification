import test from 'node:test';
import assert from 'node:assert/strict';
import { searchLocalGdeltIndex, stateCoversRequest } from '../lib/gdelt-local-index.mjs';

const now = Date.parse('2026-10-26T20:00:00Z');
const dailyArchive = {
  coverage_start: '2026-10-22T21:15:00Z',
  coverage_end: '2026-10-26T01:30:00Z'
};

test('daily local archive covers recent explicit dates but not the default one-year window', () => {
  assert.equal(stateCoversRequest(dailyArchive, {}, now), false);
  assert.equal(stateCoversRequest(dailyArchive, { date_from: '2026-10-24' }, now), true);
  assert.equal(stateCoversRequest(dailyArchive, { date_to: '2026-10-26' }, now), false);
  assert.equal(stateCoversRequest({ ...dailyArchive, coverage_start: '2025-10-26T00:00:00Z' }, {}, now), true);
});

test('archive is incomplete for older requested dates or a missed daily update', () => {
  assert.equal(stateCoversRequest(dailyArchive, { date_from: '2026-10-01' }, now), false);
  assert.equal(stateCoversRequest(dailyArchive, {}, Date.parse('2026-10-28T00:00:00Z')), false);
  assert.equal(stateCoversRequest(dailyArchive, { date_to: '2026-10-28' }, Date.parse('2026-10-28T00:00:00Z')), false);
});

test('undated requests cover all stored Azure history while explicit dates remain bounded', () => {
  assert.equal(stateCoversRequest(dailyArchive, { archive_all_stored: true,
    date_from: '2025-10-26', date_to: '2026-10-26' }, now), true);
  assert.equal(stateCoversRequest(dailyArchive, { archive_all_stored: false,
    date_from: '2025-10-26', date_to: '2026-10-26' }, now), false);
});

test('local archive streams beyond the former 250-row cutoff and includes older stored records', async () => {
  const current = Date.now();
  const state = {
    coverage_start: new Date(current - 2 * 365 * 24 * 60 * 60_000).toISOString(),
    coverage_end: new Date(current - 60 * 60_000).toISOString()
  };
  const publishedAt = new Date(current - 18 * 30 * 24 * 60 * 60_000).toISOString();
  const clients = { table: {
    async *listEntities() {
      for (let index = 0; index < 300; index += 1) {
        yield { publishedAt, url: `https://example.com/article/${index}`, title: `Article ${index}`,
          matchedName: 'example group', source: 'example.com', language: 'en' };
      }
    }
  } };
  const allStored = await searchLocalGdeltIndex({ name: 'Example Group', entity_type: 'business',
    archive_all_stored: true, date_from: new Date(current - 365 * 24 * 60 * 60_000).toISOString().slice(0, 10),
    date_to: new Date(current).toISOString().slice(0, 10) }, { clients, state });
  assert.equal(allStored.results.length, 300);
  assert.equal(allStored.complete, true);

  const bounded = await searchLocalGdeltIndex({ name: 'Example Group', entity_type: 'business',
    archive_all_stored: false, date_from: new Date(current - 365 * 24 * 60 * 60_000).toISOString().slice(0, 10),
    date_to: new Date(current).toISOString().slice(0, 10) }, { clients, state });
  assert.equal(bounded.results.length, 0);
});
