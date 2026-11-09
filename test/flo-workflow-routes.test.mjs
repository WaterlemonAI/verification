import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { MemoryFloQueue } from '../lib/flows/queue.mjs';
import { handleFloRequest } from '../lib/flows/routes.mjs';
import { processGenericFloApplication } from '../lib/flows/processor.mjs';

process.env.FLO_ENABLED = 'true';
process.env.FLO_SESSION_HASH_KEY_HEX = '77'.repeat(32);
process.env.FLO_DATA_KEY_HEX = '33'.repeat(32);

const schema = { schema_version: '1.0.0', name: 'Supplier profile', stages: [
  { id: 'identity', title: 'Identity', fields: [{ id: 'business_name', label: 'Business name', type: 'text', required: true }],
    documents: [], declarations: [] }], checks: ['entity-aml'], report_sections: [], tokens: {} };
const a = 'a'.repeat(16), b = 'b'.repeat(16);

test('admin assignment to private copy, applicant submission, buyer Restart and second report keep the same case ID', async (t) => {
  const store = new MemoryFloStore(); const jobs = new MemoryFloQueue(); const notifications = new MemoryFloQueue();
  let workflowPlatformEnabled = true;
  const server = createServer(async (req, res) => {
    const handled = await handleFloRequest(req, res, new URL(req.url, 'http://localhost'), {
      host: req.headers.host, floStore: store, platformStore: { getCustomer: async () => ({ id: a }) },
      getAdmin: async (_req, response, csrf) => { if (csrf && _req.headers['x-ai7-csrf'] !== 'token') {
        response.writeHead(403); response.end(); return null; } return { account: { email: 'admin@example.com' } }; },
      getPortal: async (request, response, csrf) => { if (!request.headers.cookie) { response.writeHead(401); response.end(); return null; }
        if (csrf && request.headers['x-ai7-csrf'] !== 'token') { response.writeHead(403); response.end(); return null; }
        return { account: { client_id: request.headers.cookie.includes('workspace=b') ? b : a,
          role: 'org_admin', email: 'buyer@example.com' } }; },
      hasEntitlement: async () => true, workflowPlatformEnabled,
      charge: async () => ({ allowed: true, settle: async () => {} }),
      enqueue: (job) => jobs.enqueue(job), enqueueEmail: (job) => notifications.enqueue(job),
      enqueueCallback: (job) => notifications.enqueue(job), scan: async () => {}
    });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const send = (path, host = 'app.kycprobe.com', method = 'GET', value, headers = {}) => new Promise((resolve, reject) => {
    const raw = value === undefined ? null : JSON.stringify(value);
    const request = httpRequest(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: {
      host, cookie: 'workspace=a', ...(raw == null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) }),
      ...(method === 'GET' ? {} : { 'x-ai7-csrf': 'token' }), ...headers } }, (response) => {
      const chunks = []; response.on('data', (part) => chunks.push(part)); response.on('end', () => {
        const bytes = Buffer.concat(chunks); resolve({ status: response.statusCode, headers: response.headers,
          body: bytes.length && String(response.headers['content-type']).includes('application/json') ? JSON.parse(bytes.toString()) : bytes }); });
    }); request.on('error', reject); request.end(raw);
  });
  const created = await send('/admin/api/flows', undefined, 'POST', { schema });
  assert.equal(created.status, 201); const platformId = created.body.workflow.flow_id;
  assert.equal((await send(`/admin/api/flows/${platformId}/publish`, undefined, 'POST',
    { expected_revision: 1 })).status, 200);
  assert.equal((await send(`/admin/api/flows/${platformId}/assignments`, undefined, 'PUT',
    { workspace_id: a, state: 'active' })).status, 200);
  assert.equal((await send(`/portal/api/flo/workflows/${platformId}/copy`, undefined, 'POST', {},
    { cookie: 'workspace=b' })).status, 404);
  const copied = await send(`/portal/api/flo/workflows/${platformId}/copy`, undefined, 'POST', {});
  assert.equal(copied.status, 201); const copyId = copied.body.workflow.flow_id;
  assert.equal((await send(`/portal/api/flo/workflows/${copyId}/publish`, undefined, 'POST',
    { expected_revision: 1 }, { cookie: 'workspace=b' })).status, 404);
  assert.equal((await send(`/portal/api/flo/workflows/${copyId}/publish`, undefined, 'POST',
    { expected_revision: 1 })).status, 200);
  const logo = await sharp({ create: { width: 1, height: 1, channels: 4,
    background: { r: 0, g: 90, b: 140, alpha: 1 } } }).png().toBuffer();
  const uploadedLogo = await send(`/portal/api/flo/workflows/${copyId}/logo`, undefined, 'POST',
    { mime_type: 'image/png', content_base64: logo.toString('base64') });
  assert.equal(uploadedLogo.status, 201);
  const link = await send(`/portal/api/flo/flows/${copyId}/links`, undefined, 'POST',
    { customer_reference: 'PO-1001', supplier_email: 'supplier@example.com' }, { 'idempotency-key': 'workflow-route-123' });
  assert.equal(link.status, 201); const appId = link.body.application_id;
  assert.equal(notifications.jobs[0].job_type, 'email');
  const token = link.body.supplier_url.split('/').at(-1);
  const redeemed = await send('/flo/api/session', 'flo.ai7uae.com', 'POST', { token });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.body.logo_asset_url, `/flo/assets/${copyId}/${uploadedLogo.body.logo_asset_id}`);
  const cookie = redeemed.headers['set-cookie'][0].split(';')[0];
  const logoResult = await send(redeemed.body.logo_asset_url, 'flo.ai7uae.com', 'GET', undefined, { cookie });
  assert.equal(logoResult.status, 200); assert.deepEqual(logoResult.body, logo);
  const supplierHeaders = { cookie, 'x-flo-application-id': appId, 'x-flo-csrf': redeemed.body.csrf_token,
    origin: 'https://flo.ai7uae.com' };
  assert.equal((await send('/flo/api/draft', 'flo.ai7uae.com', 'POST', { business_name: 'Aetherix Systems FZCO' }, supplierHeaders)).status, 200);
  assert.equal((await send('/flo/api/submit', 'flo.ai7uae.com', 'POST', {}, supplierHeaders)).status, 202);
  const process = jobs.jobs.find((job) => job.job_type === 'process');
  assert.ok(process);
  await processGenericFloApplication(process, { floStore: store, enqueue: async () => {},
    callProvider: async () => ({ httpStatus: 200, response: { status: 'completed', candidates: [] } }),
    runGeminiReview: async () => ({ status: 'not_run', reason_codes: ['test'] }),
    createReport: async (item) => ({ report_id: randomUUID(), pdf: Buffer.from('PDF'), html: '<p>Report</p>',
      model: {}, version: item.reports.length + 1, sha256: 'hash', generated_at: new Date().toISOString() }) });
  assert.equal((await store.getCase(a, appId)).status, 'pending_review');
  const restarted = await send(`/portal/api/flo/cases/${appId}/decision`, undefined, 'POST',
    { decision: 'restart', comments: 'Update the registered business name', fields: ['business_name'] });
  assert.equal(restarted.status, 200);
  assert.equal(restarted.body.status, 'restarted');
  const oldLink = await send('/flo/api/session', 'flo.ai7uae.com', 'POST', { token });
  assert.equal(oldLink.status, 410);
  const second = await send('/flo/api/session', 'flo.ai7uae.com', 'POST',
    { token: restarted.body.supplier_url.split('/').at(-1) });
  assert.equal(second.body.status, 'restarted'); assert.equal(second.body.application_revision, 2);
  assert.equal(second.body.restart.comments, 'Update the registered business name');
  const secondCookie = second.headers['set-cookie'][0].split(';')[0];
  const headers2 = { cookie: secondCookie, 'x-flo-application-id': appId, 'x-flo-csrf': second.body.csrf_token,
    origin: 'https://flo.ai7uae.com' };
  assert.equal((await send('/flo/api/draft', 'flo.ai7uae.com', 'POST', { business_name: 'Aetherix Systems FZCO LLC' }, headers2)).status, 200);
  assert.equal((await send('/flo/api/submit', 'flo.ai7uae.com', 'POST', {}, headers2)).status, 202);
  const caseData = await store.getCase(a, appId);
  assert.equal(caseData.application_revision, 2); assert.equal(caseData.revisions.length, 1);
  assert.equal(caseData.revisions[0].draft.business_name, 'Aetherix Systems FZCO');
  assert.equal(caseData.draft.business_name, 'Aetherix Systems FZCO LLC');
  await store.putAssignment(a, platformId, 'paused');
  const pausedCatalog = await send('/admin/api/flows');
  assert.equal(pausedCatalog.body.workflows.find((entry) => entry.flow_id === platformId).active_organisation_count, 0);
  assert.equal(pausedCatalog.body.workflows.find((entry) => entry.flow_id === copyId).active_organisation_count, 0);
  assert.deepEqual((await send('/portal/api/flo/flows')).body.flows, []);
  assert.equal((await send('/portal/api/flo/status')).body.has_active_flow, false);
  await store.putAssignment(a, platformId, 'active');
  await store.putConfig(a, { enabled: false, brand_name: 'Buyer' }, copyId);
  assert.equal((await send('/portal/api/flo/flows')).body.flows.some((flow) => flow.flow_id === copyId), false);
  assert.equal((await send('/admin/api/flows')).body.workflows
    .find((entry) => entry.flow_id === copyId).active_organisation_count, 0);
  await store.putConfig(a, { enabled: true, brand_name: 'Buyer' }, copyId);
  workflowPlatformEnabled = false;
  assert.equal((await send('/portal/api/flo/status')).body.workflow_platform_enabled, false);
  assert.deepEqual((await send('/portal/api/flo/flows')).body.flows, []);
  assert.equal((await send('/portal/api/flo/workflows')).status, 404);
  assert.equal((await send('/admin/api/flows', undefined, 'POST', { schema })).status, 404);
  assert.equal((await send(`/portal/api/flo/flows/${copyId}/links`, undefined, 'POST',
    { customer_reference: 'PO-1002', supplier_email: 'supplier@example.com' },
    { 'idempotency-key': 'workflow-route-456' })).status, 404);
  assert.equal((await send(`/portal/api/flo/cases/${appId}`)).status, 200,
    'existing cases remain reviewable when workflow creation is switched off');
  assert.equal((await send('/flo/api/application', 'flo.ai7uae.com', 'GET', undefined, headers2)).status, 200,
    'the applicant receipt remains readable when workflow creation is switched off');
});
