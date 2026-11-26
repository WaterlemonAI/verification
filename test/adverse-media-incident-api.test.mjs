import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryCustomerUsageStore, validateCasePolicy, validateUsagePolicy } from '../lib/customer-usage.mjs';
import { MemoryCaseManagerStore } from '../lib/case-manager-store.mjs';
import { MemoryAdvanceAdmissionStore } from '../lib/adverse-media-advance-store.mjs';
import { MemoryAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';
import { MemoryAdverseMediaJsonStore } from '../lib/adverse-media-json-store.mjs';
import { INCIDENT_PUBLIC_PATH, INCIDENT_SERVICE_ID,
  processIncidentReportJob } from '../lib/adverse-media-incident-job.mjs';

process.env.NODE_ENV = 'test';
process.env.ADVERSE_MEDIA_INCIDENT_SCREENING_ENABLED = 'true';
delete process.env.EVENT_REGISTRY_API_KEY;
const { createAppServer } = await import('../server.mjs');

const store = new EnvironmentStore();
const usageStore = new MemoryCustomerUsageStore();
const admissionStore = new MemoryAdvanceAdmissionStore({ namespace: 'incident' });
const reportStore = new MemoryAdverseMediaReportStore();
const jsonStore = new MemoryAdverseMediaJsonStore();
const jobs = [];
let issued;
let app;
let base;
const input = { subject: { name: 'Example Trading LLC', entity_type: 'business', aliases: [] },
  date_from: '2026-11-01', date_to: '2026-11-25' };

before(async () => {
  await store.setMasterKey('adverse-media', 'brave-test-key');
  await store.setMasterKey('adverse-media-jev', 'jev-test-key');
  await store.setMasterKey('adverse-media-summary', 'summary-test-key');
  await store.setMasterKey('adverse-media-article-extraction', 'article-test-key');
  issued = await store.createClient('Incident screening workspace');
  await usageStore.configure(issued.client.id, validateUsagePolicy({ mode: 'postpay', currency: 'USD',
    allowed_modules: [INCIDENT_SERVICE_ID],
    rates: { [INCIDENT_SERVICE_ID]: [{ up_to: null, price: '0.75' }] }
  }, new Set([INCIDENT_SERVICE_ID])));
  app = createAppServer({ store, usageStore, incidentAdmissionStore: admissionStore,
    reportStore, jsonStore, incidentQueue: { async enqueue(job) { jobs.push(job); } },
    startWorker: false });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => new Promise((resolve) => app.close(resolve)));

const authorization = () => ({ authorization: `Bearer ${issued.apiKey}` });
const submit = (key, body = input) => fetch(`${base}${INCIDENT_PUBLIC_PATH}`, { method: 'POST',
  headers: { ...authorization(), 'content-type': 'application/json', 'idempotency-key': key },
  body: JSON.stringify(body) });

test('new product has a distinct durable admission partition', async () => {
  const oldStore = new MemoryAdvanceAdmissionStore();
  const job = { screening_id: '11111111-1111-4111-8111-111111111111',
    report_id: '22222222-2222-4222-8222-222222222222' };
  const oldClaim = await oldStore.claim({ workspaceId: issued.client.id,
    idempotencyKey: 'same-key-across-products', payloadHash: 'same', job });
  const newClaim = await admissionStore.claim({ workspaceId: issued.client.id,
    idempotencyKey: 'same-key-across-products', payloadHash: 'same', job });
  assert.notEqual(oldClaim.row.partitionKey, newClaim.row.partitionKey);
});

test('new API queues once, bills once, and returns private JSON and PDF', async () => {
  const first = await submit('incident-primary-0001');
  assert.equal(first.status, 202);
  const receipt = await first.json();
  assert.equal(receipt.status, 'queued');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].incident_report_v1, true);
  assert.equal(jobs[0].input_payload.adverse_profile, 'all');
  assert.equal(jobs[0].input_payload.max_articles, 40);
  const replay = await submit('incident-primary-0001');
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).screening_id, receipt.screening_id);
  assert.equal(jobs.length, 1);
  assert.equal((await usageStore.account(issued.client.id)).charged_calls, 1);

  const queued = await fetch(`${base}${receipt.status_url}`, { headers: authorization() });
  assert.equal((await queued.json()).status, 'queued');
  const pdf = Buffer.from('%PDF-1.7\nsynthetic-test\n');
  await processIncidentReportJob(jobs[0], { store, reportStore, jsonStore, usageStore,
    archiveSearch: async () => ({}), archivePage: async () => ({}),
    createReport: async (_input, dependencies) => {
      assert.equal(dependencies.screeningDependencies.eventRegistryApiKey, 'article-test-key');
      assert.equal(dependencies.screeningDependencies.jevApiKey, 'jev-test-key');
      assert.equal(dependencies.summaryApiKey, 'summary-test-key');
      return { response: { contract: 'adverse-media-incident-report-v1',
      subject: { name: input.subject.name }, screening_result: 'Safe',
      report: { filename: 'test-report.pdf', sha256: 'synthetic', digitally_signed: false,
        pdf_base64: pdf.toString('base64') } }, pdf,
      audit: { timings_ms: { total: 1 }, usage: {}, costs: {} } };
    } });
  const completed = await fetch(`${base}${receipt.status_url}`, { headers: authorization() });
  const body = await completed.json();
  assert.equal(body.status, 'completed');
  assert.equal(body.result.screening_result, 'Safe');
  assert.equal(body.result.report.digitally_signed, false);
  assert.equal(body.result.report.pdf_base64, undefined);
  assert.match(JSON.stringify(body.result), /pdf_url/);
  const report = await fetch(`${base}${body.result.report.pdf_url}`, { headers: authorization() });
  assert.equal(report.status, 200);
  assert.deepEqual(Buffer.from(await report.arrayBuffer()), pdf);

  const stranger = await store.createClient('Unentitled workspace');
  const isolated = await fetch(`${base}${receipt.status_url}`,
    { headers: { authorization: `Bearer ${stranger.apiKey}` } });
  assert.equal(isolated.status, 403);
  const unauthenticated = await fetch(`${base}${receipt.status_url}`);
  assert.equal(unauthenticated.status, 401);
  const conflict = await submit('incident-primary-0001', { ...input, subject: { ...input.subject, name: 'Different LLC' } });
  assert.equal(conflict.status, 409);
});

