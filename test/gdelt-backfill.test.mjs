import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceBackfillState, nextBackfillInterval, runBackfill, weekendWindow } from '../scripts/gdelt-backfill.mjs';
import { processGdeltInterval, saveArchiveState } from '../scripts/gdelt-ingest.mjs';

const originalState = {
  version: 1,
  coverage_start: '2026-10-22T21:15:00.000Z',
  coverage_end: '2026-11-20T01:30:00.000Z',
  last_successful_at: '2026-11-20T01:55:00.000Z',
  files_processed: 100,
  entity_mentions_indexed: 5000
};

test('Saturday 22:00–Sunday 00:00 UAE is exactly Saturday 18:00–20:00 UTC', () => {
  assert.equal(weekendWindow('2026-11-21T17:59:59Z'), null);
  assert.deepEqual(weekendWindow('2026-11-21T18:00:00Z'), {
    start: Date.parse('2026-11-21T18:00:00Z'), deadline: Date.parse('2026-11-21T20:00:00Z')
  });
  assert.ok(weekendWindow('2026-11-21T19:59:59Z'));
  assert.equal(weekendWindow('2026-11-21T20:00:00Z'), null);
  assert.equal(weekendWindow('2026-11-22T18:00:00Z'), null);
});

test('each committed interval extends coverage backward and preserves the daily watermark', () => {
  const timestamp = nextBackfillInterval(originalState, '2026-11-21T18:00:00Z');
  assert.equal(timestamp, '20261022210000');
  const next = advanceBackfillState(originalState, timestamp, { records: 10, mentions: 20 },
    new Date('2026-11-21T18:01:00Z'));
  assert.equal(next.coverage_start, '2026-10-22T21:00:00.000Z');
  assert.equal(next.coverage_end, originalState.coverage_end);
  assert.equal(next.last_successful_at, originalState.last_successful_at);
  assert.equal(next.files_processed, 101);
  assert.equal(next.backfill.files_processed_total, 1);
  assert.throws(() => advanceBackfillState(originalState, '20261022204500', { records: 1, mentions: 1 }),
    /not_contiguous/);
});

test('a failed file retains the last committed checkpoint and resumes next run', async () => {
  let persisted = structuredClone(originalState);
  let now = new Date('2026-11-21T18:00:00Z');
  const firstCalls = [];
  await assert.rejects(runBackfill({ state: persisted, clock: () => now,
    processInterval: async (timestamp) => {
      firstCalls.push(timestamp);
      if (firstCalls.length === 2) throw new Error('source unavailable');
      now = new Date('2026-11-21T18:30:00Z');
      return { records: 10, mentions: 20 };
    },
    saveState: async (state) => { persisted = state; }
  }), /source unavailable/);
  assert.deepEqual(firstCalls, ['20261022210000', '20261022204500']);
  assert.equal(persisted.coverage_start, '2026-10-22T21:00:00.000Z');

  now = new Date('2026-11-28T18:00:00Z');
  const resumed = [];
  const result = await runBackfill({ state: persisted, clock: () => now,
    processInterval: async (timestamp) => {
      resumed.push(timestamp);
      now = new Date('2026-11-28T19:59:00Z');
      return { records: 4, mentions: 8 };
    },
    saveState: async (state) => { persisted = state; }
  });
  assert.deepEqual(resumed, ['20261022204500']);
  assert.equal(result.status, 'window_closed');
  assert.equal(persisted.coverage_start, '2026-10-22T20:45:00.000Z');
  assert.equal(persisted.coverage_end, originalState.coverage_end);
});

test('a failed checkpoint is not counted and replays its deterministic interval', async () => {
  const now = () => new Date('2026-11-21T18:00:00Z');
  await assert.rejects(runBackfill({ state: originalState, clock: now,
    processInterval: async () => ({ records: 10, mentions: 20 }),
    saveState: async () => { throw new Error('etag conflict'); }
  }), /etag conflict/);
  assert.equal(originalState.coverage_start, '2026-10-22T21:15:00.000Z');
  assert.equal(nextBackfillInterval(originalState, now()), '20261022210000');
});

test('deadline interruption leaves an in-flight interval uncommitted', async () => {
  let now = new Date('2026-11-21T19:50:00Z');
  let persisted = structuredClone(originalState);
  const controller = new AbortController();
  const result = await runBackfill({ state: persisted, clock: () => now, signal: controller.signal,
    processInterval: async () => {
      now = new Date('2026-11-21T19:59:55Z');
      controller.abort(new Error('backfill_window_closed'));
      throw controller.signal.reason;
    },
    saveState: async (state) => { persisted = state; }
  });
  assert.equal(result.status, 'window_closed');
  assert.equal(result.files_processed, 0);
  assert.equal(persisted.coverage_start, originalState.coverage_start);
});

test('missing source with no stored ZIP fails rather than creating a coverage gap', async () => {
  await assert.rejects(processGdeltInterval({ timestamp: '20261022210000',
    container: { getBlockBlobClient: () => ({ exists: async () => false }) },
    table: {}, fetchAttempts: 1, fetchImpl: async () => new Response('', { status: 404 })
  }), /gdelt_source_missing_20261022210000/);
});

test('watermark writes are conditional on the version read by the job', async () => {
  let saved;
  const container = { getBlockBlobClient: () => ({ uploadData: async (_bytes, options) => {
    saved = options;
    return { etag: 'new-etag' };
  } }) };
  assert.equal(await saveArchiveState(container, originalState, 'old-etag'), 'new-etag');
  assert.deepEqual(saved.conditions, { ifMatch: 'old-etag' });
  await saveArchiveState(container, originalState, null);
  assert.deepEqual(saved.conditions, { ifNoneMatch: '*' });
});
