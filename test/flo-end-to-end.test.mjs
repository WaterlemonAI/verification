import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { MemoryFloQueue } from '../lib/flows/queue.mjs';
import { handleFloRequest } from '../lib/flows/routes.mjs';
import { processFloApplication } from '../lib/flows/processor.mjs';
import { createFloReport } from '../lib/flows/report-pdf.mjs';
import { deliverFloCallback } from '../lib/flows/callback.mjs';

process.env.FLO_DATA_KEY_V1_HEX = '55'.repeat(32);
process.env.FLO_CALLBACK_SIGNING_KEY_HEX = '66'.repeat(32);

test('synthetic supplier to buyer lifecycle retains documents, report and callback retries', async (t) => {
  const floStore = new MemoryFloStore();
  const queue = new MemoryFloQueue(); const callbacks = new MemoryFloQueue();
  const workspaceId = '1234567890abcdef';
  await floStore.putTemplate({ enabled: true });
  await floStore.putConfig(workspaceId, { enabled: true, brand_name: 'Buyer', callback_url: 'https://buyer.example/callback' });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const handled = await handleFloRequest(req, res, url, { host: req.headers.host, floStore,
      platformStore: { getCustomer: async () => ({ id: workspaceId }) },
      getAdmin: async () => ({ account: { email: 'admin@example.com' } }),
      getPortal: async () => ({ account: { client_id: workspaceId, role: 'org_admin', email: 'buyer@example.com' } }),
      customerKey: async () => ({ id: workspaceId }), hasEntitlement: async () => true,
      charge: async () => ({ allowed: true, settle: async () => {} }), scan: async () => 'passed',
      enqueue: (job) => queue.enqueue(job), enqueueCallback: (job) => callbacks.enqueue(job) });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, host, method = 'GET', value, extra = {}) => new Promise((resolve, reject) => {
    const raw = value === undefined ? null : JSON.stringify(value);
    const req = httpRequest(base + path, { method, headers: { host,
      ...(raw === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) }), ...extra } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks),
        json: () => JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end(raw);
  });
  const link = await send('/flows/kys-v1/links', 'api.ai7uae.com', 'POST',
    { customer_reference: 'SYNTHETIC-1', supplier_email: 'supplier@example.com' }, { 'idempotency-key': 'synthetic-1234' });
  assert.equal(link.status, 201);
  const { application_id: applicationId, supplier_url: supplierUrl } = link.json();
  const redeemed = await send('/flo/api/session', 'flo.ai7uae.com', 'POST', { token: supplierUrl.split('/').at(-1) });
  assert.equal(redeemed.status, 200);
  const session = redeemed.json();
  const supplierHeaders = { cookie: resCookie(redeemed.headers['set-cookie']), origin: 'https://flo.ai7uae.com',
    'x-flo-application-id': applicationId, 'x-flo-csrf': session.csrf_token };
  const draft = { business_name: 'Example LLC', licence_number: 'LIC-1', company_type: 'LLC',
    activities: 'Trading', registered_address: 'Dubai', stakeholders: [{ name: 'Person One', role: 'shareholder', ownership_percentage: 50 }] };
  assert.equal((await send('/flo/api/draft', 'flo.ai7uae.com', 'POST', draft, supplierHeaders)).status, 200);
  for (const type of ['trade_licence', 'formation_document', 'bank_letter']) {
    const upload = await send('/flo/api/documents', 'flo.ai7uae.com', 'POST', { type, mime_type: 'application/pdf',
      content_base64: Buffer.from('%PDF-1.4\nsynthetic').toString('base64') }, supplierHeaders);
    assert.equal(upload.status, 201);
  }
  assert.equal((await send('/flo/api/submit', 'flo.ai7uae.com', 'POST', {}, supplierHeaders)).status, 409);
  assert.equal((await send('/flo/api/review', 'flo.ai7uae.com', 'POST', {}, supplierHeaders)).status, 202);
  const ocr = { async createJob({ serviceId }) { return { job: { id: serviceId } }; },
    async getResult(_owner, id) { return { job: { status: 'completed' }, result: { data: id === 'moa-analysis'
      ? { company_name: 'Example LLC', registration_number: 'LIC-1' }
      : { company_name_english: 'Example LLC', license_number: 'LIC-1', address: 'Dubai' } } }; } };
  await queue.drain((job) => processFloApplication(job, { floStore, documentOcrStore: ocr,
    enqueue: (next) => queue.enqueue(next), createReport: createFloReport }));
  assert.ok((await floStore.getCase(workspaceId, applicationId)).preview_ready_at);
  assert.equal((await send('/flo/api/submit', 'flo.ai7uae.com', 'POST', {}, supplierHeaders)).status, 202);
  await queue.drain((job) => processFloApplication(job, { floStore, documentOcrStore: ocr,
    enqueue: (next) => queue.enqueue(next), enqueueCallback: (event) => callbacks.enqueue(event),
    callProvider: async (serviceId) => ({ httpStatus: serviceId === 'iban-verification' ? 503 : 200,
      response: serviceId === 'iban-verification' ? { status: 'Error' } : { status: 'Success' } }),
    runGeminiReview: async () => ({ status: 'completed', output: { narrative: 'Buyer review required.', issues: [], extraction_gaps: [] } }),
    createReport: createFloReport }));
  const item = await floStore.getCase(workspaceId, applicationId);
  assert.equal(item.status, 'pending_review');
  assert.equal(item.expires_at, null);
  assert.equal(item.documents.length, 3);
  assert.equal(item.reports.length, 1);
  assert.equal(item.comparisons.find((comparison) => comparison.rule === 'licence_formation_name').outcome, 'match');
  const documentPath = `/portal/api/flo/cases/${applicationId}/documents/${item.documents[0].document_id}`;
  const inlineDocument = await send(`${documentPath}?view=inline`, 'app.kycprobe.com');
  assert.equal(inlineDocument.status, 200);
  assert.match(inlineDocument.headers['content-disposition'], /^inline;/);
  assert.equal(inlineDocument.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(inlineDocument.bytes.subarray(0, 4).toString(), '%PDF');
  const downloadedDocument = await send(documentPath, 'app.kycprobe.com');
  assert.match(downloadedDocument.headers['content-disposition'], /^attachment;/);
  const report = await send(`/portal/api/flo/cases/${applicationId}/report`, 'app.kycprobe.com');
  assert.equal(report.status, 200); assert.equal(report.bytes.subarray(0, 4).toString(), '%PDF');
  const correction = await send(`/portal/api/flo/cases/${applicationId}/decision`, 'app.kycprobe.com', 'POST',
    { decision: 'needs_correction', rationale: 'Confirm the company address.' });
  assert.equal(correction.status, 200);
  const correctionToken = correction.json().supplier_url.split('/').at(-1);
  const reopened = await send('/flo/api/session', 'flo.ai7uae.com', 'POST', { token: correctionToken });
  assert.equal(reopened.status, 200);
  const correctedHeaders = { cookie: resCookie(reopened.headers['set-cookie']), origin: 'https://flo.ai7uae.com',
    'x-flo-application-id': applicationId, 'x-flo-csrf': reopened.json().csrf_token };
  const reopenedCase = await floStore.getCase(workspaceId, applicationId);
  assert.equal(reopenedCase.status, 'in_progress');
  assert.equal(reopenedCase.reports.length, 1);
  assert.equal(reopenedCase.check_history.length, 1);
  assert.equal((await send('/flo/api/review', 'flo.ai7uae.com', 'POST', {}, correctedHeaders)).status, 202);
  await queue.drain((job) => processFloApplication(job, { floStore, documentOcrStore: ocr,
    enqueue: (next) => queue.enqueue(next), createReport: createFloReport }));
  assert.equal((await send('/flo/api/submit', 'flo.ai7uae.com', 'POST', {}, correctedHeaders)).status, 202);
  await queue.drain((job) => processFloApplication(job, { floStore, documentOcrStore: ocr,
    enqueue: (next) => queue.enqueue(next), enqueueCallback: (event) => callbacks.enqueue(event),
    callProvider: async () => ({ httpStatus: 200, response: { status: 'Success' } }),
    runGeminiReview: async () => ({ status: 'completed', output: { narrative: 'Buyer review required.', issues: [], extraction_gaps: [] } }),
    createReport: createFloReport }));
  assert.equal((await floStore.getCase(workspaceId, applicationId)).reports.length, 2);
  const firstVersion = await send(`/portal/api/flo/cases/${applicationId}/reports/1`, 'app.kycprobe.com');
  const secondVersion = await send(`/portal/api/flo/cases/${applicationId}/reports/2`, 'app.kycprobe.com');
  assert.equal(firstVersion.status, 200); assert.equal(secondVersion.status, 200);
  assert.notDeepEqual(firstVersion.bytes, secondVersion.bytes);
  assert.equal((await send(`/portal/api/flo/cases/${applicationId}/reports/3`, 'app.kycprobe.com')).status, 404);
  const accepted = await send(`/portal/api/flo/cases/${applicationId}/decision`, 'app.kycprobe.com', 'POST',
    { decision: 'accepted', rationale: 'Reviewed the incomplete IBAN check.' });
  assert.equal(accepted.status, 200);
  assert.equal((await floStore.getCase(workspaceId, applicationId)).status, 'accepted');
  const eventJob = callbacks.jobs.find((job) => {
    const event = item.events.find((entry) => entry.event_id === job.event_id);
    return event?.type === 'review_ready';
  });
  let attempts = 0;
  const post = async () => { attempts++; return { ok: attempts > 1, status: attempts > 1 ? 200 : 503 }; };
  await assert.rejects(deliverFloCallback(eventJob, { floStore, resolve: async () => [{ address: '8.8.8.8', family: 4 }], post }));
  await deliverFloCallback(eventJob, { floStore, resolve: async () => [{ address: '8.8.8.8', family: 4 }], post });
  assert.equal(attempts, 2);
  const retained = await floStore.getCase(workspaceId, applicationId);
  assert.equal(retained.events.filter((event) => event.type === 'callback_attempt' && event.source_event_id === eventJob.event_id).length, 2);
});

function resCookie(value) { return (Array.isArray(value) ? value[0] : value).split(';')[0]; }
