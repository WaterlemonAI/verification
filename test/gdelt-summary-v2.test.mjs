import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { advanceV2Watermark, hasAppliedInterval, publishV2Interval, searchV2Summary,
  summaryKey, v2Manifest } from '../lib/gdelt-summary-v2.mjs';
import { globalArchiveSearch, presentAdverseMediaResponse, screenAdverseMedia,
  validateAdverseMediaRequest } from '../lib/adverse-media.mjs';
import { searchLocalGdeltIndex } from '../lib/gdelt-local-index.mjs';
import { entityRows, processGdeltInterval } from '../scripts/gdelt-ingest.mjs';
import { verifyV2Interval, verifyV2Range } from '../scripts/gdelt-index-v2-verify.mjs';
import { rebuildStoredV2 } from '../scripts/gdelt-index-v2-rebuild.mjs';
import { probeV2Names } from '../scripts/gdelt-v2-live-probe.mjs';

class MemoryTable {
  rows = new Map();
  key(partitionKey, rowKey) { return `${partitionKey}/${rowKey}`; }
  async getEntity(partitionKey, rowKey) {
    const value = this.rows.get(this.key(partitionKey, rowKey));
    if (!value) throw Object.assign(new Error('missing'), { statusCode: 404 });
    return { ...value };
  }
  async createEntity(value) {
    const key = this.key(value.partitionKey, value.rowKey);
    if (this.rows.has(key)) throw Object.assign(new Error('conflict'), { statusCode: 409 });
    this.rows.set(key, { ...value, etag: '1' });
  }
  async updateEntity(value, mode, options) {
    const key = this.key(value.partitionKey, value.rowKey);
    const current = this.rows.get(key);
    if (current?.etag !== options.etag) throw Object.assign(new Error('stale'), { statusCode: 412 });
    this.rows.set(key, { ...value, etag: String(Number(current.etag) + 1) });
  }
  async submitTransaction(batch) {
    for (const [action, value] of batch) {
      assert.equal(action, 'upsert');
      const key = this.key(value.partitionKey, value.rowKey);
      this.rows.set(key, { ...value, etag: String(Number(this.rows.get(key)?.etag || 0) + 1) });
    }
  }
}

class MemoryContainer {
  blobs = new Map();
  getBlobClient(name) { return { download: async () => {
    const value = this.blobs.get(name);
    if (!value) throw Object.assign(new Error('missing'), { statusCode: 404 });
    return { etag: value.etag, readableStreamBody: (async function* () { yield value.bytes; })() };
  } }; }
  getBlockBlobClient(name) { return { exists: async () => this.blobs.has(name),
    download: (...args) => this.getBlobClient(name).download(...args),
    uploadData: async (bytes, options) => {
    const current = this.blobs.get(name);
    if (options.conditions.ifNoneMatch && current) throw Object.assign(new Error('exists'), { statusCode: 409 });
    if (options.conditions.ifMatch && current?.etag !== options.conditions.ifMatch) {
      throw Object.assign(new Error('stale'), { statusCode: 412 });
    }
    const etag = String(Number(current?.etag || 0) + 1);
    this.blobs.set(name, { bytes, etag });
    return { etag };
  } }; }
}

function fixture(timestamp = '20261120013000', count = 1) {
  const name = 'Example Holdings';
  const nameHash = createHash('sha256').update('example holdings').digest('hex');
  const rows = Array.from({ length: count }, (_, index) => ({ partitionKey: `o-${nameHash[0]}`,
    rowKey: `${nameHash}_${timestamp}-${index}`, recordId: `${timestamp}-${index}`,
    publishedAt: '2026-11-20T01:30:00.000Z', source: 'example.test',
    url: `https://example.test/${index}`, title: `Example report ${index}`,
    language: 'en', matchedName: name, themes: 'GENERAL' }));
  return { byPartition: new Map([[`o-${nameHash[0]}`, rows]]), records: count, mentions: count };
}

