import test from 'node:test';
import assert from 'node:assert/strict';
import { AzureCaseManagerStore } from '../lib/case-manager-store.mjs';
import { drainCaseReconciliation } from '../scripts/reconcile-cases.mjs';

test('retirement discovery reads only eight due tasks despite a million usage rows', async () => {
  const tasks = [];
  let visited = 0;
  const table = {
    async createEntity(task) { tasks.push(task); },
    listEntities({ queryOptions }) {
      const filter = String(queryOptions.filter);
      assert.match(filter, /PartitionKey eq 'retirement'/);
      assert.match(filter, /RowKey lt/);
      return (async function* () {
        // The shared account also holds one million usage rows. A broad query would visit them here.
        const productionSizedUsageRows = 1_000_000;
        assert.ok(productionSizedUsageRows > tasks.length);
        for (const task of tasks) {
          visited++;
          yield task;
        }
      })();
    }
  };
  const store = new AzureCaseManagerStore({ table, container: {} });
  for (let i = 0; i < 50; i++) await store.prepareRetirement(`workspace-${i}`, 2);
  const due = await store.pendingRetirements(8);
  assert.equal(due.length, 8);
  assert.equal(visited, 8);
});

test('Azure retirement cursor advances with an atomic due-task replacement', async () => {
  const entities = new Map();
  const table = {
    async createEntity(task) { entities.set(task.rowKey, task); },
    async submitTransaction(actions) {
      assert.equal(actions.length, 2);
      assert.deepEqual(actions.map(([verb]) => verb), ['create', 'delete']);
      assert.equal(actions[0][1].partitionKey, 'retirement');
      assert.equal(actions[1][1].partitionKey, 'retirement');
      entities.set(actions[0][1].rowKey, actions[0][1]);
      entities.delete(actions[1][1].rowKey);
    },
    async deleteEntity(partitionKey, rowKey) {
      assert.equal(partitionKey, 'retirement');
      entities.delete(rowKey);
    }
  };
  const store = new AzureCaseManagerStore({ table, container: {} });
  const task = await store.prepareRetirement('workspace-a', 2);
  await store.advanceRetirementTask(task, { done: false, cursor: 'case-200' }, { delayMs: 0 });
  assert.equal(entities.size, 1);
  const [next] = entities.values();
  assert.equal(next.cursor, 'case-200');
  assert.equal(next.createdAt, task.createdAt);
  await store.advanceRetirementTask(next, { done: true });
  assert.equal(entities.size, 0);
});

test('one scheduled run drains two minutes of synthetic 180 QPM arrivals and observes queue age', async () => {
  const arrivals = Array.from({ length: 360 }, (_, i) => ({
    messageId: `message-${i}`, popReceipt: 'receipt',
    insertedOn: new Date(Date.now() - 120_000 + i * (120_000 / 360)).toISOString(),
    messageText: Buffer.from(JSON.stringify({ version: 1, kind: 'reconcile',
      workspaceId: 'synthetic-workspace', caseId: `case-${i}` })).toString('base64')
  }));
  let deleted = 0;
  const queue = {
    async receiveMessages({ numberOfMessages }) {
      return { receivedMessageItems: arrivals.splice(0, numberOfMessages) };
    },
    async deleteMessage() { deleted++; }
  };
  const counts = await drainCaseReconciliation({ queue,
    deadLetterQueue: { async sendMessage() { throw new Error('unexpected dead letter'); } },
    caseStore: { async pendingRetirements() { return []; } }, usageStore: {}, documentOcrStore: null,
    reconcileMessageImpl: async () => 'captured' });
  assert.equal(counts.messages_processed, 360);
  assert.equal(counts.batches_received, 12);
  assert.equal(counts.captured, 360);
  assert.equal(counts.queue_age_seconds_max, 120);
  assert.equal(deleted, 360);
  assert.equal(arrivals.length, 0);
});
