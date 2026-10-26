import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';

process.env.NODE_ENV = 'test';
process.env.API_PUBLIC_BASE_URL = 'https://api.ai7uae.com';
const { createAppServer, executeFormsJob } = await import('../server.mjs');
const { EnvironmentStore } = await import('../lib/api-store.mjs');
const { MemoryAdverseMediaReportStore } = await import('../lib/adverse-media-report-store.mjs');
const { resolveFormServiceInput, validateFormDefinition } = await import('../lib/forms.mjs');
const { startFormsWorker } = await import('../lib/forms-queue.mjs');

const adminKey = 'forms_admin_test_key';
process.env.AI7_ADMIN_KEY_HASHES = createHash('sha256').update(adminKey).digest('hex');
const store = new EnvironmentStore();
const reportStore = new MemoryAdverseMediaReportStore();
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

before(async () => {
  await store.upsertIntegration({
    id: 'company-search', name: 'Company Search', publicPath: '/service/company_search', method: 'POST',
    upstreamUrl: 'http://company.test/search', authType: 'header', authHeader: 'x-api-key', authPrefix: '',
    adapter: 'passthrough', acceptedContentTypes: ['application/json'], documentedStatuses: [200], enabled: true
  }, 'private-company-key');
  app = createAppServer({
    store,
    reportStore,
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