function storedZip(name, content) {
  const filename = Buffer.from(name);
  const data = Buffer.from(content);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const centralOffset = local.length + filename.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

test('V2 interval replay is idempotent, bounded, and not verified by a writer alone', async () => {
  const timestamp = '20261120013000';
  const summaryTable = new MemoryTable();
  const manifestTable = new MemoryTable();
  const zip = Buffer.from('immutable source bytes');
  const parsed = fixture(timestamp, 200);
  await publishV2Interval({ timestamp, zip, parsed, summaryTable, manifestTable, concurrency: 4 });
  await publishV2Interval({ timestamp, zip, parsed, summaryTable, manifestTable, concurrency: 4 });
  const summary = await summaryTable.getEntity(summaryKey('organization', 'Example Holdings').partitionKey, 'summary');
  assert.equal(summary.mentionCount, 200);
  assert.equal(summary.unreviewedCount, 200);
  assert.equal(JSON.parse(summary.sampleRefs).length, 20);
  assert.equal(hasAppliedInterval(summary, timestamp), true);
  const manifest = await manifestTable.getEntity(timestamp.slice(0, 8), timestamp);
  assert.equal(manifest.mentionCount, 200);
  assert.equal(manifest.verified, false);
  await assert.rejects(() => advanceV2Watermark(new MemoryContainer(), manifestTable, timestamp), /not_committed/);
  await assert.rejects(() => publishV2Interval({ timestamp, zip: Buffer.from('different bytes'), parsed,
    summaryTable, manifestTable }), /manifest_conflict/);
});

test('independent verifier reopens raw ZIP and checks manifest, V1 posting, and summary bit', async () => {
  const timestamp = '20261120013000';
  const fields = Array(27).fill('');
  fields[0] = `${timestamp}-T7`;
  fields[1] = timestamp;
  fields[3] = 'example.test';
  fields[4] = 'https://example.test/article';
  fields[13] = 'Example Holdings';
  fields[26] = '<PAGE_TITLE>Example Holdings update</PAGE_TITLE>';
  const tsv = `${fields.join('\t')}\n`;
  const zip = storedZip(`${timestamp}.gkg.csv`, tsv);
  const parsed = entityRows(tsv);
  const summaryTable = new MemoryTable();
  const manifestTable = new MemoryTable();
  const v1Table = new MemoryTable();
  const container = new MemoryContainer();
  const rawName = `raw/gkg/2026/11/20/${timestamp}.gkg.csv.zip`;
  container.blobs.set(rawName, { bytes: zip, etag: '1' });
  for (const rows of parsed.byPartition.values()) for (const row of rows) await v1Table.createEntity(row);
  await publishV2Interval({ timestamp, zip, parsed, summaryTable, manifestTable });
  const result = await verifyV2Interval(timestamp, { container, summaryTable, manifestTable, v1Table });
  assert.equal(result.mentions, 1);
  assert.equal((await manifestTable.getEntity('20261120', timestamp)).verified, true);
  const state = await advanceV2Watermark(container, manifestTable, timestamp);
  assert.equal(state.committed_intervals, 1);
  const range = await verifyV2Range({ container, summaryTable, manifestTable, v1Table,
    sourceState: { coverage_start: '2026-11-20T01:30:00.000Z', coverage_end: '2026-11-20T01:30:00.000Z' },
    v2State: state, from: timestamp, to: timestamp, maxIntervals: 1 });
  assert.equal(range.checked, 1);
  assert.equal(range.more, false);
  container.blobs.set(rawName, { bytes: Buffer.from('corrupted'), etag: '2' });
  await assert.rejects(() => verifyV2Interval(timestamp, { container, summaryTable, manifestTable, v1Table }));
});

test('ingestion verifies V2 before advancing either coverage checkpoint', async () => {
  const timestamp = '20261120013000';
  const fields = Array(27).fill('');
  fields[0] = `${timestamp}-T7`;
  fields[1] = timestamp;
  fields[3] = 'example.test';
  fields[4] = 'https://example.test/article';
  fields[13] = 'Example Holdings';
  const tsv = `${fields.join('\t')}\n`;
  const zip = storedZip(`${timestamp}.gkg.csv`, tsv);
  const container = new MemoryContainer();
  container.blobs.set(`raw/gkg/2026/11/20/${timestamp}.gkg.csv.zip`, { bytes: zip, etag: '1' });
  const table = new MemoryTable();
  for (const rows of entityRows(tsv).byPartition.values()) {
    for (const row of rows) await table.createEntity(row);
  }
  table.submitTransaction = async () => assert.fail('stored V2 rebuild must not rewrite V1 postings');
  const v2 = { container, summaryTable: new MemoryTable(), manifestTable: new MemoryTable() };
  const result = await processGdeltInterval({ timestamp, container, table, v2, storedOnly: true });
  assert.equal(result.mentions, 1);
  assert.equal((await v2.manifestTable.getEntity('20261120', timestamp)).verified, true);
  assert.equal(JSON.parse(container.blobs.get('state/v2-watermark.json').bytes.toString()).committed_intervals, 1);
  await assert.rejects(() => processGdeltInterval({ timestamp: '20261120014500', container, table, v2,
    storedOnly: true }), /stored_zip_missing/);
});

test('stored rebuild accepts compact UTC interval boundaries and checkpoints each successful file', async () => {
  const timestamp = '20261120013000';
  const container = new MemoryContainer();
  const processed = [];
  const result = await rebuildStoredV2({ container, table: new MemoryTable(), v2: {},
    sourceState: { coverage_start: '2026-11-20T01:30:00.000Z', coverage_end: '2026-11-20T01:30:00.000Z' },
    from: timestamp, to: timestamp,
    processInterval: async ({ timestamp: value, storedOnly }) => { assert.equal(storedOnly, true); processed.push(value); } });
  assert.deepEqual(processed, [timestamp]);
  assert.equal(result.more, false);
  assert.equal(result.last_completed_interval, '2026-11-20T01:30:00.000Z');
  assert.equal(container.blobs.has('state/v2-rebuild.json'), false);
});

test('stored rebuild resumes forward and incorporates newly backfilled older intervals', async () => {
  const container = new MemoryContainer();
  const processed = [];
  const processInterval = async ({ timestamp }) => processed.push(timestamp);
  const initial = { coverage_start: '2026-11-20T01:00:00.000Z', coverage_end: '2026-11-20T01:30:00.000Z' };
  const input = { container, table: new MemoryTable(), v2: {}, processInterval };
  let result = await rebuildStoredV2({ ...input, sourceState: initial, maxIntervals: 2 });
  assert.equal(result.more, true);
  result = await rebuildStoredV2({ ...input, sourceState: initial, maxIntervals: 2 });
  assert.equal(result.more, false);
  assert.deepEqual(processed, ['20261120010000', '20261120011500', '20261120013000']);
  const expanded = { coverage_start: '2026-11-20T00:30:00.000Z', coverage_end: '2026-11-20T01:45:00.000Z' };
  result = await rebuildStoredV2({ ...input, sourceState: expanded, maxIntervals: 2 });
  assert.equal(result.more, true);
  result = await rebuildStoredV2({ ...input, sourceState: expanded, maxIntervals: 2 });
  assert.equal(result.more, false);
  assert.deepEqual(processed.slice(3), ['20261120004500', '20261120003000', '20261120014500']);
  assert.equal(result.first_completed_interval, '2026-11-20T00:30:00.000Z');
  assert.equal(result.last_completed_interval, '2026-11-20T01:45:00.000Z');
  await rebuildStoredV2({ ...input, sourceState: expanded, from: '20261120004500',
    to: '20261120004500' });
  const cursor = JSON.parse(container.blobs.get('state/v2-rebuild.json').bytes.toString());
  assert.equal(cursor.first_completed_interval, result.first_completed_interval);
  assert.equal(cursor.last_completed_interval, result.last_completed_interval);
});

test('legacy high-water cursor cannot certify unprocessed history', async () => {
  const container = new MemoryContainer();
  container.blobs.set('state/v2-rebuild.json', { etag: '1', bytes: Buffer.from(JSON.stringify({
    index_version: 2, last_completed_interval: '2026-11-20T01:30:00.000Z' })) });
  const processed = [];
  const result = await rebuildStoredV2({ container, table: new MemoryTable(), v2: {}, maxIntervals: 2,
    sourceState: { coverage_start: '2026-10-22T21:15:00.000Z', coverage_end: '2026-11-20T01:30:00.000Z' },
    processInterval: async ({ timestamp }) => processed.push(timestamp) });
  assert.deepEqual(processed, ['20261022211500', '20261022213000']);
  assert.equal(result.more, true);
  assert.equal(result.last_completed_interval, '2026-10-22T21:30:00.000Z');
  assert.equal(JSON.parse(container.blobs.get('state/v2-rebuild.json').bytes.toString()).cursor_version, 2);
});

test('V2 watermark cannot jump a missing interval and extends only across verified manifests', async () => {
  const manifestTable = new MemoryTable();
  const container = new MemoryContainer();
  const digest = 'a'.repeat(64);
  for (const timestamp of ['20261120010000', '20261120011500', '20261120014500']) {
    await manifestTable.createEntity({ ...v2Manifest(timestamp, digest, 1, 1, 1), verified: true });
  }
  let state = await advanceV2Watermark(container, manifestTable, '20261120010000');
  assert.equal(state.coverage_end, '20261120011500');
  state = await advanceV2Watermark(container, manifestTable, '20261120014500');
  assert.equal(state.coverage_end, '20261120011500');
  await manifestTable.createEntity({ ...v2Manifest('20261120013000', digest, 1, 1, 1), verified: true });
  state = await advanceV2Watermark(container, manifestTable, '20261120013000');
  assert.equal(state.coverage_end, '20261120014500');
  assert.equal(state.committed_intervals, 4);
});

test('explicit verifier range can audit a committed segment before full V2 coverage', async () => {
  const timestamp = '20261120010000';
  const sourceState = { coverage_start: '2026-11-20T01:00:00.000Z',
    coverage_end: '2026-11-20T01:30:00.000Z' };
  const container = { getBlobClient: () => { throw new Error('verifier_reached_raw_zip'); } };
  await assert.rejects(() => verifyV2Range({ container, summaryTable: {}, manifestTable: {},
    sourceState, v2State: { coverage_start: '20261120013000', coverage_end: '20261120013000' },
    from: timestamp, to: timestamp, maxIntervals: 1 }), /verifier_reached_raw_zip/);
  await assert.rejects(() => verifyV2Range({ container, summaryTable: {}, manifestTable: {},
    sourceState, v2State: null, maxIntervals: 1 }), /v2_watermark_required/);
});

test('ready V2 lookup uses only point reads and exposes unreviewed evidence', async () => {
  const summaryTable = new MemoryTable();
  const manifestTable = new MemoryTable();
  const timestamp = '20261120013000';
  const parsed = fixture(timestamp, 200);
  await publishV2Interval({ timestamp, zip: Buffer.from('source'), parsed, summaryTable, manifestTable });
  const state = { index_version: 2, coverage_start: timestamp, coverage_end: timestamp, committed_intervals: 1 };
  const request = { name: 'Example Holdings', aliases: [], entity_type: 'business', archive_all_stored: true,
    date_to: '2026-11-20' };
  const result = await searchV2Summary(request, { clients: { summaryTable }, state,
    sourceState: { coverage_start: '2026-11-20T01:30:00.000Z', coverage_end: '2026-11-20T01:30:00.000Z' },
    clock: () => Date.parse('2026-11-20T12:00:00Z') });
  assert.equal(result.complete, true);
  assert.equal(result.scan.mode, 'v2_point_summary');
  assert.equal(result.scan.rows_scanned, 0);
  assert.equal(result.scan.mentions_indexed, 200);
  assert.equal(result.scan.unreviewed_count, 200);
  assert.equal(result.results.length, 20);
  assert.equal(result.evidencePending, true);
});

test('live V2 probe reports only aggregate counts from two point reads per name', async () => {
  const summaryTable = new MemoryTable();
  await summaryTable.createEntity({ ...summaryKey('organization', 'Example Holdings'),
    indexVersion: 2, mentionCount: 3, unreviewedCount: 3,
    firstInterval: '20261120010000', lastInterval: '20261120013000',
    sampleRefs: JSON.stringify([{ url: 'https://example.test/private-path' }]) });
  const [result] = await probeV2Names(['Example Holdings'], { clients: { summaryTable } });
  assert.equal(result.point_reads, 2);
  assert.equal(result.matches[0].mention_count, 3);
  assert.equal(result.matches[0].sample_refs, 1);
  assert.equal(JSON.stringify(result).includes('private-path'), false);
});

test('V2 cannot clear older V1 history while its own watermark is still recent', async () => {
  const previous = process.env.GDELT_V2_READ_ENABLED;
  process.env.GDELT_V2_READ_ENABLED = 'true';
  try {
    let v1Queries = 0;
    const state = { coverage_start: new Date(Date.now() - 20 * 24 * 60 * 60_000).toISOString(),
      coverage_end: new Date(Date.now() - 60 * 60_000).toISOString() };
    const v2State = { index_version: 2, coverage_start: '20261120013000',
      coverage_end: '20261120013000', committed_intervals: 1 };
    const result = await searchLocalGdeltIndex({ name: 'Example Holdings', entity_type: 'business',
      archive_all_stored: true, date_to: new Date().toISOString().slice(0, 10) }, {
      state, v2State, v2Clients: { summaryTable: new MemoryTable() },
      clients: { table: { async *listEntities() { v1Queries += 1; } } }
    });
    assert.ok(v1Queries > 0);
    assert.notEqual(result.scan?.mode, 'v2_point_summary');
  } finally {
    if (previous === undefined) delete process.env.GDELT_V2_READ_ENABLED;
    else process.env.GDELT_V2_READ_ENABLED = previous;
  }
});

test('an Azure query-cap failure does not call public DOC, even when public fallback is enabled', async () => {
  const prior = process.env.GDELT_PUBLIC_FALLBACK_ENABLED;
  process.env.GDELT_PUBLIC_FALLBACK_ENABLED = 'true';
  try {
    let calls = 0;
    const result = await globalArchiveSearch({ name: 'Example Holdings', archive_all_stored: true },
      async () => { calls += 1; throw new Error('unexpected_public_call'); },
      async () => ({ results: [], complete: false, limitReason: 'scan_time_limit_exceeded',
        state: { coverage_start: '2026-10-22T00:00:00Z', coverage_end: '2026-11-20T01:30:00Z' } }));
    assert.equal(calls, 0);
    assert.equal(result.localFailure, 'scan_time_limit_exceeded');
  } finally {
    if (prior === undefined) delete process.env.GDELT_PUBLIC_FALLBACK_ENABLED;
    else process.env.GDELT_PUBLIC_FALLBACK_ENABLED = prior;
  }
});

test('production undated policy keeps an unavailable Azure archive Inconclusive without public DOC', async () => {
  const previous = process.env.GDELT_UNDATED_AZURE_ONLY;
  process.env.GDELT_UNDATED_AZURE_ONLY = 'true';
  try {
    let calls = 0;
    const result = await globalArchiveSearch({ name: 'Example Holdings', archive_all_stored: true },
      async () => { calls += 1; throw new Error('unexpected_public_call'); }, async () => null);
    assert.equal(calls, 0);
    assert.equal(result.complete, false);
    assert.equal(result.localFailure, 'watermark_unavailable');
  } finally {
    if (previous === undefined) delete process.env.GDELT_UNDATED_AZURE_ONLY;
    else process.env.GDELT_UNDATED_AZURE_ONLY = previous;
  }
});

test('complete source coverage with unreviewed archive mentions cannot produce Safe', async () => {
  const request = validateAdverseMediaRequest({ entity_type: 'business', name: 'Example Holdings', languages: ['en'] });
  const response = presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey: 'test',
    fetchImpl: async (input) => Response.json(new URL(input).pathname.includes('/news/')
      ? { results: [] } : { web: { results: [] } }),
    archiveSearch: async () => ({ results: [], complete: true, origin: 'local', hostedAttempts: 0,
      evidencePending: true, scan: { mode: 'v2_point_summary', mentions_indexed: 200, unreviewed_count: 200 },
      state: { coverage_start: '2026-11-01T00:00:00Z', coverage_end: '2026-11-20T01:30:00Z' } }) }));
  assert.equal(response.coverage.complete, true);
  assert.equal(response.coverage.archive_unreviewed_count, 200);
  assert.equal(response.summary.profile_status, 'inconclusive');
  assert.equal(response.summary.decision_eligible, false);
  assert.ok(response.coverage.reason_codes.includes('archive_evidence_unreviewed'));
});

