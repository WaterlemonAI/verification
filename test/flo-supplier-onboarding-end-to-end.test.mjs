import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { MemoryFloQueue } from '../lib/flows/queue.mjs';
import { handleFloRequest } from '../lib/flows/routes.mjs';
import { resolveTemplate } from '../lib/flows/registry.mjs';
import { createFloReport } from '../lib/flows/report-pdf.mjs';

process.env.FLO_DATA_KEY_HEX = '55'.repeat(32);

test('Supplier Onboarding v1 submits once, then runs extraction, checks, report and callback in the worker', async (t) => {
  const floStore = new MemoryFloStore(); const queue = new MemoryFloQueue(); const callbacks = new MemoryFloQueue();
  let failFirstProcessEnqueue = true;
  const workspace = '1234567890abcdef';
  await floStore.putTemplate({ enabled: true }, 'supplier-onboarding-v1');
  await floStore.putConfig(workspace, { enabled: true, brand_name: 'Buyer', callback_url: 'https://buyer.example/callback' },
    'supplier-onboarding-v1');
  const server = createServer(async (req, res) => {
    const handled = await handleFloRequest(req, res, new URL(req.url, 'http://localhost'), {
      host: req.headers.host, floStore, platformStore: { getCustomer: async () => ({ id: workspace }) },
      getAdmin: async () => ({ account: { email: 'admin@example.com' } }),
      getPortal: async () => ({ account: { client_id: workspace, role: 'org_admin', email: 'buyer@example.com' } }),
      customerKey: async () => ({ id: workspace }), hasEntitlement: async () => true,
      charge: async () => ({ allowed: true, settle: async () => {} }), scan: async () => 'passed',
      enqueue: (job) => {
        if (job.job_type === 'process' && failFirstProcessEnqueue) {
          failFirstProcessEnqueue = false; throw new Error('queue_unavailable');
        }
        return queue.enqueue(job);
      }, enqueueCallback: (job) => callbacks.enqueue(job)
    });
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
    }); req.on('error', reject); req.end(raw);
  });
  const link = await send('/flows/supplier-onboarding-v1/links', 'api.ai7uae.com', 'POST',
    { customer_reference: 'SYNTHETIC-SUPPLIER', supplier_email: 'supplier@example.com' },
    { 'idempotency-key': 'supplier-12345678' });
  assert.equal(link.status, 201);
  const { application_id: id, supplier_url: supplierUrl } = link.json();
  const redeemed = await send('/flo/api/session', 'flo.ai7uae.com', 'POST', { token: supplierUrl.split('/').at(-1) });
  assert.equal(redeemed.status, 200);
  const headers = { cookie: redeemed.headers['set-cookie'][0].split(';')[0], origin: 'https://flo.ai7uae.com',
    'x-flo-application-id': id, 'x-flo-csrf': redeemed.json().csrf_token };
  const draft = { supplierType: 'legal_entity', representativeEmail: 'rep@example.com', representativePhone: '+971555550000',
    representativeTitle: 'Director', identityType: 'emirates_id', authorityBasis: 'director', ownershipComplete: 'yes',
    locationEvidenceType: 'utility', registeredAddressSame: 'yes', siteActivities: 'Trading', addressChanges: '0',
    keyPersonChanges: '0', vatRegistered: 'no', vatReason: 'Below threshold', thirdPartyPayments: 'no',
    cashPayment: 'no', supplyType: 'services', staffCount: '12', supplyDescription: 'Consulting',
    unusualCapacity: 'no', intermediary: 'no', accuracyDeclaration: true, screeningConsent: true };
  assert.equal((await send('/flo/api/draft', 'flo.ai7uae.com', 'POST', draft, headers)).status, 200);
  for (const type of ['tradeLicenceFile', 'identityFile', 'locationEvidenceFile', 'bankConfirmationFile']) {
    const upload = await send('/flo/api/documents', 'flo.ai7uae.com', 'POST', { type, mime_type: 'application/pdf',
      content_base64: Buffer.from('%PDF-1.4\nsynthetic').toString('base64') }, headers);
    assert.equal(upload.status, 201, type);
  }
  assert.equal((await send('/flo/api/review', 'flo.ai7uae.com', 'POST', {}, headers)).status, 404);
  assert.equal((await send('/flo/api/draft', 'flo.ai7uae.com', 'POST',
    { accuracyDeclaration: false }, headers)).status, 200);
  const missingDeclaration = await send('/flo/api/submit', 'flo.ai7uae.com', 'POST', {}, headers);
  assert.equal(missingDeclaration.status, 400);
  assert.ok(missingDeclaration.json().gaps.includes('accuracyDeclaration'));
  assert.equal((await send('/flo/api/draft', 'flo.ai7uae.com', 'POST',
    { accuracyDeclaration: true }, headers)).status, 200);
  const inputs = [];
  const dependencies = {
    floStore, enqueue: (next) => queue.enqueue(next), enqueueCallback: (next) => callbacks.enqueue(next),
    documentOcrStore: {
      async createJob({ serviceId }) { return { job: { id: serviceId } }; },
      async getResult(_owner, serviceId) { return { result: { data: {
        'uae-trade-license-ocr': { company_name_english: 'Example LLC', license_number: 'LIC-1', address: 'Dubai' },
        'emirates-id-ocr': { full_name_english: 'Alice Example' },
        'uae-utility-bill-ocr': { address: 'Dubai', bill_issued_to: 'Example LLC' }
      }[serviceId] || {} } }; }
    },
    extractBank: async () => ({ status: 'completed', data: { business_name: 'Example LLC', bank_name: 'Bank', iban: 'AE123' } }),
    callProvider: async (serviceId, input) => { inputs.push({ serviceId, input });
      return { httpStatus: 200, response: { status: 'Success' } }; },
    runGeminiReview: async () => ({ status: 'completed', output: { narrative: 'Review required.', issues: [], extraction_gaps: [] } }),
    createReport: createFloReport
  };
  const temporarilyUnavailable = await send('/flo/api/submit', 'flo.ai7uae.com', 'POST', {}, headers);
  assert.equal(temporarilyUnavailable.status, 503);
  assert.equal((await floStore.getCase(workspace, id)).process_enqueue_state, 'failed');
  const accepted = await send('/flo/api/submit', 'flo.ai7uae.com', 'POST', {}, headers);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.json().success_url, undefined);
  assert.equal(callbacks.jobs.filter((job) => job.job_type === 'callback').length, 1);
  const submitted = await floStore.getCase(workspace, id);
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.checks.length, 0);
  assert.equal(submitted.reports.length, 0);
  assert.equal((await send('/flo/api/submit', 'flo.ai7uae.com', 'POST', {}, headers)).status, 202);
  assert.equal((await floStore.getCase(workspace, id)).events.filter((event) => event.type === 'submitted').length, 1);
  await queue.drain((job) => resolveTemplate('supplier-onboarding-v1', '1.0.0').process(job, dependencies));
  const receipt = await send('/flo/api/application', 'flo.ai7uae.com', 'GET', undefined, headers);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.json().application.application_id, id);
  assert.ok(receipt.json().application.submitted_at);
  assert.equal(receipt.json().application.draft, undefined);
  assert.equal(receipt.json().application.documents, undefined);
  assert.equal(receipt.json().application.screening_summary, undefined);
  const tlv = inputs.find((entry) => entry.serviceId === 'uae-trade-licence');
  assert.deepEqual(tlv.input, { company_name: 'Example LLC', licence_number: 'LIC-1' });
  const result = await floStore.getCase(workspace, id);
  assert.equal(result.status, 'pending_review');
  assert.equal(result.subjects.length, 2);
  assert.equal(result.checks.filter((check) => check.service_id === 'stakeholder-adverse-media').length, 1);
  assert.equal(result.checks.find((check) => check.service_id === 'bank-letter-authenticity').transport, 'not_run');
  assert.equal(result.reports.length, 1);
  const report = await send(`/portal/api/flo/cases/${id}/report.json`, 'app.kycprobe.com');
  assert.equal(report.status, 200);
  assert.equal(report.json().title, 'Supplier Onboarding & Due Diligence Report');
  assert.ok(report.json().sections.some((section) => section.title === 'Required and provided documents'));
  const callback = result.events.find((event) => event.type === 'review_ready');
  assert.equal(callback.payload.flow_id, 'supplier-onboarding-v1');
  assert.equal(callback.payload.ai7edd_review.status, 'completed');
  assert.ok(callback.payload.checks.some((check) => check.service_id === 'stakeholder-adverse-media'));
});
