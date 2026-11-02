import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCaseManagerStore } from '../lib/case-manager-store.mjs';
import { purgeCases } from '../scripts/purge-cases.mjs';

test('purge deletes only expired Case Manager copies in bounded batches', async () => {
  const store = new MemoryCaseManagerStore();
  const now = Date.now();
  for (let index = 0; index < 5; index++) {
    await store.createIntent({ workspaceId: 'workspace-a', serviceId: 'synthetic', transactionId: `tx-${index}`,
      acceptedAt: new Date(now - 86_400_000).toISOString(), expiresAt: new Date(now + (index < 3 ? -1 : 86_400_000)).toISOString(),
      policyVersion: 1 });
  }
  const first = await purgeCases({ store, now: new Date(now), maxPerRun: 2, batchSize: 1 });
  assert.deepEqual(first, { removed: 2, limit_reached: true });
  const second = await purgeCases({ store, now: new Date(now), maxPerRun: 10, batchSize: 2 });
  assert.deepEqual(second, { removed: 1, limit_reached: false });
  assert.equal(store.rows.size, 2);
});

test('sanitized age gauges track pending cases and the oldest undeleted expired copy', async () => {
  const store = new MemoryCaseManagerStore();
  const at = new Date('2026-10-30T12:00:00.000Z');
  await store.createIntent({ workspaceId: 'workspace-a', serviceId: 'synthetic', transactionId: 'expired',
    acceptedAt: '2026-10-29T08:00:00.000Z', expiresAt: '2026-10-29T12:00:00.000Z', policyVersion: 1 });
  assert.equal(await store.oldestPendingAgeSeconds(at), 28 * 3600);
  assert.equal(await store.oldestExpiredAgeSeconds(at), 24 * 3600);
  await purgeCases({ store, now: at });
  assert.equal(await store.oldestExpiredAgeSeconds(at), 0);
  assert.equal(await store.oldestPendingAgeSeconds(at), 0);
});
