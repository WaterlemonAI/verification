import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('a fully indexed historical range remains covered after the daily watermark becomes stale', () => {
  const later = Date.parse('2026-10-28T20:00:00Z');
  assert.equal(stateCoversRequest(dailyArchive,
    { date_from: '2026-10-24', date_to: '2026-10-25' }, later), true);
  assert.equal(stateCoversRequest(dailyArchive,
    { date_from: '2026-10-24', date_to: '2026-10-28' }, later), false);
});

test('undated requests cover all stored Azure history while explicit dates remain bounded', () => {
  assert.equal(stateCoversRequest(dailyArchive, { archive_all_stored: true,
    date_from: '2025-10-26', date_to: '2026-10-26' }, now), true);
  assert.equal(stateCoversRequest(dailyArchive, { archive_all_stored: false,
    date_from: '2025-10-26', date_to: '2026-10-26' }, now), false);
});

test('a required V2 lookup never silently falls back to a V1 scan', async () => {
  const previous = process.env.GDELT_V2_READ_ENABLED;
  process.env.GDELT_V2_READ_ENABLED = 'false';
  try {
    const result = await searchLocalGdeltIndex({ name: 'Example Group', entity_type: 'business',
      archive_all_stored: true }, { requireV2: true,
      clients: { table: { listEntities() { throw new Error('v1_scan_must_not_run'); } } } });
    assert.equal(result.complete, false);
    assert.equal(result.scan.mode, 'v2_unavailable');
  } finally {
    if (previous === undefined) delete process.env.GDELT_V2_READ_ENABLED;
    else process.env.GDELT_V2_READ_ENABLED = previous;
  }
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

test('dated lookup pushes the date into the RowKey range and skips older rows', async () => {
  const current = Date.now();
  const day = 24 * 60 * 60_000;
  const dateFrom = new Date(current - 2 * day).toISOString().slice(0, 10);
  const dateTo = new Date(current).toISOString().slice(0, 10);
  const state = { coverage_start: new Date(current - 20 * day).toISOString(),
    coverage_end: new Date(current - 60 * 60_000).toISOString() };
  const hash = createHash('sha256').update('example group').digest('hex');
  const row = (time, index) => ({ partitionKey: `o-${hash[0]}`,
    rowKey: `${hash}_${time.replace(/[-:T]/g, '').slice(0, 14)}-${index}`,
    publishedAt: time, url: `https://example.com/${index}`, title: `Article ${index}` });
  const old = new Date(current - 10 * day).toISOString();
  const recent = new Date(current - day).toISOString();
  const stored = [...Array.from({ length: 251 }, (_, index) => row(old, index)), row(recent, 251), row(recent, 252)];
  let yielded = 0;
  const filters = [];
  const clients = { table: {
    async *listEntities({ queryOptions }) {
      const filter = String(queryOptions.filter);
      filters.push(filter);
      const partition = /PartitionKey eq '([^']+)'/.exec(filter)?.[1];
      const [, lower, upper] = /RowKey ge '([^']+)' and RowKey lt '([^']+)'/.exec(filter) || [];
      assert.ok(partition && lower && upper, filter);
      for (const entity of stored) {
        if (entity.partitionKey === partition && entity.rowKey >= lower && entity.rowKey < upper) {
          yielded += 1;
          yield entity;
        }
      }
    }
  } };
  const result = await searchLocalGdeltIndex({ name: 'Example Group', entity_type: 'business',
    archive_all_stored: false, date_from: dateFrom, date_to: dateTo }, { clients, state });
  assert.equal(result.complete, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.scan.rows_scanned, 2);
  assert.equal(yielded, 2);
  assert.ok(filters[0].includes(`${hash}_${dateFrom.replaceAll('-', '')}000000`));
});

test('a safety limit reports incomplete coverage instead of a clean empty result', async () => {
  const current = Date.now();
  const state = { coverage_start: new Date(current - 2 * 24 * 60 * 60_000).toISOString(),
    coverage_end: new Date(current - 60 * 60_000).toISOString() };
  const clients = { table: {
    async *listEntities() {
      for (let index = 0; index < 4; index += 1) {
        yield { publishedAt: new Date(current - 60 * 60_000).toISOString(),
          url: `https://example.com/${index}`, title: `Article ${index}` };
      }
    }
  } };
  const result = await searchLocalGdeltIndex({ name: 'Example Group', entity_type: 'business',
    archive_all_stored: true, date_to: new Date(current).toISOString().slice(0, 10) },
  { clients, state, maxRows: 2 });
  assert.equal(result.complete, false);
  assert.equal(result.limitReason, 'scan_row_limit_exceeded');
  assert.equal(result.scan.truncated, true);
  assert.equal(result.scan.rows_scanned, 2);
});

test('unsearched association names make archive coverage incomplete', async () => {
  const current = Date.now();
  const state = { coverage_start: new Date(current - 2 * 24 * 60 * 60_000).toISOString(),
    coverage_end: new Date(current - 60 * 60_000).toISOString() };
  const clients = { table: { async *listEntities() {} } };
  const result = await searchLocalGdeltIndex({ name: 'Example Group', entity_type: 'business',
    archive_all_stored: true, date_to: new Date(current).toISOString().slice(0, 10),
    associations: Array.from({ length: 12 }, (_, index) => ({ value: `Related Company ${index}` })) },
  { clients, state });
  assert.equal(result.complete, false);
  assert.equal(result.limitReason, 'name_limit_exceeded');
  assert.equal(result.scan.names_requested, 13);
  assert.equal(result.scan.names_queried, 12);
});

test('a slow empty Table lookup cannot be marked complete', async () => {
  const current = Date.now();
  const state = { coverage_start: new Date(current - 2 * 24 * 60 * 60_000).toISOString(),
    coverage_end: new Date(current - 60 * 60_000).toISOString() };
  const result = await searchLocalGdeltIndex({ name: 'Example Group', entity_type: 'business',
    archive_all_stored: true, date_to: new Date(current).toISOString().slice(0, 10) },
  { clients: { table: { async *listEntities() {} } }, state, maxScanMs: 0 });
  assert.equal(result.complete, false);
  assert.equal(result.limitReason, 'scan_time_limit_exceeded');
});
