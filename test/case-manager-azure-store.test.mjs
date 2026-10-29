import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { AzureCaseManagerStore } from '../lib/case-manager-store.mjs';

class FakeTable {
  constructor() { this.entities = new Map(); this.failFinalUpdate = false; }
  key(partitionKey, rowKey) { return `${partitionKey}/${rowKey}`; }
  async getEntity(partitionKey, rowKey) {
    const row = this.entities.get(this.key(partitionKey, rowKey));
    if (!row) throw Object.assign(new Error('missing'), { statusCode: 404 });
    return { ...row };
  }
  async createEntity(row) {
    const key = this.key(row.partitionKey, row.rowKey);
    if (this.entities.has(key)) throw Object.assign(new Error('conflict'), { statusCode: 409 });
    this.entities.set(key, { ...row, etag: '1' });
  }
  async deleteEntity(partitionKey, rowKey) { this.entities.delete(this.key(partitionKey, rowKey)); }
  async submitTransaction(actions) {
    if (this.failFinalUpdate && actions[0][0] === 'update') {
      this.failFinalUpdate = false;
      throw Object.assign(new Error('temporary table failure'), { statusCode: 503 });
    }
    for (const [verb, entity] of actions) {
      const key = this.key(entity.partitionKey, entity.rowKey);
      if (verb === 'create') this.entities.set(key, { ...entity, etag: '1' });
      if (verb === 'delete') this.entities.delete(key);
      if (verb === 'update') this.entities.set(key, { ...entity, etag: '2' });
    }
  }
}

test('an interrupted Azure finalization keeps the first encrypted response on retry', async () => {
  const previousKey = process.env.CASE_MANAGER_DATA_KEY_V1_HEX;
  process.env.CASE_MANAGER_DATA_KEY_V1_HEX = 'a'.repeat(64);
  try {
  const table = new FakeTable();
  let encrypted = null;
  const blob = {
    async uploadData(bytes, options) {
      assert.equal(options.conditions.ifNoneMatch, '*');
      if (encrypted) throw Object.assign(new Error('already exists'), { statusCode: 412 });
      encrypted = Buffer.from(bytes);
    },
    async download() { return { readableStreamBody: Readable.from([encrypted]) }; }
  };
  const store = new AzureCaseManagerStore({ table, container: { getBlockBlobClient: () => blob }, queue: {} });
  const workspaceId = 'synthetic-workspace';
  const intent = await store.createIntent({ workspaceId, serviceId: 'synthetic-service',
    transactionId: 'tx-1', acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
  const first = { response: { decision: 'first' }, contentType: 'application/json', httpStatus: 200,
    outcome: 'review_required', reasonCodes: ['PARTIAL'] };
  table.failFinalUpdate = true;
  await assert.rejects(store.captureFinal(workspaceId, intent.id, first), /temporary table failure/);
  const second = { ...first, response: { decision: 'second' }, outcome: 'passed', reasonCodes: ['PASSED'] };
  await store.captureFinal(workspaceId, intent.id, second);
  const saved = await store.getCase(workspaceId, intent.id);
  assert.deepEqual(saved.payload.final_response, { decision: 'first' });
  assert.equal(saved.outcome, 'review_required');
  assert.deepEqual(saved.outcome_reason_codes, ['PARTIAL']);
  } finally {
    if (previousKey === undefined) delete process.env.CASE_MANAGER_DATA_KEY_V1_HEX;
    else process.env.CASE_MANAGER_DATA_KEY_V1_HEX = previousKey;
  }
});

test('workspace retirement advances a bounded cursor after parallel deletion', async () => {
  const rows = ['case-a', 'case-b', 'case-c'].map((rowKey) => ({ rowKey, policyVersion: 1 }));
  let query = 0;
  const table = { listEntities: () => (async function* () {
    for (const row of query++ === 0 ? rows : rows.slice(2)) yield row;
  })() };
  const store = new AzureCaseManagerStore({ table, container: { getBlockBlobClient: () => ({}) }, queue: {} });
  const deleted = [];
  store.deleteCaseRow = async (row) => { deleted.push(row.rowKey); };
  const first = await store.retireWorkspaceCases('synthetic-workspace', 2, { limit: 2 });
  assert.deepEqual(first, { done: false, cursor: 'case-b' });
  assert.deepEqual(deleted.sort(), ['case-a', 'case-b']);
  const last = await store.retireWorkspaceCases('synthetic-workspace', 2, { cursor: first.cursor, limit: 2 });
  assert.deepEqual(last, { done: true, cursor: '' });
  assert.deepEqual(deleted.sort(), ['case-a', 'case-b', 'case-c']);
});
