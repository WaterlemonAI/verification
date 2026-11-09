import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AzureFloStore, MemoryFloStore } from '../lib/flows/store.mjs';
import { sha256 } from '../lib/flows/crypto.mjs';
import { encryptBytes, decryptBytes } from '../lib/flows/crypto.mjs';

process.env.FLO_DATA_KEY_HEX = '11'.repeat(32);

test('case is durable at link issue, scoped and never expires with link', async () => {
  const store = new MemoryFloStore();
  const workspace = '1234567890abcdef';
  const input = { customer_reference: 'REF', supplier_email: 'a@example.com', prefill: {} };
  const result = await store.createCase(workspace, input, 'idem-12345678', sha256('link-1'), { enabled: true });
  assert.equal(result.reused, false);
  assert.equal(result.case.expires_at, null);
  assert.equal(result.case.status, 'link_issued');
  assert.equal((await store.createCase(workspace, input, 'idem-12345678', sha256('link-2'), {})).case.application_id,
    result.case.application_id);
  await assert.rejects(store.createCase(workspace, { ...input, customer_reference: 'CHANGED' }, 'idem-12345678', sha256('link-3'), {}));
  assert.equal(await store.getCase('fedcba0987654321', result.case.application_id), null);
  await store.updateCase(workspace, result.case.application_id, (item) => { item.link_expires_at = '2000-01-01T00:00:00.000Z'; return item; });
  assert.equal((await store.listCases(workspace)).length, 1);
  const documentId = randomUUID();
  await store.putEvidence(workspace, result.case.application_id, documentId, Buffer.from('private document'));
  assert.equal((await store.getEvidence(workspace, result.case.application_id, documentId)).toString(), 'private document');
  assert.equal(await store.getEvidence('fedcba0987654321', result.case.application_id, documentId), null);
});

test('versioned Flo envelopes remain decryptable after active key rotates', () => {
  process.env.FLO_DATA_KEY_V1_HEX = '11'.repeat(32);
  process.env.FLO_DATA_KEY_V2_HEX = '22'.repeat(32);
  process.env.FLO_ACTIVE_KEY_VERSION = '1';
  const old = encryptBytes(Buffer.from('retained case'));
  process.env.FLO_ACTIVE_KEY_VERSION = '2';
  const current = encryptBytes(Buffer.from('new case'));
  assert.equal(decryptBytes(old).toString(), 'retained case');
  assert.equal(decryptBytes(current).toString(), 'new case');
  delete process.env.FLO_ACTIVE_KEY_VERSION;
});

test('Azure creation repairs an abandoned idempotency marker without losing its case ID', async () => {
  const workspace = '1234567890abcdef';
  const applicationId = randomUUID();
  const input = { customer_reference: 'REF', supplier_email: 'a@example.com', prefill: {} };
  const idempotencyKey = 'idem-recovery-123';
  const rows = new Map(); const blobs = new Map();
  const key = (partitionKey, rowKey) => `${partitionKey}:${rowKey}`;
  rows.set(key(workspace, `idem-${sha256(`${workspace}:kys-v1:${idempotencyKey}`)}`), {
    partitionKey: workspace, rowKey: `idem-${sha256(`${workspace}:kys-v1:${idempotencyKey}`)}`,
    applicationId, fingerprint: sha256(JSON.stringify(input)), createdAt: '2000-01-01T00:00:00Z', ready: false
  });
  const notFound = () => Object.assign(new Error('missing'), { statusCode: 404 });
  const table = {
    async getEntity(partitionKey, rowKey) { const row = rows.get(key(partitionKey, rowKey)); if (!row) throw notFound(); return { ...row }; },
    async upsertEntity(row) { rows.set(key(row.partitionKey, row.rowKey), { ...row }); },
    async updateEntity(row) { rows.set(key(row.partitionKey, row.rowKey), { ...rows.get(key(row.partitionKey, row.rowKey)), ...row }); }
  };
  const container = { getBlockBlobClient: (path) => ({
    async uploadData(value, options) {
      if (options?.conditions?.ifNoneMatch === '*' && blobs.has(path))
        throw Object.assign(new Error('conflict'), { statusCode: 412 });
      blobs.set(path, { bytes: Buffer.from(value), etag: randomUUID() });
    },
    async download() {
      const blob = blobs.get(path); if (!blob) throw notFound();
      return { etag: blob.etag, readableStreamBody: [blob.bytes] };
    }
  }) };
  const store = new AzureFloStore({ table, container });
  const linkHash = sha256('recovered-link');
  const recovered = await store.createCase(workspace, input, idempotencyKey, linkHash, { enabled: true });
  assert.equal(recovered.reused, false);
  assert.equal(recovered.case.application_id, applicationId);
  assert.equal((await store.findLink(linkHash)).applicationId, applicationId);
  assert.equal(rows.get(key(workspace, `case-${applicationId}`)).customerReference, undefined);
  assert.equal((await store.createCase(workspace, input, idempotencyKey, sha256('other-link'), {})).reused, true);
});
