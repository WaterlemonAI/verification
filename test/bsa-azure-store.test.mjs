import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { before, test } from 'node:test';
import { AzureBsaStore } from '../lib/bsa-azure-store.mjs';
import { encryptBsa } from '../lib/bsa-crypto.mjs';

process.env.BSA_DATA_KEY_HEX = '33'.repeat(32);

class FakeContainer {
  constructor() { this.blobs = new Map(); }
  getBlockBlobClient(name) {
    return { uploadData: async (bytes) => { this.blobs.set(name, Buffer.from(bytes)); } };
  }
  getBlobClient(name) {
    return { download: async () => {
      if (!this.blobs.has(name)) { const error = new Error('missing'); error.statusCode = 404; throw error; }
      return { readableStreamBody: Readable.from([this.blobs.get(name)]) };
    } };
  }
}

class FakeTable {
  constructor() { this.entities = new Map(); }
  key(partitionKey, rowKey) { return `${partitionKey}:${rowKey}`; }
  async getEntity(partitionKey, rowKey) {
    const entity = this.entities.get(this.key(partitionKey, rowKey));
    if (!entity) { const error = new Error('missing'); error.statusCode = 404; throw error; }
    return { ...entity };
  }
  async submitTransaction(actions) {
    for (const [action, entity] of actions) {
      assert.equal(action, 'create');
      const key = this.key(entity.partitionKey, entity.rowKey);
      if (this.entities.has(key)) { const error = new Error('exists'); error.statusCode = 409; throw error; }
    }
    for (const [, entity] of actions) this.entities.set(this.key(entity.partitionKey, entity.rowKey), { ...entity });
  }
  async updateEntity(entity) {
    const key = this.key(entity.partitionKey, entity.rowKey);
    this.entities.set(key, { ...this.entities.get(key), ...entity });
  }
}

let container;
let table;
let queue;
let store;

before(() => {
  container = new FakeContainer();
  table = new FakeTable();
  queue = { messages: [], async sendMessage(message) { this.messages.push(message); } };
  store = new AzureBsaStore({ accountUrl: 'https://example.blob.core.windows.net', container, table, queue });
});

test('Azure BSA store encrypts tenant jobs, preserves idempotency and isolates results', async () => {
  const request = { ownerId: 'tenant-one', idempotencyKey: 'unique-request-001',
    files: [{ bytes: Buffer.from('%PDF-private'), mediaType: 'application/pdf' }],
    fields: { countryCode: 'AE', entityType: 'company', getPdf: true } };
  const created = await store.createJob(request);
  assert.equal(created.reused, false);
  assert.match(created.job.id, /^bsa_[0-9a-f-]{36}$/);
  assert.equal(queue.messages.length, 1);
  const encryptedInput = [...container.blobs.entries()].find(([name]) => name.endsWith('/input-0.bin'))[1];
  assert.equal(encryptedInput.subarray(0, 4).toString(), 'BSA1');
  assert.notEqual(encryptedInput.subarray(0, 5).toString(), '%PDF-');

  const repeated = await store.createJob(request);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.job.id, created.job.id);
  assert.equal(queue.messages.length, 1);
  assert.equal(await store.getJob(created.job.id, 'tenant-two'), null);

  const ownerPartition = [...table.entities.values()].find((entity) => entity.analysisId === created.job.id && entity.rowKey.startsWith('job_')).partitionKey;
  const jobKey = table.key(ownerPartition, `job_${created.job.id}`);
  const jobEntity = table.entities.get(jobKey);
  table.entities.set(jobKey, { ...jobEntity, status: 'completed', completedAt: new Date().toISOString() });
  container.blobs.set(`${ownerPartition}/${created.job.id}/result.bin`, encryptBsa(Buffer.from(JSON.stringify({
    analysisId: created.job.id, status: 'completed', artifacts: [{ filename: 'ledger.json' }]
  }))));
  container.blobs.set(`${ownerPartition}/${created.job.id}/artifact.ledger.json.bin`, encryptBsa(Buffer.from('{"transactions":[]}')));
  assert.equal((await store.getResult(created.job.id, 'tenant-one')).result.status, 'completed');
  assert.equal((await store.getArtifact(created.job.id, 'tenant-one', 'ledger.json')).toString(), '{"transactions":[]}');
  assert.equal(await store.getArtifact(created.job.id, 'tenant-two', 'ledger.json'), null);
});
