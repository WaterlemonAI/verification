import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryCustomerUsageStore, moneyMicros, validateCasePolicy, validateUsagePolicy } from '../lib/customer-usage.mjs';
import { MemoryCaseManagerStore } from '../lib/case-manager-store.mjs';
import { createPortalAccount, createPortalSession, PORTAL_COOKIE } from '../lib/portal-auth.mjs';

process.env.NODE_ENV = 'test';
process.env.DOCUMENT_OCR_DATA_KEY_HEX = 'a'.repeat(64);
process.env.DOCUMENT_OCR_DOWNLOAD_SIGNING_KEY_HEX = 'b'.repeat(64);
const { createAppServer } = await import('../server.mjs');

const jobId = 'ocr_11111111-1111-4111-8111-111111111111';

test('OCR routes enforce entitlement, accept one file, and refund an idempotent replay', async (t) => {
  const store = new EnvironmentStore();
  const usageStore = new MemoryCustomerUsageStore();
  const issued = await store.createClient('OCR test workspace');
  const workspaceId = issued.client.workspaceId;
  await store.setCustomer({ id: workspaceId, name: 'OCR test workspace', status: 'active', usagePolicyVersion: 1 });
  let creates = 0;
  const documentOcrStore = {
    async createJob(input) {
      creates++;
      assert.equal(input.ownerId, workspaceId);
      assert.equal(input.files.length, 1);
      assert.equal(input.files[0].mediaType, 'application/pdf');
      return { job: { id: jobId, service_id: input.serviceId, transaction_id: input.transactionId,
        status: 'queued', provider_calls: { azure: 0, gemini: 0 } }, reused: creates > 1 };
    },
    async getJob(ownerId) {
      return ownerId === workspaceId ? { id: jobId, service_id: 'passport-icao-ocr', status: 'completed',
        provider_calls: { azure: 1, gemini: 1 } } : null;
    },
    async getResult(ownerId) {
      if (ownerId !== workspaceId) return null;
      return { job: { id: jobId, service_id: 'passport-icao-ocr', status: 'completed' },
        result: { job_id: jobId, data: { document_type: 'Passport' }, artifacts: [],
          processing: { ai_model: 'gemini-3.5-flash-lite', provider_calls: { azure: 1, gemini: 1 } } } };
    },
    async getArtifact() { return null; }
  };
  const server = createAppServer({ store, usageStore, documentOcrStore, startWorker: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const form = () => { const data = new FormData(); data.append('file', new Blob(['%PDF-1.4\n'], { type: 'application/pdf' }), 'test.pdf'); return data; };
  const headers = { authorization: `Bearer ${issued.apiKey}`, 'idempotency-key': 'ocr-test-request-12345' };
  const denied = await fetch(`${base}/service/passport_icao_ocr`, { method: 'POST', headers, body: form() });
  assert.equal(denied.status, 403);
  assert.equal(creates, 0);
  await usageStore.configure(workspaceId, validateUsagePolicy({ mode: 'prepaid', currency: 'USD',
    allowed_modules: ['passport-icao-ocr'], rates: { 'passport-icao-ocr': [{ up_to: null, price: '0.10' }] }
  }, new Set(['passport-icao-ocr'])), true);
  await usageStore.addCredit(workspaceId, moneyMicros('0.20'), true);
  const accepted = await fetch(`${base}/service/passport_icao_ocr`, { method: 'POST', headers, body: form() });
  assert.equal(accepted.status, 202);
  const receipt = await accepted.json();
  assert.equal(receipt.result_url, `/service/passport_icao_ocr/jobs/${jobId}/result`);
  assert.deepEqual(receipt.provider_calls, { azure: 0, ai7edd_model: 0 });
  const replay = await fetch(`${base}/service/passport_icao_ocr`, { method: 'POST', headers, body: form() });
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).reused, true);
  assert.equal((await usageStore.account(workspaceId, true)).spent, '0.100000');
  const result = await fetch(`${base}${receipt.result_url}`, { headers: { authorization: `Bearer ${issued.apiKey}` } });
  assert.equal(result.status, 200);
  const resultBody = await result.json();
  assert.equal(resultBody.data.document_type, 'Passport');
  assert.equal(resultBody.processing.ai_model, 'ai7edd model');
  assert.deepEqual(resultBody.processing.provider_calls, { azure: 1, ai7edd_model: 1 });
  assert.equal(JSON.stringify(resultBody).toLowerCase().includes('gemini'), false);
  const status = await (await fetch(`${base}${receipt.status_url}`, { headers })).json();
  assert.deepEqual(status.job.provider_calls, { azure: 1, ai7edd_model: 1 });
  const noAuth = await fetch(`${base}${receipt.result_url}`);
  assert.equal(noAuth.status, 401);
});

