import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryCustomerUsageStore } from '../lib/customer-usage.mjs';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { request as httpRequest } from 'node:http';

process.env.NODE_ENV = 'test';
process.env.FLO_ENABLED = 'true';
process.env.FLO_SESSION_HASH_KEY_HEX = '77'.repeat(32);
process.env.FLO_DATA_KEY_HEX = '33'.repeat(32);
const { createAppServer } = await import('../server.mjs');

test('Flo host isolation, explicit assignment, one-time redemption and supplier CSRF', async (t) => {
  const platform = new EnvironmentStore();
  const usage = new MemoryCustomerUsageStore();
  const flo = new MemoryFloStore();
  const issued = await platform.createClient('Synthetic buyer');
  const workspace = issued.client.workspaceId;
  const server = createAppServer({ store: platform, usageStore: usage, floStore: flo,
    mailer: { sendFloLink: async () => {} }, startWorker: false,
    deepResearchQueue: null, formsQueue: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); delete process.env.FLO_ENABLED; });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, host, method = 'GET', value, extra = {}) => new Promise((resolve, reject) => {
    const raw = value === undefined ? null : JSON.stringify(value);
    const request = httpRequest(base + path, { method,
      headers: { host, ...(raw === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) }), ...extra } }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => {
        const bytes = Buffer.concat(chunks); resolve({ status: response.statusCode,
          headers: { get: (name) => { const header = response.headers[name.toLowerCase()]; return Array.isArray(header) ? header[0] : header || null; } },
          json: async () => JSON.parse(bytes.toString()), text: async () => bytes.toString() });
      });
    });
    request.on('error', reject); request.end(raw);
  });

  const input = { customer_reference: 'ORDER-1', supplier_email: 'supplier@example.com' };
  const auth = { authorization: `Bearer ${issued.apiKey}`, 'idempotency-key': 'order-1-request' };
  const first = await send('/flows/kys-v1/links', 'api.ai7uae.com', 'POST', input, auth);
  assert.equal(first.status, 403, await first.text());
  await flo.putTemplate({ enabled: true });
  await flo.putConfig(workspace, { enabled: true, brand_name: 'Synthetic buyer' });
  assert.equal((await send('/flows/kys-v1/links', 'api.ai7uae.com', 'POST', input, auth)).status, 403);
  await usage.configure(workspace, { mode: 'postpay', currency: 'USD', allowedModules: ['flo'], rates: {} });
  const createdResponse = await send('/flows/kys-v1/links', 'api.ai7uae.com', 'POST', input, auth);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal((await flo.listCases(workspace)).length, 1);
  const replay = await send('/flows/kys-v1/links', 'api.ai7uae.com', 'POST', input, auth);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).application_id, created.application_id);
  assert.equal((await flo.listCases(workspace)).length, 1);
  assert.equal((await send('/service/health', 'flo.ai7uae.com')).status, 404);
  assert.equal((await send('/admin/api/modules', 'flo.ai7uae.com')).status, 404);
  assert.equal((await send('/f/' + created.supplier_url.split('/').at(-1), 'app.kycprobe.com')).status, 404);
  const token = created.supplier_url.split('/').at(-1);
  const redeemed = await send('/flo/api/session', 'flo.ai7uae.com', 'POST', { token });
  assert.equal(redeemed.status, 200);
  const cookie = redeemed.headers.get('set-cookie').split(';')[0];
  assert.match(redeemed.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/);
  const session = await redeemed.json();
  assert.equal((await send('/flo/api/session', 'flo.ai7uae.com', 'POST', { token })).status, 410);
  const supplierHeaders = { cookie, 'x-flo-application-id': created.application_id,
    'x-flo-csrf': session.csrf_token, origin: 'https://flo.ai7uae.com' };
  assert.equal((await send('/flo/api/draft', 'flo.ai7uae.com', 'POST', { business_name: 'Example' },
    { ...supplierHeaders, origin: 'https://attacker.example' })).status, 403);
  assert.equal((await send('/flo/api/draft', 'flo.ai7uae.com', 'POST', { business_name: 'Example' }, supplierHeaders)).status, 200);
  assert.equal((await flo.getCase(workspace, created.application_id)).draft.business_name, 'Example');
  assert.equal((await send(`/flows/applications/${created.application_id}`, 'app.kycprobe.com', 'GET', undefined,
    { authorization: `Bearer ${issued.apiKey}` })).status, 404);
  await flo.putConfig(workspace, { enabled: true, brand_name: 'Synthetic buyer', failure_url: 'https://buyer.example/failed' });
  const expiring = await send('/flows/kys-v1/links', 'api.ai7uae.com', 'POST',
    { customer_reference: 'ORDER-2', supplier_email: 'supplier@example.com' },
    { ...auth, 'idempotency-key': 'order-2-request' });
  assert.equal(expiring.status, 201);
  const expiredCase = await expiring.json();
  await flo.updateCase(workspace, expiredCase.application_id, (item) => {
    item.link_expires_at = '2000-01-01T00:00:00.000Z'; return item;
  });
  const expired = await send('/flo/api/session', 'flo.ai7uae.com', 'POST',
    { token: expiredCase.supplier_url.split('/').at(-1) });
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).failure_url, 'https://buyer.example/failed');
  assert.equal((await flo.getCase(workspace, expiredCase.application_id)).expires_at, null);
});
