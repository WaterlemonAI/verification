import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AzureEjariStore } from '../lib/ejari-store.mjs';

process.env.EJARI_DATA_ROOT_KEY_HEX = 'f'.repeat(64);
const missing = () => Object.assign(new Error('not found'), { statusCode: 404 });

class FakeTable {
  rows = new Map();
  async getEntity(pk, rk) { const value = this.rows.get(`${pk}/${rk}`); if (!value) throw missing(); return { ...value }; }
  async submitTransaction(actions) {
    for (const [, row] of actions) if (this.rows.has(`${row.partitionKey}/${row.rowKey}`)) throw Object.assign(new Error('conflict'), { statusCode: 409 });
    for (const [, row] of actions) this.rows.set(`${row.partitionKey}/${row.rowKey}`, { ...row });
  }
  async updateEntity(row) { this.rows.set(`${row.partitionKey}/${row.rowKey}`,
    { ...this.rows.get(`${row.partitionKey}/${row.rowKey}`), ...row }); }
  async upsertEntity(row) { this.rows.set(`${row.partitionKey}/${row.rowKey}`, { ...row }); }
}

test('Ejari store encrypts input, isolates tenants and conflicts on changed idempotent input', async () => {
  const blobs = new Map();
  const sent = [];
  const container = {
    getBlockBlobClient(name) { return { async uploadData(bytes) { blobs.set(name, bytes); } }; },
    getBlobClient(name) { return { async download() { const bytes = blobs.get(name); if (!bytes) throw missing();
      return { readableStreamBody: (async function* () { yield bytes; })() }; } }; }
  };
  const store = new AzureEjariStore({ accountUrl: 'https://fake.blob.core.windows.net', credential: {}, container,
    table: new FakeTable(), expiryTable: new FakeTable(), queue: { async sendMessage(value) { sent.push(value); } } });
  const input = { workspaceId: 'workspace-one', idempotencyKey: 'synthetic-idempotency-001',
    fields: { contract_number: '0120221004004205', dewa_number: '128053950', input_pdf: false } };
  const first = await store.createJob(input);
  assert.equal(first.reused, false);
  assert.equal(sent.length, 1);
  assert.equal(blobs.size, 1);
  const storedBytes = [...blobs.values()][0];
  assert.equal(storedBytes.includes(Buffer.from(input.fields.contract_number)), false);
  assert.equal((await store.getJob(first.job.id, 'workspace-two')), null);
  const replay = await store.createJob(input);
  assert.equal(replay.reused, true);
  assert.equal(replay.job.id, first.job.id);
  assert.equal(sent.length, 1);
  await assert.rejects(() => store.createJob({ ...input, fields: { ...input.fields, dewa_number: '99999999' } }), /idempotency_conflict/);
  assert.equal(store.expiryTable.rows.size, 1);
  assert.equal([...store.expiryTable.rows.values()][0].jobPartition.includes('workspace-one'), false);
});
