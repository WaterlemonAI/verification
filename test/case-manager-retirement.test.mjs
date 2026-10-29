import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCustomerUsageStore, validateCasePolicy } from '../lib/customer-usage.mjs';
import { MemoryCaseManagerStore } from '../lib/case-manager-store.mjs';
import { drainCaseReconciliation } from '../scripts/reconcile-cases.mjs';

async function fixture() {
  const usageStore = new MemoryCustomerUsageStore();
  const caseStore = new MemoryCaseManagerStore();
  const workspaceId = 'synthetic-workspace';
  await usageStore.updateCasePolicy(workspaceId, validateCasePolicy({ version: 0, enabled: true, ttl_days: 30 }));
  const intent = await caseStore.createIntent({ workspaceId, serviceId: 'synthetic', transactionId: 'tx',
    acceptedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
  await caseStore.captureFinal(workspaceId, intent.id, { response: { synthetic: true },
    contentType: 'application/json', httpStatus: 200, outcome: 'unclassified' });
  await caseStore.prepareRetirement(workspaceId, 2);
  await usageStore.updateCasePolicy(workspaceId, validateCasePolicy({ version: 1, enabled: false }));
  return { usageStore, caseStore, workspaceId, intent };
}

test('durable policy floor recovers physical deletion when the queue is unavailable', async () => {
  const { usageStore, caseStore, workspaceId, intent } = await fixture();
  const counts = await drainCaseReconciliation({ usageStore, caseStore,
    queue: { async receiveMessages() { throw new Error('synthetic_queue_unavailable'); } },
    deadLetterQueue: { async sendMessage() { throw new Error('unexpected dead letter'); } },
    documentOcrStore: null });
  assert.equal(counts.errors, 1);
  assert.equal(counts.retirement_recovered, 1);
  assert.equal(caseStore.rows.has(intent.id), false);
  assert.equal(caseStore.payloads.has(intent.id), false);
  assert.deepEqual(await caseStore.pendingRetirements(), []);
  assert.equal((await usageStore.casePolicy(workspaceId)).enabled, false);
});

test('retirement dead letter retains the minimal identifiers needed for replay', async () => {
  const { usageStore, caseStore, workspaceId, intent } = await fixture();
  const originalRetire = caseStore.retireWorkspaceCases.bind(caseStore);
  caseStore.retireWorkspaceCases = async () => { throw new Error('synthetic_storage_outage'); };
  const deadLetters = [];
  const message = { version: 1, kind: 'retire', workspaceId, beforeVersion: 2, cursor: 'case-previous', attempt: 11 };
  let delivered = false;
  const queue = { async receiveMessages() { if (delivered) return { receivedMessageItems: [] }; delivered = true;
    return { receivedMessageItems: [{ messageId: 'm', popReceipt: 'p',
    messageText: Buffer.from(JSON.stringify(message)).toString('base64') }] }; },
  async deleteMessage() {} };
  const counts = await drainCaseReconciliation({ usageStore, caseStore, queue,
    deadLetterQueue: { async sendMessage(encoded) { deadLetters.push(JSON.parse(Buffer.from(encoded, 'base64').toString())); } },
    documentOcrStore: null });
  assert.equal(counts.dead_lettered, 1);
  assert.deepEqual(deadLetters[0], { version: 1, kind: 'retire', workspaceId, beforeVersion: 2,
    cursor: 'case-previous', attempt: 12, reason: 'retirement_exhausted' });
  assert.equal(caseStore.rows.has(intent.id), true);
  caseStore.retireWorkspaceCases = originalRetire;
  const [deferred] = caseStore.retirementTasks.values();
  await caseStore.advanceRetirementTask(deferred, { done: false, cursor: deferred.cursor }, { delayMs: 0 });
  const recovered = await drainCaseReconciliation({ usageStore, caseStore,
    queue: { async receiveMessages() { return { receivedMessageItems: [] }; } },
    deadLetterQueue: { async sendMessage() {} }, documentOcrStore: null });
  assert.equal(recovered.retirement_recovered, 1);
  assert.equal(caseStore.rows.has(intent.id), false);
});
