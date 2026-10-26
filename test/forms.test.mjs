import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';

process.env.NODE_ENV = 'test';
process.env.API_PUBLIC_BASE_URL = 'https://api.ai7uae.com';
const { consolidateFormServiceResults, createAppServer, evaluateFormServiceQualification, executeFormsJob } = await import('../server.mjs');
const { EnvironmentStore } = await import('../lib/api-store.mjs');
const { MemoryCustomerUsageStore } = await import('../lib/customer-usage.mjs');
const { MemoryAdverseMediaReportStore } = await import('../lib/adverse-media-report-store.mjs');
const { resolveFormServiceInput, validateFormDefinition } = await import('../lib/forms.mjs');
const { startFormsWorker } = await import('../lib/forms-queue.mjs');

const adminKey = 'forms_admin_test_key';
process.env.AI7_ADMIN_KEY_HASHES = createHash('sha256').update(adminKey).digest('hex');
const store = new EnvironmentStore();
const reportStore = new MemoryAdverseMediaReportStore();
const usageStore = new MemoryCustomerUsageStore();
let queuedJob;
let app;
let baseUrl;

const formDefinition = {
  id: 'vendor-onboarding',
  name: 'Vendor onboarding verification',
  description: 'Runs company and bank checks once.',
  fields: [
    { key: 'company_name', label: 'Company name', type: 'text', required: true },
    { key: 'country', label: 'Country', type: 'country', required: true },
    { key: 'confirmed', label: 'Confirmed', type: 'boolean', required: false }
  ],
  services: [{
    service_id: 'company-search',
    content_type: 'application/json',
    input_template: { company_name: '{{company_name}}', country: '{{country}}', confirmed: '{{confirmed}}', source: 'AI7 Form - {{company_name}}' }
  }],
  enabled: true
};

function serviceResult(serviceId, httpStatus, response) {
  const qualification = evaluateFormServiceQualification({ httpStatus, response });
  return {
    service_id: serviceId,
    name: serviceId,
    status: qualification.transport.completed ? 'completed' : 'failed',
    http_status: httpStatus,
    response,
    ...qualification
  };
}

before(async () => {
  await store.upsertIntegration({
    id: 'company-search', name: 'Company Search', publicPath: '/service/company_search', method: 'POST',
    upstreamUrl: 'http://company.test/search', authType: 'header', authHeader: 'x-api-key', authPrefix: '',
    adapter: 'passthrough', acceptedContentTypes: ['application/json'], documentedStatuses: [200], enabled: true
  }, 'private-company-key');
  app = createAppServer({
    store,
    reportStore,
    usageStore,
    formsQueue: { async enqueue(job) { queuedJob = job; } },
    startWorker: false,
    fetchImpl: async (_url, options) => new Response(JSON.stringify({ matched: true, received: JSON.parse(options.body) }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${app.address().port}`;
});

after(async () => new Promise((resolve) => app.close(resolve)));

test('Form definitions validate mappings and preserve native value types', () => {
  const available = [{ id: 'company-search', enabled: true, method: 'POST', acceptedContentTypes: ['application/json'] }];
  const form = validateFormDefinition(formDefinition, available);
  assert.deepEqual(resolveFormServiceInput(form.services[0], { company_name: 'Acme LLC', country: 'AE', confirmed: true }), {
    company_name: 'Acme LLC', country: 'AE', confirmed: true, source: 'AI7 Form - Acme LLC'
  });
  assert.throws(() => validateFormDefinition({ ...formDefinition, services: [{ service_id: 'company-search', input_template: { name: '{{unknown}}' } }] }, available), /unknown field/);
});

test('admin creates a versioned Form and public schema hides mappings', async () => {
  const response = await fetch(`${baseUrl}/admin/api/forms/vendor-onboarding`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(formDefinition)
  });
  assert.equal(response.status, 200);
  const saved = (await response.json()).form;
  assert.equal(saved.version, 1);
  const schema = await (await fetch(`${baseUrl}/forms/vendor-onboarding/schema`)).json();
  assert.equal(schema.form.services[0].name, 'Company Search');
  assert.equal(JSON.stringify(schema).includes('input_template'), false);
  assert.equal(JSON.stringify(schema).includes('private-company-key'), false);
  const portal = await (await fetch(`${baseUrl}/forms/vendor-onboarding`, { headers: { host: 'api.ai7uae.com' } })).text();
  assert.match(portal, /One input/);
  assert.match(portal, /x-ai7-signature/);
  const script = await (await fetch(`${baseUrl}/forms.js`, { headers: { host: 'api.ai7uae.com' } })).text();
  assert.match(script, /forms\/\$\{formDefinition\.id\}\/submissions/);
});

test('one customer credential queues one signed multi-API submission', async () => {
  const issued = await store.createClient('Forms customer');
  const unauthorized = await fetch(`${baseUrl}/forms/vendor-onboarding/submissions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`${baseUrl}/forms/vendor-onboarding/submissions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      callback_url: 'https://8.8.8.8/callback',
      data: { company_name: 'Acme LLC', country: 'ae', confirmed: true }
    })
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.status, 'queued');
  assert.equal(body.callback.event, 'forms.submission.completed');
  assert.match(body.callback.signing_secret, /^[A-Za-z0-9_-]+$/);
  assert.equal(queuedJob.data.country, 'AE');
  assert.equal(queuedJob.form.id, 'vendor-onboarding');
  assert.equal(JSON.stringify(queuedJob).includes(issued.apiKey), false);
});

test('invalid Form input is logged but never billed or queued', async () => {
  const issued = await store.createClient('Invalid Form customer');
  const workspaceId = issued.client.workspaceId;
  const previousJob = queuedJob;
  const response = await fetch(`${baseUrl}/forms/vendor-onboarding/submissions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ callback_url: 'https://8.8.8.8/callback', data: {} })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Company name is required/);
  assert.equal(queuedJob, previousJob);
  const account = await usageStore.account(workspaceId);
  assert.equal(account.charged_calls, 0);
  assert.deepEqual(account.counts, {});
  const logs = await usageStore.logs(workspaceId);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].response_code, 400);
  assert.equal(logs[0].cost, '0.000000');
  assert.equal(logs[0].transaction_id, response.headers.get('x-ai7-transaction-id'));
});