test('saved OCR cases present the ai7edd label without rewriting stored evidence', async (t) => {
  process.env.CASE_MANAGER_ENABLED = 'true';
  t.after(() => { delete process.env.CASE_MANAGER_ENABLED; });
  const store = new EnvironmentStore();
  const usageStore = new MemoryCustomerUsageStore();
  const caseStore = new MemoryCaseManagerStore();
  const signingKey = 'synthetic-ocr-case-signing-key';
  const account = createPortalAccount('ocr-case@example.test', 'StrongPass!234',
    { id: 'ocr-case-workspace', name: 'OCR Case' });
  await store.setPortalSessionKey(signingKey);
  await store.setPortalUser(account);
  await usageStore.updateCasePolicy(account.client_id,
    validateCasePolicy({ version: 0, enabled: true, ttl_days: 1 }));
  const intent = await caseStore.createIntent({ workspaceId: account.client_id, serviceId: 'passport-icao-ocr',
    transactionId: '33333333-3333-4333-8333-333333333333', acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
  await caseStore.captureFinal(account.client_id, intent.id, { response: { status: 'completed',
    processing: { ai_model: 'gemini-3.5-flash-lite', provider_calls: { azure: 1, gemini: 1 } } },
  contentType: 'application/json', httpStatus: 200, outcome: 'extracted' });
  const server = createAppServer({ store, usageStore, caseStore, startWorker: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const path = `http://127.0.0.1:${server.address().port}/portal/api/cases/${intent.id}`;
  const headers = { cookie: `${PORTAL_COOKIE}=${encodeURIComponent(createPortalSession(account, signingKey).token)}` };
  for (const suffix of ['', '/json']) {
    const response = await (await fetch(path + suffix, { headers })).json();
    const result = suffix ? response : response.response;
    assert.equal(result.processing.ai_model, 'ai7edd model');
    assert.deepEqual(result.processing.provider_calls, { azure: 1, ai7edd_model: 1 });
    assert.equal(JSON.stringify(response).toLowerCase().includes('gemini'), false);
  }
  const stored = await caseStore.getCase(account.client_id, intent.id);
  assert.equal(stored.payload.final_response.processing.provider_calls.gemini, 1);
});

test('Emirates ID crop URL is private, expires, and works without exposing the API key', async (t) => {
  const store = new EnvironmentStore();
  const issued = await store.createClient('ID crop test');
  const workspaceId = issued.client.workspaceId;
  const usageStore = new MemoryCustomerUsageStore();
  const documentOcrStore = {
    async getJob(ownerId) { return ownerId === workspaceId ? { id: jobId, service_id: 'emirates-id-ocr', status: 'completed' } : null; },
    async getResult() { return { job: { id: jobId, service_id: 'emirates-id-ocr', status: 'completed' },
      result: { job_id: jobId, data: {}, artifacts: [{ name: 'photo', content_type: 'image/png', page: 1 }] } }; },
    async getArtifact() { return Buffer.from('png-crop'); }
  };
  const server = createAppServer({ store, usageStore, documentOcrStore, startWorker: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalBase = process.env.API_PUBLIC_BASE_URL;
  process.env.API_PUBLIC_BASE_URL = base;
  t.after(() => {
    if (originalBase === undefined) delete process.env.API_PUBLIC_BASE_URL;
    else process.env.API_PUBLIC_BASE_URL = originalBase;
  });
  const result = await fetch(`${base}/service/emirates_id_ocr/jobs/${jobId}/result`, {
    headers: { authorization: `Bearer ${issued.apiKey}` }
  });
  assert.equal(result.status, 200);
  const { artifacts } = await result.json();
  assert.equal(artifacts.length, 1);
  assert.ok(artifacts[0].download_url.startsWith(`${base}/service/emirates_id_ocr/`));
  const download = await fetch(artifacts[0].download_url);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'png-crop');
  const altered = new URL(artifacts[0].download_url, base);
  altered.searchParams.set('expires', '1');
  assert.equal((await fetch(altered)).status, 401);
});

test('two-file upload is accepted only for Emirates ID', async (t) => {
  const store = new EnvironmentStore();
  const issued = await store.createClient('Two-side ID test');
  let acceptedFiles = 0;
  const documentOcrStore = { async createJob(input) {
    acceptedFiles = input.files.length;
    return { job: { id: jobId, service_id: input.serviceId, status: 'queued' }, reused: false };
  } };
  const server = createAppServer({ store, documentOcrStore, startWorker: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const form = () => {
    const data = new FormData();
    data.set('file', new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' }), 'front.jpg');
    data.set('additional_file', new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' }), 'back.jpg');
    return data;
  };
  const headers = { authorization: `Bearer ${issued.apiKey}`, 'idempotency-key': 'two-sided-id-request-1234' };
  const accepted = await fetch(`${base}/service/emirates_id_ocr`, { method: 'POST', headers, body: form() });
  assert.equal(accepted.status, 202);
  assert.equal(acceptedFiles, 2);
  const rejected = await fetch(`${base}/service/passport_icao_ocr`, { method: 'POST', headers, body: form() });
  assert.equal(rejected.status, 400);
  assert.equal(acceptedFiles, 2);
});

test('customer admission snapshots the current engine and exposes no engine control', async (t) => {
  const store = new EnvironmentStore();
  const issued = await store.createClient('Engine snapshot test');
  const accepted = [];
  const documentOcrStore = { async createJob(input) {
    accepted.push(input.extractionEngine);
    return { job: { id: jobId, service_id: input.serviceId, status: 'queued' }, reused: false };
  } };
  const server = createAppServer({ store, documentOcrStore, startWorker: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const submit = (key) => {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' }), 'cheque.jpg');
    form.set('engine', 'azure');
    return fetch(`${base}/service/cheque_ocr`, { method: 'POST',
      headers: { authorization: `Bearer ${issued.apiKey}`, 'idempotency-key': key }, body: form });
  };
  assert.equal((await submit('snapshot-engine-00001')).status, 202);
  await store.setDocumentOcrEngine('cheque-ocr', 'azure', 'admin@example.test');
  assert.equal((await submit('snapshot-engine-00002')).status, 202);
  assert.deepEqual(accepted, ['ollama', 'azure']);
});