test('a new archive watermark invalidates an otherwise reusable twelve-hour Safe cache', async () => {
  const request = validateAdverseMediaRequest({ entity_type: 'business', name: 'Archive Cache Marker Ltd',
    languages: ['en'] });
  let signature = 'archive-interval-a';
  let archiveCalls = 0;
  const options = { request, apiKey: 'test', cacheSignature: async () => signature,
    aiClassifier: async (results) => ({ status: 'not_needed', results, candidates: 0,
      inputTokens: 0, outputTokens: 0, cost: 0 }),
    fetchImpl: async (input) => Response.json(new URL(input).pathname.includes('/news/')
      ? { results: [] } : { web: { results: [] } }),
    archiveSearch: async () => { archiveCalls += 1; return { results: [], complete: true,
      origin: 'local', hostedAttempts: 0, state: { coverage_start: '2026-10-01T00:00:00Z',
        coverage_end: '2026-11-20T01:30:00Z' } }; } };
  const first = await screenAdverseMedia(options);
  assert.equal(first.usage.cache_hit, false);
  const second = await screenAdverseMedia(options);
  assert.equal(second.usage.cache_hit, true);
  assert.equal(archiveCalls, 1);
  signature = 'archive-interval-b';
  const third = await screenAdverseMedia(options);
  assert.equal(third.usage.cache_hit, false);
  assert.equal(archiveCalls, 2);
});