test('Forms execution returns exact nested responses and creates one permanent typed PDF', async () => {
  const result = await executeFormsJob({
    job: queuedJob,
    store,
    reportStore,
    fetchImpl: async (_url, options) => new Response(JSON.stringify({ matched: true, received: JSON.parse(options.body) }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.decision_eligible, true);
  assert.equal(result.services[0].transport.status, 'completed');
  assert.equal(result.services[0].coverage.status, 'complete');
  assert.equal(result.services[0].eligibility.status, 'eligible');
  assert.deepEqual(result.services[0].response, {
    matched: true,
    received: { company_name: 'Acme LLC', country: 'AE', confirmed: true, source: 'AI7 Form - Acme LLC' }
  });
  assert.equal(result.report.retention, 'permanent');
  assert.match(result.report.download_url, /^https:\/\/api\.ai7uae\.com\/service\/forms\/reports\/[0-9a-f-]{36}\.pdf$/);
  const stored = await reportStore.getPublic({ reportId: result.report.report_id });
  assert.equal(stored.metadata.report_type, 'forms');
  assert.equal(stored.bytes.subarray(0, 5).toString(), '%PDF-');
  const parsed = await PDFDocument.load(stored.bytes);
  assert.ok(parsed.getPageCount() >= 5);
  const downloaded = await fetch(`${baseUrl}/service/forms/reports/${result.report.report_id}.pdf`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'application/pdf');
});

test('Forms decision is eligible only when every selected check affirmatively qualifies', () => {
  const services = [
    serviceResult('uae-trade-licence', 200, { licence_number: '12345' }),
    serviceResult('entity-search', 200, { data: [{ name: 'Example Trading LLC' }] }),
    serviceResult('adverse-media', 200, { status: 'completed', coverage: { complete: true }, summary: { decision_eligible: true } }),
    serviceResult('merchant-screening', 200, { status: 'completed', summary: { decision_eligible: true } })
  ];
  const result = consolidateFormServiceResults(services);
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.transport_completed, 4);
  assert.equal(result.summary.coverage_complete, 4);
  assert.equal(result.summary.eligible, 4);
  assert.equal(result.summary.decision_eligible, true);
  assert.deepEqual(result.summary.reason_codes, []);
});

test('HTTP 200 partial adverse-media keeps transport complete but blocks Form eligibility', () => {
  const adverse = serviceResult('adverse-media', 200, {
    status: 'partial',
    coverage: { complete: false, reason_codes: ['current_news_unavailable'] },
    summary: { decision_eligible: false, threshold_status: 'incomplete_coverage' }
  });
  const result = consolidateFormServiceResults([
    serviceResult('entity-search', 200, { data: [] }),
    adverse
  ]);
  assert.equal(result.status, 'completed');
  assert.equal(adverse.transport.completed, true);
  assert.equal(adverse.coverage.complete, false);
  assert.equal(adverse.eligibility.decision_eligible, false);
  assert.deepEqual(adverse.eligibility.reason_codes, ['current_news_unavailable', 'incomplete_coverage', 'service_not_decision_eligible']);
  assert.equal(result.summary.decision_eligible, false);
  assert.equal(result.summary.ineligible_services[0].service_id, 'adverse-media');
});

test('HTTP 200 partial merchant screening keeps transport complete but blocks Form eligibility', () => {
  const merchant = serviceResult('merchant-screening', 200, {
    status: 'partial',
    summary: { decision_eligible: false, coverage: { website: 'available', screenshots: 'unavailable' } }
  });
  const result = consolidateFormServiceResults([
    serviceResult('uae-trade-licence', 200, { licence_number: '12345' }),
    merchant
  ]);
  assert.equal(result.status, 'completed');
  assert.equal(merchant.transport.completed, true);
  assert.equal(merchant.coverage.status, 'incomplete');
  assert.equal(merchant.eligibility.status, 'ineligible');
  assert.ok(merchant.eligibility.reason_codes.includes('service_not_decision_eligible'));
  assert.equal(result.summary.decision_eligible, false);
  assert.equal(result.summary.ineligible_services[0].service_id, 'merchant-screening');
});

test('failed provider remains a transport failure and blocks Form eligibility', () => {
  const provider = serviceResult('entity-search', 503, { message: 'Provider unavailable' });
  const result = consolidateFormServiceResults([
    serviceResult('uae-trade-licence', 200, { licence_number: '12345' }),
    provider
  ]);
  assert.equal(result.status, 'partial');
  assert.equal(provider.transport.status, 'failed');
  assert.equal(provider.coverage.complete, false);
  assert.equal(provider.eligibility.decision_eligible, false);
  assert.deepEqual(provider.eligibility.reason_codes, ['transport_failed']);
  assert.equal(result.summary.decision_eligible, false);
  assert.equal(result.summary.transport_failed, 1);
});

test('Forms IBAN execution generates and locks supplier control fields server-side', async () => {
  const ibanStore = new EnvironmentStore();
  await ibanStore.upsertIntegration({
    id: 'iban-verification', name: 'International Bank Account Verification', publicPath: '/service/iban_verification', method: 'POST',
    upstreamUrl: 'https://bank.test/v1/apicall/bank/intl_bank_acc_verification', authType: 'header', authHeader: 'username', authPrefix: '',
    adapter: 'encrypted-json-relay', acceptedContentTypes: ['application/json'], documentedStatuses: [200, 500], enabled: true
  }, 'private-username');
  let plainRequest;
  const result = await executeFormsJob({
    job: {
      submission_id: '6f070795-bc43-4d1e-87b5-82460398fdc2', owner_id: 'owner-iban', queued_at: new Date().toISOString(),
      callback_url: 'https://8.8.8.8/callback', customer_logo_url: '',
      request_origin: { network_origin: '203.0.113.1', processing_location: 'UAE North' },
      data: { company_name: 'Example Trading LLC', country_code: 'AE', iban: 'AE070331234567890123456' },
      form: {
        id: 'iban-form', name: 'IBAN Form', version: 1,
        fields: [
          { key: 'company_name', label: 'Company name', type: 'text', required: true },
          { key: 'country_code', label: 'Country', type: 'country', required: true },
          { key: 'iban', label: 'IBAN', type: 'text', required: true }
        ],
        services: [{
          service_id: 'iban-verification', content_type: 'application/json',
          input_template: { country: '{{country_code}}', completeName: '{{company_name}}', iban: '{{iban}}', transID: 'CUSTOMER-CANNOT-OVERRIDE', docType: 999, requestCategory: 'other' }
        }]
      }
    },
    store: ibanStore,
    reportStore: new MemoryAdverseMediaReportStore(),
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/encrypt')) {
        plainRequest = JSON.parse(options.body);
        return new Response(JSON.stringify({ requestData: 'encrypted-request' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path.endsWith('/decrypt')) {
        return new Response(JSON.stringify({ msg: 'success', received: plainRequest }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ responseData: 'encrypted-response' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(plainRequest.source, 'API');
  assert.equal(plainRequest.docType, 610);
  assert.equal(plainRequest.requestCategory, 'business');
  assert.equal(plainRequest.transID, 'AI7F-6f070795bc434d1e87b582460398fdc2');
  assert.equal(plainRequest.iban, 'AE070331234567890123456');
  assert.equal(result.services[0].response.received.transID, plainRequest.transID);
});

test('Forms worker durably retries callback delivery without re-running completed APIs', async () => {
  let available = true;
  let executions = 0;
  let deliveries = 0;
  let completed = false;
  const message = { messageId: '1', popReceipt: 'a', messageText: JSON.stringify({ submission_id: 's1', owner_id: 'owner-1', callback_url: 'https://8.8.8.8/callback' }) };
  const queue = {
    async receive() { if (!available) return null; available = false; return message; },
    async complete() { completed = true; },
    async release(_message, job) { message.messageText = JSON.stringify(job); available = true; }
  };
  const pendingStore = new MemoryAdverseMediaReportStore();
  const worker = startFormsWorker({
    queue,
    execute: async () => { executions += 1; return { submission_id: 's1', completed_at: new Date().toISOString() }; },
    deliver: async () => { deliveries += 1; if (deliveries === 1) throw new Error('temporary_callback_failure'); },
    resultStore: pendingStore
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  worker.stop();
  assert.equal(executions, 1);
  assert.equal(deliveries, 2);
  assert.equal(completed, true);
  assert.equal(await pendingStore.getFormResult({ ownerId: 'owner-1', submissionId: 's1' }), null);
});
