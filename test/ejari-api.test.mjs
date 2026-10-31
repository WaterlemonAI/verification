import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.EJARI_PLATFORM_ENABLED = '1';
process.env.EJARI_DATA_ROOT_KEY_HEX = 'e'.repeat(64);
const { EnvironmentStore } = await import('../lib/api-store.mjs');
const { MemoryCustomerUsageStore, moneyMicros, validateUsagePolicy } = await import('../lib/customer-usage.mjs');
const { createAppServer } = await import('../server.mjs');
const { caseOutcome } = await import('../lib/case-manager-outcomes.mjs');
const { reconcileCaseMessage } = await import('../lib/case-manager-reconcile.mjs');
const { MemoryCaseManagerStore } = await import('../lib/case-manager-store.mjs');

const jobId = 'ejari_11111111-1111-4111-8111-111111111111';
const endpoint = '/service/dubai_ejari_verification';
const valid = { contract_number: '0120221004004205', dewa_number: '128053950' };

async function entitlement(store, usage, name) {
  const issued = await store.createClient(name);
  const id = issued.client.workspaceId;
  await store.setCustomer({ id, name, status: 'active', usagePolicyVersion: 1 });
  await usage.configure(id, validateUsagePolicy({ mode: 'prepaid', currency: 'USD',
    allowed_modules: ['ejari-verification'], rates: { 'ejari-verification': [{ up_to: null, price: '0.10' }] }
  }, new Set(['ejari-verification'])), true);
  await usage.addCredit(id, moneyMicros('1.00'), true);
  return { ...issued, id };
}

test('Ejari API validates input, keeps workspace boundaries, and returns only private result URLs', async (t) => {
  const store = new EnvironmentStore();
  await store.saveEjariConfig({ enabled: true, ocr_model: 'gpt-6-luna', ocr_detail: 'high',
    openai_key: 'sk-synthetic-ocr', capsolver_key: 'synthetic-captcha' });
  const usage = new MemoryCustomerUsageStore();
  const first = await entitlement(store, usage, 'ejari-first');
  const second = await entitlement(store, usage, 'ejari-second');
  let submitted = 0;
  const ejariStore = {
    async createJob(input) {
      submitted++;
      assert.equal(input.workspaceId, first.id);
      assert.deepEqual(input.fields, { ...valid, input_pdf: false });
      return { job: { id: jobId, status: 'queued' }, reused: submitted > 1 };
    },
    async getJob(id, workspace) { return id === jobId && workspace === first.id ? { id, status: 'verified' } : null; },
    async getResult(id, workspace) { return id === jobId && workspace === first.id ? { job: { status: 'verified' },
      result: { schemaVersion: 'ejari-v1', status: 'verified', certificateAvailable: true,
        fields: { contract_number: valid.contract_number } } } : null; },
    async getCertificate(id, workspace) { return id === jobId && workspace === first.id ? Buffer.from('%PDF-synthetic') : null; }
  };
  const app = createAppServer({ store, usageStore: usage, ejariStore, startWorker: false });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { authorization: `Bearer ${first.apiKey}`, 'idempotency-key': 'ejari-synthetic-idem-001',
    'content-type': 'application/json' };
  const post = (body, custom = headers) => fetch(`${base}${endpoint}`, { method: 'POST', headers: custom, body: JSON.stringify(body) });
  assert.equal((await post({ ...valid, extra: 'x' })).status, 400);
  assert.equal((await post({ ...valid, contract_number: '1234567890123456' })).status, 400);
  assert.equal((await post(valid, { ...headers, 'idempotency-key': 'short' })).status, 400);
  assert.equal((await post(valid, { ...headers, authorization: 'Bearer invalid' })).status, 401);
  const response = await post(valid);
  assert.equal(response.status, 202);
  const receipt = await response.json();
  assert.equal(receipt.jobId, jobId);
  assert.equal(JSON.stringify(receipt).includes('synthetic-'), false);
  assert.equal((await fetch(`${base}${receipt.resultUrl}`)).status, 401);
  const other = { authorization: `Bearer ${second.apiKey}` };
  assert.equal((await fetch(`${base}${receipt.resultUrl}`, { headers: other })).status, 404);
  assert.equal((await fetch(`${base}${endpoint}/jobs/${jobId}/certificate.pdf`, { headers: other })).status, 404);
  const result = await fetch(`${base}${receipt.resultUrl}`, { headers });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).certificateUrl, `${endpoint}/jobs/${jobId}/certificate.pdf`);
  const certificate = await fetch(`${base}${endpoint}/jobs/${jobId}/certificate.pdf`, { headers });
  assert.equal(certificate.status, 200);
  assert.equal(await certificate.text(), '%PDF-synthetic');
  const replay = await post(valid);
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).reused, true);
  assert.equal((await usage.account(first.id, true)).spent, '0.100000');
  assert.equal(submitted, 2);
});

