import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryCustomerUsageStore } from '../lib/customer-usage.mjs';
import { MemoryFloStore } from '../lib/flows/store.mjs';

process.env.NODE_ENV = 'test';
process.env.FLO_ENABLED = 'true';
process.env.FLO_SESSION_HASH_KEY_HEX = '77'.repeat(32);
process.env.FLO_DATA_KEY_HEX = '33'.repeat(32);
const { createAppServer } = await import('../server.mjs');

test('two published flows in one workspace pin independent config, idempotency and supplier bundles', async (t) => {
  const platform = new EnvironmentStore(); const usage = new MemoryCustomerUsageStore();
  const flo = new MemoryFloStore();
  const issued = await platform.createClient('Synthetic buyer');
  const workspace = issued.client.workspaceId;
  await usage.configure(workspace, { mode: 'postpay', currency: 'USD', allowedModules: ['flo'],
    rates: {} });
  await flo.putTemplate({ enabled: true }, 'kys-v1');
  await flo.putTemplate({ enabled: true }, 'supplier-onboarding-v1');
  await flo.putConfig(workspace, { enabled: true, brand_name: 'KYS Buyer' }, 'kys-v1');
  await flo.putConfig(workspace, { enabled: true, brand_name: 'Supplier Buyer' }, 'supplier-onboarding-v1');
  const server = createAppServer({ store: platform, usageStore: usage, floStore: flo,
    mailer: { sendFloLink: async () => {} }, startWorker: false, deepResearchQueue: null, formsQueue: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); delete process.env.FLO_ENABLED; });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, host, method = 'GET', value, extra = {}) => new Promise((resolve, reject) => {
    const raw = value === undefined ? null : JSON.stringify(value);
    const req = httpRequest(base + path, { method, headers: { host,
      ...(raw === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) }), ...extra } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, text: () => Buffer.concat(chunks).toString(),
        json: () => JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(raw);
  });
  const auth = { authorization: `Bearer ${issued.apiKey}`, 'idempotency-key': 'shared-request-123' };
  const input = { customer_reference: 'SYNTHETIC', supplier_email: 'supplier@example.com' };
  const kys = await send('/flows/kys-v1/links', 'api.ai7uae.com', 'POST', input, auth);
  const supplier = await send('/flows/supplier-onboarding-v1/links', 'api.ai7uae.com', 'POST', input, auth);
  assert.equal(kys.status, 201); assert.equal(supplier.status, 201);
  const kysLink = kys.json(); const supplierLink = supplier.json();
  assert.notEqual(kysLink.application_id, supplierLink.application_id);
  assert.equal((await flo.getCase(workspace, kysLink.application_id)).flow_id, 'kys-v1');
  assert.equal((await flo.getCase(workspace, supplierLink.application_id)).flow_id, 'supplier-onboarding-v1');
  assert.equal((await flo.getCase(workspace, supplierLink.application_id)).configuration.brand_name, 'Supplier Buyer');
  assert.ok((await flo.getCase(workspace, supplierLink.application_id)).definition_hash);
  assert.match((await send('/f/' + kysLink.supplier_url.split('/').at(-1), 'flo.ai7uae.com')).text(), /Supplier onboarding · Flo/);
  assert.match((await send('/f/' + supplierLink.supplier_url.split('/').at(-1), 'flo.ai7uae.com')).text(), /Supplier onboarding/);
  assert.equal((await send('/assets/supplier-onboarding-v1/1.0.0/app.js', 'flo.ai7uae.com')).status, 200);
  const redeemed = await send('/flo/api/session', 'flo.ai7uae.com', 'POST',
    { token: supplierLink.supplier_url.split('/').at(-1) });
  assert.equal(redeemed.status, 200);
  const cookie = redeemed.headers['set-cookie'][0].split(';')[0];
  assert.match((await send('/flo', 'flo.ai7uae.com', 'GET', undefined, { cookie })).text(), /Supplier onboarding/);
  await flo.updateCase(workspace, supplierLink.application_id, (item) => {
    item.checks.push({ service_id: 'entity-adverse-media', raw_response: { private: 'PRIVATE_ADVERSE' } });
    item.events.push({ type: 'buyer_decision', rationale: 'PRIVATE_DECISION' });
    return item;
  });
  const supplierView = await send('/flo/api/application', 'flo.ai7uae.com', 'GET', undefined,
    { cookie, 'x-flo-application-id': supplierLink.application_id });
  assert.equal(supplierView.status, 200);
  assert.ok(!supplierView.text().includes('PRIVATE_ADVERSE'));
  assert.ok(!supplierView.text().includes('PRIVATE_DECISION'));
  const replay = await send('/flows/supplier-onboarding-v1/links', 'api.ai7uae.com', 'POST', input, auth);
  assert.equal(replay.status, 200); assert.equal(replay.json().application_id, supplierLink.application_id);
  assert.equal([...usage.rows.values()].filter((row) => row.state === 'completed').length, 2);
  assert.equal([...usage.rows.values()].filter((row) => row.state === 'refunded').length, 1);
  await flo.putTemplate({ enabled: false }, 'supplier-onboarding-v1');
  assert.equal((await send('/flows/supplier-onboarding-v1/links', 'api.ai7uae.com', 'POST', input,
    { ...auth, 'idempotency-key': 'new-request-123' })).status, 403);
  assert.equal((await send(`/flows/applications/${supplierLink.application_id}`, 'api.ai7uae.com', 'GET', undefined, auth)).status, 200);
});