test('worker failure refunds a separate incident check', async () => {
  const response = await submit('incident-failure-0001');
  assert.equal(response.status, 202);
  const receipt = await response.json();
  const job = jobs.at(-1);
  await assert.rejects(() => processIncidentReportJob(job,
    { store, reportStore, jsonStore, usageStore, createReport: async () => { throw new Error('provider_failed'); } }),
  /provider_failed/);
  const failed = await fetch(`${base}${receipt.status_url}`, { headers: authorization() });
  assert.equal((await failed.json()).status, 'failed');
  const account = await usageStore.account(issued.client.id);
  assert.equal(account.charged_calls, 1);
  assert.equal(account.spent, '0.750000');
});

test('queued incident screening links to its workspace case', async (t) => {
  process.env.CASE_MANAGER_ENABLED = 'true';
  t.after(() => { delete process.env.CASE_MANAGER_ENABLED; });
  const cases = new MemoryCaseManagerStore();
  await usageStore.updateCasePolicy(issued.client.id,
    validateCasePolicy({ version: 0, enabled: true, ttl_days: 30 }));
  const submitted = [];
  const caseApp = createAppServer({ store, usageStore, caseStore: cases,
    incidentAdmissionStore: new MemoryAdvanceAdmissionStore({ namespace: 'incident-case' }),
    reportStore: new MemoryAdverseMediaReportStore(), jsonStore: new MemoryAdverseMediaJsonStore(),
    incidentQueue: { async enqueue(job) { submitted.push(job); } }, startWorker: false });
  await new Promise((resolve) => caseApp.listen(0, '127.0.0.1', resolve));
  t.after(() => caseApp.close());
  const response = await fetch(`http://127.0.0.1:${caseApp.address().port}${INCIDENT_PUBLIC_PATH}`,
    { method: 'POST', headers: { ...authorization(), 'content-type': 'application/json',
      'idempotency-key': 'incident-case-link-0001' }, body: JSON.stringify(input) });
  assert.equal(response.status, 202);
  const receipt = await response.json();
  assert.equal(submitted.length, 1);
  assert.match(submitted[0].case_id, /^[0-9a-f-]{36}$/i);
  assert.equal(submitted[0].case_workspace_id, issued.client.id);
  const linked = await cases.getCase(issued.client.id, submitted[0].case_id);
  assert.equal(linked.service_id, INCIDENT_SERVICE_ID);
  assert.equal(linked.state, 'pending');
  assert.equal(receipt.screening_id, submitted[0].screening_id);
});

test('new API documentation and credential gate are independent of the older API', async () => {
  const spec = await fetch(`${base}/adverse-media-incident/openapi.json`).then((response) => response.json());
  assert.ok(spec.paths[INCIDENT_PUBLIC_PATH].post);
  assert.ok(spec.paths[`${INCIDENT_PUBLIC_PATH}/jobs/{screeningId}`].get);
  assert.ok(spec.paths[`${INCIDENT_PUBLIC_PATH}/reports/{reportId}.pdf`].get);
  const withoutKey = await fetch(`${base}${INCIDENT_PUBLIC_PATH}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'incident-no-auth-0001' },
    body: JSON.stringify(input) });
  assert.equal(withoutKey.status, 401);
  const queuedBefore = jobs.length;
  await store.setMasterKey('adverse-media-summary', '');
  try {
    const unavailable = await submit('incident-no-summary-0001');
    assert.equal(unavailable.status, 503);
    assert.equal(jobs.length, queuedBefore);
  } finally { await store.setMasterKey('adverse-media-summary', 'summary-test-key'); }
  await store.setMasterKey('adverse-media-article-extraction', '');
  try {
    const unavailable = await submit('incident-no-articles-0001');
    assert.equal(unavailable.status, 503);
    assert.equal(jobs.length, queuedBefore);
  } finally { await store.setMasterKey('adverse-media-article-extraction', 'article-test-key'); }
});
