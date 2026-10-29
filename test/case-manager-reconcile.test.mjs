import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCaseManagerStore } from '../lib/case-manager-store.mjs';
import { MemoryCustomerUsageStore, validateCasePolicy } from '../lib/customer-usage.mjs';
import { reconcileCaseMessage } from '../lib/case-manager-reconcile.mjs';

test('bounded reconciliation reads saved OCR results and never invokes a provider', async () => {
  const oldKey = process.env.DOCUMENT_OCR_DOWNLOAD_SIGNING_KEY_HEX;
  process.env.DOCUMENT_OCR_DOWNLOAD_SIGNING_KEY_HEX = 'c'.repeat(64);
  try {
  const caseStore = new MemoryCaseManagerStore();
  const usageStore = new MemoryCustomerUsageStore();
  await usageStore.updateCasePolicy('workspace-a', validateCasePolicy({ version: 0, enabled: true, ttl_days: 30 }));
  const acceptedAt = new Date().toISOString();
  const intent = await caseStore.createIntent({ workspaceId: 'workspace-a', serviceId: 'passport-icao-ocr',
    transactionId: 'tx', acceptedAt, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
  const message = { version: 1, workspaceId: 'workspace-a', caseId: intent.id, serviceId: 'passport-icao-ocr',
    sourceId: 'ocr_123', originalOwner: 'workspace-a' };
  let reads = 0;
  const dependencies = { caseStore, usageStore, getBsaResult: () => { throw new Error('unexpected BSA read'); },
    documentOcrStore: { async getResult() { reads++; return reads === 1
      ? { job: { status: 'queued' } }
      : { job: { status: 'completed' }, result: { status: 'completed', data: { name: 'Synthetic' },
        artifacts: [{ name: 'photo' }] } }; } } };
  assert.equal(await reconcileCaseMessage(message, dependencies), 'pending');
  assert.equal(await reconcileCaseMessage(message, dependencies), 'captured');
  assert.equal((await caseStore.getCase('workspace-a', intent.id)).outcome, 'extracted');
  assert.match((await caseStore.getCase('workspace-a', intent.id)).payload.final_response.artifacts[0].download_url,
    /\/service\/passport_icao_ocr\/jobs\/ocr_123\/artifacts\/photo\?/);
  assert.equal(await reconcileCaseMessage(message, dependencies), 'captured');
  assert.equal(reads, 2);
  await usageStore.updateCasePolicy('workspace-a', validateCasePolicy({ version: 1, enabled: false }));
  assert.equal(await reconcileCaseMessage(message, dependencies), 'retired');
  } finally {
    if (oldKey === undefined) delete process.env.DOCUMENT_OCR_DOWNLOAD_SIGNING_KEY_HEX;
    else process.env.DOCUMENT_OCR_DOWNLOAD_SIGNING_KEY_HEX = oldKey;
  }
});

test('BSA reconciliation records the same public final fields without rerunning analysis', async () => {
  const caseStore = new MemoryCaseManagerStore();
  const usageStore = new MemoryCustomerUsageStore();
  await usageStore.updateCasePolicy('workspace-a', validateCasePolicy({ version: 0, enabled: true, ttl_days: 30 }));
  const intent = await caseStore.createIntent({ workspaceId: 'workspace-a', serviceId: 'bank-statement-analysis',
    transactionId: 'tx-bsa', acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
  const sourceId = 'bsa_11111111-1111-4111-8111-111111111111';
  let reads = 0;
  const outcome = await reconcileCaseMessage({ version: 1, workspaceId: 'workspace-a', caseId: intent.id,
    serviceId: 'bank-statement-analysis', sourceId, originalOwner: 'original-key-owner' }, {
    caseStore, usageStore, documentOcrStore: null,
    getBsaResult: async () => { reads++; return { job: { status: 'completed', callback: { requested: true, status: 'failed' } },
      result: { status: 'partial', decisionEligible: false, artifacts: [{ filename: 'audit.pdf' }] } }; }
  });
  assert.equal(outcome, 'captured');
  assert.equal(reads, 1);
  const saved = await caseStore.getCase('workspace-a', intent.id);
  assert.equal(saved.outcome, 'review_required');
  assert.deepEqual(saved.payload.final_response.callback, { requested: true, status: 'failed' });
  assert.equal(saved.payload.final_response.artifacts[0].downloadUrl,
    `/service/bank_statement_analysis/${sourceId}/artifacts/audit.pdf`);
});
