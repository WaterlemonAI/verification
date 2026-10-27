import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryCustomerUsageStore, moneyMicros, validateUsagePolicy } from '../lib/customer-usage.mjs';

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
        status: 'queued' }, reused: creates > 1 };
    },
    async getJob(ownerId) {
      return ownerId === workspaceId ? { id: jobId, service_id: 'passport-icao-ocr', status: 'completed' } : null;
    },
    async getResult(ownerId) {
      if (ownerId !== workspaceId) return null;
      return { job: { id: jobId, service_id: 'passport-icao-ocr', status: 'completed' },
        result: { job_id: jobId, data: { document_type: 'Passport' }, artifacts: [] } };
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
  const replay = await fetch(`${base}/service/passport_icao_ocr`, { method: 'POST', headers, body: form() });
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).reused, true);
  assert.equal((await usageStore.account(workspaceId, true)).spent, '0.100000');
  const result = await fetch(`${base}${receipt.result_url}`, { headers: { authorization: `Bearer ${issued.apiKey}` } });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).data.document_type, 'Passport');
  const noAuth = await fetch(`${base}${receipt.result_url}`);
  assert.equal(noAuth.status, 401);
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
