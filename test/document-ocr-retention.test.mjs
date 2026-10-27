import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AzureDocumentOcrStore } from '../lib/document-ocr-store.mjs';
import { MemoryCustomerUsageStore, moneyMicros, validateUsagePolicy } from '../lib/customer-usage.mjs';

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