test('Ejari outcomes use DLD evidence and completed case reconciliation', async () => {
  assert.equal(caseOutcome('ejari-verification', { status: 'verified' }, { httpStatus: 200 }).outcome, 'passed');
  assert.equal(caseOutcome('ejari-verification', { status: 'not_found' }, { httpStatus: 200 }).outcome, 'failed');
  assert.equal(caseOutcome('ejari-verification', { status: 'could_not_complete' }, { httpStatus: 200 }).outcome, 'could_not_complete');
  const caseStore = new MemoryCaseManagerStore();
  const usageStore = new MemoryCustomerUsageStore();
  const { validateCasePolicy } = await import('../lib/customer-usage.mjs');
  await usageStore.updateCasePolicy('workspace-ejari', validateCasePolicy({ version: 0, enabled: true, ttl_days: 30 }));
  const acceptedAt = new Date().toISOString();
  const intent = await caseStore.createIntent({ workspaceId: 'workspace-ejari', serviceId: 'ejari-verification',
    transactionId: 'synthetic-tx', acceptedAt, expiresAt: new Date(Date.now() + 86400000).toISOString(), policyVersion: 1 });
  const status = await reconcileCaseMessage({ version: 1, workspaceId: 'workspace-ejari', caseId: intent.id,
    serviceId: 'ejari-verification', sourceId: jobId, originalOwner: 'workspace-ejari' }, {
    caseStore, usageStore, documentOcrStore: null, getBsaResult: null,
    ejariStore: { async getResult() { return { job: { status: 'verified' }, result: {
      status: 'verified', certificateAvailable: true, fields: { contract_number: valid.contract_number }
    } }; } }
  });
  assert.equal(status, 'captured');
  const saved = await caseStore.getCase('workspace-ejari', intent.id);
  assert.equal(saved.outcome, 'passed');
  assert.deepEqual(saved.payload.artifact_refs.map((item) => item.name), ['certificate.pdf']);
});

test('PDF submission keeps bytes private and rejects spoofed or ambiguous multipart input', async (t) => {
  const store = new EnvironmentStore();
  await store.saveEjariConfig({ enabled: true, ocr_model: 'gpt-6-luna', ocr_detail: 'high',
    openai_key: 'synthetic-openai', capsolver_key: 'synthetic-capsolver' });
  const usage = new MemoryCustomerUsageStore();
  const issued = await entitlement(store, usage, 'ejari-pdf');
  let seen;
  const ejariStore = { async createJob(input) { seen = input; return { job: { id: jobId, status: 'queued' }, reused: false }; } };
  const app = createAppServer({ store, usageStore: usage, ejariStore, startWorker: false });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}${endpoint}`;
  const headers = { authorization: `Bearer ${issued.apiKey}`, 'idempotency-key': 'ejari-pdf-synthetic-001' };
  const makeForm = (bytes) => { const form = new FormData();
    form.append('ejari_file', new Blob([bytes], { type: 'application/pdf' }), 'synthetic.pdf'); return form; };
  assert.equal((await fetch(base, { method: 'POST', headers, body: makeForm('not a PDF') })).status, 415);
  const ambiguous = makeForm('%PDF-synthetic');
  ambiguous.append('contract_number', valid.contract_number);
  ambiguous.append('contract_number', valid.contract_number);
  assert.equal((await fetch(base, { method: 'POST', headers, body: ambiguous })).status, 400);
  const accepted = await fetch(base, { method: 'POST', headers, body: makeForm('%PDF-synthetic') });
  assert.equal(accepted.status, 202);
  assert.equal(seen.workspaceId, issued.id);
  assert.equal(seen.pdfBytes.toString(), '%PDF-synthetic');
  assert.equal(JSON.stringify(await accepted.json()).includes('%PDF-'), false);
});
