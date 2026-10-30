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
    for (const [verb, entity, mode] of actions) {
      const key = this.key(entity.partitionKey, entity.rowKey);
      if (verb === 'create') this.entities.set(key, { ...entity, etag: '1' });
      if (verb === 'delete') this.entities.delete(key);
      if (verb === 'update') this.entities.set(key, { ...(mode === 'Merge' ? this.entities.get(key) : {}), ...entity, etag: '2' });
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

test('Azure transaction index resolves original and replay attempts only inside their workspace', async () => {
  const table = new FakeTable();
  const store = new AzureCaseManagerStore({ table,
    container: { getBlockBlobClient: () => ({ deleteIfExists: async () => {} }) }, queue: {} });
  const input = { workspaceId: 'workspace-a', serviceId: 'synthetic-service', transactionId: 'tx-original',
    logicalKey: 'logical-check', acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 };
  const first = await store.createIntent(input);
  const replay = await store.createIntent({ ...input, transactionId: 'tx-replay' });
  assert.equal(replay.id, first.id);
  assert.equal((await store.findByTransaction('workspace-a', 'tx-original', { activePolicyVersion: 1 })).id, first.id);
  assert.equal((await store.findByTransaction('workspace-a', 'tx-replay', { activePolicyVersion: 1 })).id, first.id);
  assert.equal(await store.findByTransaction('workspace-b', 'tx-original'), null);
  assert.equal(await store.findByTransaction('workspace-a', 'tx-original', { activePolicyVersion: 2 }), null);
  await store.deleteCaseRow(await store.row('workspace-a', first.id));
  assert.equal(await store.findByTransaction('workspace-a', 'tx-original'), null);
  assert.equal(await store.findByTransaction('workspace-a', 'tx-replay'), null);
});

test('intent marker creation waits for both writes before cleaning up a failed admission', async () => {
  const table = new FakeTable();
  const create = table.createEntity.bind(table);
  table.createEntity = async (row) => {
    if (row.partitionKey === 'pending') throw Object.assign(new Error('pending unavailable'), { statusCode: 503 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return create(row);
  };
  const store = new AzureCaseManagerStore({ table,
    container: { getBlockBlobClient: () => ({}) }, queue: {} });
  await assert.rejects(store.createIntent({ workspaceId: 'synthetic-workspace', serviceId: 'synthetic-service',
    transactionId: 'tx-failed', acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 }), /pending unavailable/);
  assert.equal([...table.entities.keys()].some((key) => key.startsWith('expiry/') || key.startsWith('pending/')), false);
});

test('a failed pending-marker cleanup does not turn a committed final response into a capture failure', async () => {
  const previousKey = process.env.CASE_MANAGER_DATA_KEY_V1_HEX;
  process.env.CASE_MANAGER_DATA_KEY_V1_HEX = 'a'.repeat(64);
  try {
    const table = new FakeTable();
    let encrypted;
    const blob = {
      async uploadData(bytes) { encrypted = Buffer.from(bytes); },
      async download() { return { readableStreamBody: Readable.from([encrypted]) }; }
    };
    const store = new AzureCaseManagerStore({ table, container: { getBlockBlobClient: () => blob }, queue: {} });
    const workspaceId = 'synthetic-workspace';
    const intent = await store.createIntent({ workspaceId, serviceId: 'synthetic-service', transactionId: 'tx-cleanup',
      acceptedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
    const remove = table.deleteEntity.bind(table);
    table.deleteEntity = async (partitionKey, rowKey) => {
      if (partitionKey === 'pending') throw Object.assign(new Error('pending cleanup unavailable'), { statusCode: 503 });
      return remove(partitionKey, rowKey);
    };
    const captured = await store.captureFinal(workspaceId, intent.id, { response: { marker: 'synthetic' },
      contentType: 'application/json', httpStatus: 200, outcome: 'unclassified' });
    assert.equal(captured.state, 'complete');
    assert.deepEqual((await store.getCase(workspaceId, intent.id)).payload.final_response, { marker: 'synthetic' });
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

test('Azure purge retains the expiry marker until a failed row deletion can be retried', async () => {
  const table = new FakeTable();
  const store = new AzureCaseManagerStore({ table,
    container: { getBlockBlobClient: () => ({ deleteIfExists: async () => {} }) }, queue: {} });
  const intent = await store.createIntent({ workspaceId: 'synthetic-workspace', serviceId: 'synthetic-service',
    transactionId: 'tx', acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
  const row = await store.row('synthetic-workspace', intent.id);
  const originalDelete = table.deleteEntity.bind(table);
  let failed = false;
  table.deleteEntity = async (partitionKey, rowKey) => {
    if (!failed && rowKey === row.rowKey) {
      failed = true;
      throw Object.assign(new Error('temporary table failure'), { statusCode: 503 });
    }
    return originalDelete(partitionKey, rowKey);
  };
  await assert.rejects(store.deleteCaseRow(row), /temporary table failure/);
  assert.ok(table.entities.has(table.key('expiry', `${row.expiresAt}-${row.caseId}`)));
  await store.deleteCaseRow(row);
  assert.equal(table.entities.has(table.key('expiry', `${row.expiresAt}-${row.caseId}`)), false);
  assert.equal(table.entities.has(table.key(row.partitionKey, row.rowKey)), false);
});

test('Azure pagination advances past more than 1,000 hidden index rows', async () => {
  const indexes = Array.from({ length: 1002 }, (_, index) => ({
    rowKey: `idx-all-all-${String(index).padStart(4, '0')}`, caseId: String(index)
  }));
  let query = 0;
  const table = { listEntities: () => (async function* () {
    for (const index of query++ === 0 ? indexes : indexes.slice(1000)) yield index;
  })() };
  const store = new AzureCaseManagerStore({ table, container: { getBlockBlobClient: () => ({}) }, queue: {} });
  store.row = async (_workspaceId, caseId) => ({ caseId, serviceId: 'synthetic', acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: Number(caseId) === 1001 ? 2 : 1,
    state: 'complete', outcome: 'unclassified', reasonCodesJson: '[]', attemptIdsJson: '[]' });
  const first = await store.listCases('synthetic-workspace', { activePolicyVersion: 2 });
  assert.deepEqual(first.cases, []);
  assert.equal(first.next_cursor, indexes[999].rowKey);
  const second = await store.listCases('synthetic-workspace', { activePolicyVersion: 2, cursor: first.next_cursor });
  assert.equal(second.cases.length, 1);
  assert.equal(second.cases[0].id, '1001');
  assert.equal(second.next_cursor, null);
});

test('Azure age gauges query only the first expiry and pending index keys', async () => {
  const filters = [];
  const table = { listEntities({ queryOptions }) {
    const filter = String(queryOptions.filter);
    filters.push(filter);
    const rowKey = filter.includes("'expiry'") ? '2026-10-29T11:00:00.000Z-expired'
      : '2026-10-30T11:30:00.000Z-pending';
    return (async function* () { yield { rowKey }; })();
  } };
  const store = new AzureCaseManagerStore({ table, container: {} });
  const at = new Date('2026-10-30T12:00:00.000Z');
  assert.equal(await store.oldestExpiredAgeSeconds(at), 25 * 3600);
  assert.equal(await store.oldestPendingAgeSeconds(at), 30 * 60);
  assert.match(filters[0], /PartitionKey eq 'expiry'/);
  assert.match(filters[1], /PartitionKey eq 'pending'/);
});
