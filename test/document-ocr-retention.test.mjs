import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AzureDocumentOcrStore } from '../lib/document-ocr-store.mjs';
import { AzureAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';
import { MemoryCustomerUsageStore, moneyMicros, validateUsagePolicy } from '../lib/customer-usage.mjs';

test('an idempotency race re-enqueues the winning job if its first enqueue was lost', async () => {
  const previousKey = process.env.DOCUMENT_OCR_DATA_KEY_HEX;
  process.env.DOCUMENT_OCR_DATA_KEY_HEX = 'a'.repeat(64);
  try {
    const sha = (value) => createHash('sha256').update(value).digest('hex');
    const bytes = Buffer.from('synthetic image');
    const priorId = 'ocr_33333333-3333-4333-8333-333333333333';
    const prior = { partitionKey: sha('workspace:race-workspace'), rowKey: `job_${priorId}`,
      jobId: priorId, serviceId: 'cheque-ocr', transactionId: 'synthetic-transaction',
      status: 'queued', stage: 'queued', queueSent: false,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const requestHash = sha(JSON.stringify({ serviceId: 'cheque-ocr',
      files: [{ sha256: sha(bytes), mediaType: 'image/png' }] }));
    let idemLookups = 0;
    const table = {
      async getEntity(_partition, key) {
        if (key.startsWith('idem_')) {
          if (++idemLookups === 1) throw Object.assign(new Error('not found'), { statusCode: 404 });
          return { jobId: priorId, requestHash };
        }
        if (key === prior.rowKey) return prior;
        throw Object.assign(new Error('not found'), { statusCode: 404 });
      },
      async createEntity() {},
      async submitTransaction() { throw Object.assign(new Error('conflict'), { statusCode: 409 }); },
      async updateEntity(patch) { if (patch.rowKey === prior.rowKey) Object.assign(prior, patch); },
      async deleteEntity() {}
    };
    const container = {
      getBlockBlobClient: () => ({ uploadData: async () => {} }),
      async *listBlobsFlat() { yield { name: 'abandoned-input.bin' }; },
      async deleteBlob() {}
    };
    let sends = 0;
    const queue = { async sendMessage(message) {
      sends += 1;
      assert.equal(JSON.parse(Buffer.from(message, 'base64').toString()).jobId, priorId);
    } };
    const store = new AzureDocumentOcrStore({ container, queue, table });
    const created = await store.createJob({ ownerId: 'race-workspace', serviceId: 'cheque-ocr',
      files: [{ bytes, mediaType: 'image/png' }], idempotencyKey: 'ocr-race-request-1234',
      transactionId: 'synthetic-transaction' });
    assert.equal(created.reused, true);
    assert.equal(created.job.id, priorId);
    assert.equal(sends, 1);
    assert.equal(prior.queueSent, true);
  } finally {
    if (previousKey === undefined) delete process.env.DOCUMENT_OCR_DATA_KEY_HEX;
    else process.env.DOCUMENT_OCR_DATA_KEY_HEX = previousKey;
  }
});

test('stale queued OCR jobs fail and refund credit during hourly reconciliation', async () => {
  const workspaceId = 'ocr-expiry-test';
  const usage = new MemoryCustomerUsageStore();
  await usage.configure(workspaceId, validateUsagePolicy({ mode: 'prepaid', currency: 'USD',
    allowed_modules: ['cheque-ocr'], rates: { 'cheque-ocr': [{ up_to: null, price: '0.15' }] }
  }, new Set(['cheque-ocr'])), true);
  await usage.addCredit(workspaceId, moneyMicros('0.15'), true);
  const admission = await usage.admit(workspaceId, { transactionId: 'stale-ocr', moduleIds: ['cheque-ocr'],
    method: 'POST', path: '/service/cheque_ocr' }, true);
  await usage.complete(workspaceId, admission.logKey, 202);
  const row = { partitionKey: 'a'.repeat(64), rowKey: 'job_ocr_11111111-1111-4111-8111-111111111111',
    jobId: 'ocr_11111111-1111-4111-8111-111111111111', status: 'queued', stage: 'queued',
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    billingWorkspaceId: workspaceId, billingLogKey: admission.logKey, etag: '1' };
  row.pendingIndexKey = `${new Date(Date.now() - 60 * 60 * 1000).toISOString()}_${row.jobId}`;
  let pending = true;
  const table = {
    async *listEntities() { if (pending) yield { partitionKey: 'ocr-index-pending',
      rowKey: row.pendingIndexKey, ownerPartition: row.partitionKey, jobId: row.jobId }; },
    async updateEntity(patch) { Object.assign(row, patch, { etag: String(Number(row.etag) + 1) }); },
    async getEntity() { return { ...row }; },
    async deleteEntity() { pending = false; }
  };
  const store = new AzureDocumentOcrStore({ container: {}, queue: {}, table });
  assert.equal(await store.reconcileUsage(usage), 1);
  assert.equal(row.status, 'failed');
  assert.equal(row.reasonCode, 'DOCUMENT_OCR_JOB_TIMEOUT');
  assert.equal((await usage.account(workspaceId, true)).balance, '0.150000');
  assert.equal(await store.reconcileUsage(usage), 0);
  assert.equal((await usage.account(workspaceId, true)).charged_calls, 0);
});

test('expired OCR records remove encrypted blobs, idempotency and due indexes', async () => {
  const jobId = 'ocr_22222222-2222-4222-8222-222222222222';
  const partitionKey = 'b'.repeat(64);
  const expiresAt = new Date(Date.now() - 60_000).toISOString();
  const row = { partitionKey, rowKey: `job_${jobId}`, jobId, expiresAt,
    idemRowKey: 'idem_example', pendingIndexKey: `${expiresAt}_${jobId}` };
  const expiryIndex = { partitionKey: 'ocr-index-expiry', rowKey: `${expiresAt}_${jobId}`,
    ownerPartition: partitionKey, jobId };
  const deleted = [];
  const table = {
    async *listEntities() { yield expiryIndex; },
    async getEntity() { return row; },
    async deleteEntity(partition, key) { deleted.push(`${partition}/${key}`); }
  };
  const container = {
    async *listBlobsFlat() { yield { name: `${partitionKey}/${jobId}/input-0.bin` };
      yield { name: `${partitionKey}/${jobId}/ocr.bin` }; },
    async deleteBlob(name) { deleted.push(name); }
  };
  const store = new AzureDocumentOcrStore({ container, queue: {}, table });
  assert.equal(await store.purgeExpired(new Date()), 1);
  assert.deepEqual(deleted, [
    `${partitionKey}/${jobId}/input-0.bin`, `${partitionKey}/${jobId}/ocr.bin`,
    `${partitionKey}/job_${jobId}`, `${partitionKey}/idem_example`,
    `ocr-index-pending/${expiresAt}_${jobId}`, `ocr-index-expiry/${expiresAt}_${jobId}`
  ]);
});

test('OCR retention job purges expired Form PDF and pending callback without touching live data', async () => {
  const now = new Date('2026-10-28T12:00:00.000Z');
  const expired = '2026-10-28T11:00:00.000Z';
  const live = '2026-10-29T12:00:00.000Z';
  const deleted = [];
  const table = {
    async *listEntities() {
      yield { partitionKey: 'forms-expiry', rowKey: 'expired-report', reportType: 'forms',
        blobName: 'forms-ocr-reports/owner/expired-report.pdf', ownerPartition: 'forms-owner', expiresAt: expired };
      yield { partitionKey: 'forms-expiry', rowKey: 'live-report', reportType: 'forms',
        blobName: 'forms-ocr-reports/owner/live-report.pdf', ownerPartition: 'forms-owner', expiresAt: live };
    },
    async deleteEntity(partition, key) { deleted.push(`${partition}/${key}`); }
  };
  const container = {
    getBlockBlobClient(name) { return {
      async getProperties() { return { metadata: { expiresat: name.includes('expired') ? expired : live } }; },
      async deleteIfExists() { deleted.push(name); }
    }; },
    async *listBlobsFlat() {
      yield { name: 'forms-ocr-pending/owner/expired.json' };
      yield { name: 'forms-ocr-pending/owner/live.json' };
    }
  };
  const store = new AzureDocumentOcrStore({ container, queue: {}, table });
  assert.equal(await store.purgeExpiredFormArtifacts(now), 2);
  assert.deepEqual(deleted, [
    'forms-ocr-reports/owner/expired-report.pdf', 'forms-owner/expired-report',
    'forms-public/expired-report', 'forms-expiry/expired-report',
    'forms-ocr-pending/owner/expired.json'
  ]);
});

test('an OCR Form PDF remains purgeable if the public report index write fails', async () => {
  const expiresAt = new Date(Date.now() - 1_000).toISOString();
  const rows = new Map();
  const deleted = [];
  const table = {
    async upsertEntity(row) {
      if (row.partitionKey === 'forms-public') throw new Error('synthetic_public_index_outage');
      rows.set(`${row.partitionKey}/${row.rowKey}`, row);
    },
    async *listEntities() { for (const row of rows.values()) if (row.partitionKey === 'forms-expiry') yield row; },
    async deleteEntity(partition, key) { rows.delete(`${partition}/${key}`); deleted.push(`${partition}/${key}`); }
  };
  const container = {
    getBlockBlobClient(name) { return {
      async uploadData() { rows.set(`blob/${name}`, { name }); },
      async deleteIfExists() { rows.delete(`blob/${name}`); deleted.push(name); }
    }; },
    async *listBlobsFlat() {}
  };
  const reports = new AzureAdverseMediaReportStore({
    blobServiceUrl: 'https://reports.blob.core.windows.net',
    ocrBlobServiceUrl: 'https://ocr.blob.core.windows.net',
    credential: { async getToken() { return { token: 'synthetic' }; } }
  });
  reports.ocrTable = table;
  reports.ocrContainer = container;
  await assert.rejects(reports.save({ ownerId: 'owner', reportId: 'orphan-report',
    bytes: Buffer.from('synthetic-pdf'), metadata: { report_type: 'forms', expires_at: expiresAt }
  }), /synthetic_public_index_outage/);
  assert.ok(rows.has('forms-expiry/orphan-report'));
  const store = new AzureDocumentOcrStore({ container, queue: {}, table });
  assert.equal(await store.purgeExpiredFormArtifacts(new Date()), 1);
  assert.ok(deleted.some((item) => item.endsWith('/orphan-report.pdf')));
  assert.equal(rows.has('forms-expiry/orphan-report'), false);
  assert.equal([...rows.keys()].some((key) => key.startsWith('blob/')), false);
});
