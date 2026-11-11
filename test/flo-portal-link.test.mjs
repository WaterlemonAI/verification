import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { MemoryCustomerUsageStore } from '../lib/customer-usage.mjs';
import { handleFloRequest } from '../lib/flows/routes.mjs';

process.env.FLO_ENABLED = 'true';
process.env.FLO_SESSION_HASH_KEY_HEX = '77'.repeat(32);

test('buyer UI creates a metered Supplier Onboarding v1 link without an API key', async (t) => {
  const workspace = '1234567890abcdef';
  const floStore = new MemoryFloStore();
  const usage = new MemoryCustomerUsageStore();
  const sent = [];
  await floStore.putTemplate({ enabled: true }, 'supplier-onboarding-v1');
  await floStore.putConfig(workspace, { enabled: true, brand_name: 'Buyer' }, 'supplier-onboarding-v1');
  await usage.configure(workspace, { mode: 'postpay', currency: 'USD', allowedModules: ['flo'], rates: {} });
  const server = createServer(async (req, res) => {
    const handled = await handleFloRequest(req, res, new URL(req.url, 'http://localhost'), {
      host: req.headers.host, floStore,
      platformStore: { getCustomer: async () => ({ id: workspace }) },
      getPortal: async (request, response, csrf) => {
        if (!request.headers.cookie?.includes('session=')) {
          response.writeHead(401); response.end(); return null;
        }
        if (csrf && request.headers['x-ai7-csrf'] !== 'valid-csrf') {
          response.writeHead(403); response.end(); return null;
        }
        return { account: { client_id: workspace,
          role: request.headers.cookie.includes('session=member') ? 'member'
            : request.headers.cookie.includes('session=legacy') ? undefined : 'org_admin',
          email: 'buyer@example.com' } };
      },
      hasEntitlement: async (id) => { const { allowed_modules } = await usage.account(id);
        return allowed_modules.includes('*') || allowed_modules.includes('flo'); },
      workflowPlatformEnabled: false,
      charge: async (_request, owner, flowId, channel) => {
        assert.equal(channel, 'portal');
        assert.equal(flowId, 'supplier-onboarding-v1');
        const admission = await usage.admit(owner, { transactionId: randomUUID(), keyId: '',
          moduleIds: ['flo'], method: 'POST', path: `/portal/api/flo/flows/${flowId}/links` });
        return { ...admission, settle: (status) => usage.complete(owner, admission.logKey, status) };
      },
      sendLink: async (message) => { sent.push(message); }
    });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const send = (path, method = 'GET', input, headers = {}) => new Promise((resolve, reject) => {
    const raw = input === undefined ? null : JSON.stringify(input);
    const req = httpRequest(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { host: 'app.kycprobe.com', cookie: 'session=admin',
        ...(raw === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) }),
        ...headers } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }));
    }); req.on('error', reject); req.end(raw);
  });
  const path = '/portal/api/flo/flows/supplier-onboarding-v1/links';
  const input = { customer_reference: 'TEST-1', supplier_email: 'supplier@example.com' };
  const headers = { 'x-ai7-csrf': 'valid-csrf', 'idempotency-key': 'portal-link-12345' };
  assert.equal((await send('/portal/api/flo/flows', 'GET', undefined,
    { cookie: 'session=member' })).status, 403);
  assert.deepEqual((await send('/portal/api/flo/flows')).body.flows.map((flow) => flow.flow_id),
    ['supplier-onboarding-v1']);
  assert.equal((await send('/portal/api/flo/flows', 'GET', undefined,
    { cookie: 'session=legacy' })).status, 200);
  assert.equal((await send('/portal/api/flo/status')).body.workflow_platform_enabled, false);
  assert.equal((await send(path, 'POST', input, { ...headers, cookie: 'session=member' })).status, 403);
  assert.equal((await send(path, 'POST', input, { 'idempotency-key': headers['idempotency-key'] })).status, 403);
  const created = await send(path, 'POST', input, headers);
  assert.equal(created.status, 201);
  assert.equal(created.body.flow_id, 'supplier-onboarding-v1');
  assert.match(created.body.supplier_url, /^https:\/\/flo\.ai7uae\.com\/f\//);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, input.supplier_email);
  const item = await floStore.getCase(workspace, created.body.application_id);
  assert.equal(item.events[0].actor, 'buyer@example.com');
  const replay = await send(path, 'POST', input, headers);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.application_id, created.body.application_id);
  assert.equal(replay.body.supplier_url, null);
  assert.equal(sent.length, 1);
  assert.equal([...usage.rows.values()].filter((row) => row.state === 'completed').length, 1);
  assert.equal([...usage.rows.values()].filter((row) => row.state === 'refunded').length, 1);
  await usage.configure(workspace, { mode: 'postpay', currency: 'USD', allowedModules: ['*'], rates: {} });
  assert.equal((await send('/portal/api/flo/flows')).status, 200);
  const wildcard = await send(path, 'POST', { ...input, customer_reference: 'TEST-WILDCARD' },
    { ...headers, 'idempotency-key': 'portal-link-wildcard-12345' });
  assert.equal(wildcard.status, 201);
  await usage.configure(workspace, { mode: 'postpay', currency: 'USD', allowedModules: [], rates: {} });
  assert.equal((await send('/portal/api/flo/flows')).status, 404);
  assert.equal((await send(path, 'POST', { ...input, customer_reference: 'TEST-DENIED' },
    { ...headers, 'idempotency-key': 'portal-link-denied-12345' })).status, 404);
});
