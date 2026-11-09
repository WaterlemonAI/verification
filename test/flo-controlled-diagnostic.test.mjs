import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { MemoryFloQueue } from '../lib/flows/queue.mjs';
import { handleFloRequest } from '../lib/flows/routes.mjs';
import { processFloApplication } from '../lib/flows/processor.mjs';
import { createFloReport } from '../lib/flows/report-pdf.mjs';

process.env.FLO_ENABLED = 'true';
process.env.FLO_DATA_KEY_HEX = '55'.repeat(32);
process.env.FLO_SESSION_HASH_KEY_HEX = '77'.repeat(32);

test('controlled diagnostic is case-scoped, reports missing evidence and cannot submit or accept', async (t) => {
  const workspace = '1234567890abcdef';
  const floStore = new MemoryFloStore(); const queue = new MemoryFloQueue(); const callbacks = new MemoryFloQueue();
  await floStore.putTemplate({ enabled: true }, 'supplier-onboarding-v1');
  await floStore.putConfig(workspace, { enabled: true, brand_name: 'Pilot', callback_url: 'https://buyer.example/callback' },
    'supplier-onboarding-v1');
  const server = createServer(async (req, res) => {
    const handled = await handleFloRequest(req, res, new URL(req.url, 'http://localhost'), {
      host: req.headers.host, floStore, platformStore: { getCustomer: async () => ({ id: workspace }) },
      getPortal: async () => ({ account: { client_id: workspace,
        role: req.headers.cookie === 'member' ? 'member' : 'org_admin', email: 'buyer@example.com' } }),
      customerKey: async () => ({ id: workspace }), hasEntitlement: async () => true,
      charge: async () => ({ allowed: true, settle: async () => {} }), scan: async () => 'passed',
      enqueue: (job) => queue.enqueue(job), enqueueCallback: (job) => callbacks.enqueue(job)
    });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  t.after(() => { delete process.env.FLO_DIAGNOSTIC_WORKSPACE_ID; delete process.env.FLO_DIAGNOSTIC_APPLICATION_ID; });
  const send = (path, host, method = 'GET', value, headers = {}) => new Promise((resolve, reject) => {
    const raw = value === undefined ? null : JSON.stringify(value);
    const request = httpRequest(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { host,
      ...(raw === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) }), ...headers } }, (res) => {
      const chunks = []; res.on('data', (part) => chunks.push(part));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }); request.on('error', reject); request.end(raw);
  });
  const link = await send('/flows/supplier-onboarding-v1/links', 'api.ai7uae.com', 'POST',
    { customer_reference: 'DIAGNOSTIC', supplier_email: 'supplier@example.com' },
    { 'idempotency-key': 'diagnostic-test-1234' });
  const created = JSON.parse(link.body); const id = created.application_id;
  const redeemed = await send('/flo/api/session', 'flo.ai7uae.com', 'POST', { token: created.supplier_url.split('/').at(-1) });
  assert.equal(redeemed.status, 200);
  const portal = `/portal/api/flo/cases/${id}`;
  const pdf = { mime_type: 'application/pdf', content_base64: Buffer.from('%PDF-1.4\nsynthetic').toString('base64') };
  const other = await send('/flows/supplier-onboarding-v1/links', 'api.ai7uae.com', 'POST',
    { customer_reference: 'OTHER', supplier_email: 'supplier@example.com' },
    { 'idempotency-key': 'diagnostic-test-other' });
  const otherId = JSON.parse(other.body).application_id;
  process.env.FLO_DIAGNOSTIC_WORKSPACE_ID = workspace;
  process.env.FLO_DIAGNOSTIC_APPLICATION_ID = id;
  assert.equal((await send(`${portal}/diagnostic/documents`, 'app.kycprobe.com', 'POST',
    { type: 'bankConfirmationFile', diagnostic_label: 'official', ...pdf })).status, 400);
  assert.equal((await send(`/portal/api/flo/cases/${otherId}/diagnostic/run`, 'app.kycprobe.com', 'POST', {})).status, 404);
  assert.equal((await send(`${portal}/diagnostic/run`, 'app.kycprobe.com', 'POST', {}, { cookie: 'member' })).status, 403);
  assert.equal((await send(`${portal}/diagnostic/documents`, 'app.kycprobe.com', 'POST',
    { type: 'bankConfirmationFile', diagnostic_label: 'test_sample', ...pdf })).status, 201);
  assert.equal((await send(`${portal}/diagnostic/run`, 'app.kycprobe.com', 'POST', {})).status, 202);
  assert.equal((await send(`${portal}/diagnostic/run`, 'app.kycprobe.com', 'POST', {})).status, 409);
  assert.equal(queue.jobs[0].job_type, 'diagnostic');
  await queue.drain((job) => processFloApplication(job, {
    floStore, enqueue: (next) => queue.enqueue(next), enqueueCallback: (next) => callbacks.enqueue(next),
    extractBank: async () => ({ status: 'completed', data: { iban: 'AE123', account_holder: 'Example' } }),
    runGeminiReview: async () => ({ status: 'not_run', reason_codes: ['incomplete_evidence'] }),
    createReport: createFloReport
  }));
  const item = await floStore.getCase(workspace, id);
  assert.equal(item.status, 'in_progress');
  assert.equal(item.submitted_at, null);
  assert.equal(item.diagnostic.state, 'complete');
  assert.equal(item.documents[0].diagnostic_label, 'test_sample');
  assert.equal(item.checks.find((check) => check.service_id === 'ejari-verification').transport, 'not_run');
  const report = await send(`${portal}/report.json`, 'app.kycprobe.com');
  assert.match(report.body, /CONTROLLED PILOT DIAGNOSTIC/);
  assert.match(report.body, /locationEvidenceFile: missing; not_run/);
  assert.match(report.body, /bank_confirmation_is_test_sample/);
  assert.equal(callbacks.jobs.length, 1);
  assert.equal(item.events.at(-1).type, 'diagnostic_review_ready');
  assert.equal(item.events.at(-1).payload.diagnostic.state, 'complete');
  assert.equal((await send(`${portal}/decision`, 'app.kycprobe.com', 'POST',
    { decision: 'accepted', rationale: 'No' })).status, 409);
  assert.equal((await send(`${portal}/diagnostic/decision`, 'app.kycprobe.com', 'POST',
    { outcome: 'needs_more_evidence', rationale: 'Premises evidence is absent.' })).status, 200);
  assert.equal(callbacks.jobs.length, 2);
  assert.equal((await floStore.getCase(workspace, id)).diagnostic.outcome, 'needs_more_evidence');
});
