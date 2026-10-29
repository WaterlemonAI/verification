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
