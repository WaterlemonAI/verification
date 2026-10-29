import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCaseManagerStore, createCaseManagerStore } from '../lib/case-manager-store.mjs';

test('global off creates no Case Manager store or storage calls', () => {
  const old = process.env.CASE_MANAGER_ENABLED;
  delete process.env.CASE_MANAGER_ENABLED;
  assert.equal(createCaseManagerStore(), null);
  if (old !== undefined) process.env.CASE_MANAGER_ENABLED = old;
});

test('workspace-scoped intents, replay attempts, exact expiry, and final content', async () => {
  const store = new MemoryCaseManagerStore();
  const input = { workspaceId: 'workspace-a', serviceId: 'adverse-media', transactionId: 'tx-1',
    logicalKey: 'same-check', acceptedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 };
  const first = await store.createIntent(input);
  const replay = await store.createIntent({ ...input, transactionId: 'tx-2' });
  assert.equal(replay.id, first.id);
  assert.deepEqual(replay.attempt_ids, ['tx-1', 'tx-2']);
  const final = { status: 'partial', evidence: [{ name: '<img onerror=alert(1)>', reason: 'sample' }], callback_signing_secret: 'hide' };
  await store.captureFinal('workspace-a', first.id, { response: final, contentType: 'application/json', httpStatus: 200,
    outcome: 'review_required', reasonCodes: ['PARTIAL_COVERAGE'] });
  const visible = await store.getCase('workspace-a', first.id, { activePolicyVersion: 1 });
  assert.equal(visible.payload.final_response.evidence[0].name, '<img onerror=alert(1)>');
  assert.equal(visible.payload.final_response.callback_signing_secret, '[REDACTED]');
  assert.equal((await store.getCase('workspace-b', first.id)), null);
  assert.equal((await store.getCase('workspace-a', first.id, { activePolicyVersion: 2 })), null);
  assert.equal((await store.listCases('workspace-a', { outcome: 'review_required', activePolicyVersion: 1 })).cases.length, 1);
  assert.equal((await store.listCases('workspace-b')).cases.length, 0);
  store.rows.get(first.id).expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal((await store.getCase('workspace-a', first.id)), null);
  assert.equal((await store.listCases('workspace-a')).cases.length, 0);
  assert.equal(await store.purgeExpired(), 1);
  assert.equal(store.payloads.has(first.id), false);
});
