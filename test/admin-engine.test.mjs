import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');
const { EnvironmentStore } = await import('../lib/api-store.mjs');

const adminKey = 'ai7_admin_test_key';
process.env.AI7_ADMIN_KEY_HASHES = createHash('sha256').update(adminKey).digest('hex');
delete process.env.UAE_TLV_UPSTREAM_URL;
delete process.env.UAE_TLV_UPSTREAM_TOKEN;

const store = new EnvironmentStore();
let app;
let appUrl;
let receivedUpstream;

before(async () => {
  app = createAppServer({
    store,
    fetchImpl: async (url, options) => {
      receivedUpstream = { url: String(url), headers: options.headers, body: JSON.parse(options.body.toString('utf8')) };
      return new Response(JSON.stringify({ status: 'Success', reference: 'engine-test' }), { status: 201, headers: { 'content-type': 'application/json', 'x-supplier': 'hidden' } });
    }
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${app.address().port}`;
});

after(async () => new Promise((resolve) => app.close(resolve)));

function adminHeaders() {
  return { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
}

test('admin API rejects an invalid admin key', async () => {
  const response = await fetch(`${appUrl}/admin/api/integrations`, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { status: 'Error', error: 'Admin key is missing or incorrect.' });
});

test('admin can register a provider-neutral API without exposing its upstream details', async () => {
  const response = await fetch(`${appUrl}/admin/api/integrations/company-search`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify({
      name: 'Company Search',
      publicPath: '/service/company_search',
      method: 'POST',
      upstreamUrl: 'http://supplier.test/private/search',
      authType: 'header',
      authHeader: 'x-master-key',
      authPrefix: '',
      masterAuthKey: 'master-secret',
      acceptedContentTypes: ['application/json'],
      documentedStatuses: [201, 400, 401, 500],
      enabled: true
    })
  });
  assert.equal(response.status, 200);

  const listing = await fetch(`${appUrl}/admin/api/integrations`, { headers: adminHeaders() });
  const body = await listing.json();
  assert.equal(body.integrations.length, 1);
  assert.equal(body.integrations[0].publicPath, '/service/company_search');
  assert.equal(body.integrations[0].upstreamUrl, undefined);
  assert.equal(JSON.stringify(body).includes('supplier.test'), false);
  assert.equal(JSON.stringify(body).includes('master-secret'), false);
});

test('issued customer key works across the configured engine and can be revoked', async () => {
  const issuedResponse = await fetch(`${appUrl}/admin/api/clients`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ name: 'Test Workspace' })
  });
  assert.equal(issuedResponse.status, 201);
  const issued = await issuedResponse.json();
  assert.match(issued.apiKey, /^ai7_live_[a-f0-9]{16}_[A-Za-z0-9_-]+$/);

  const apiResponse = await fetch(`${appUrl}/service/company_search?country=AE`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ company_name: 'Example LLC' })
  });
  assert.equal(apiResponse.status, 201);
  assert.deepEqual(await apiResponse.json(), { status: 'Success', reference: 'engine-test' });
  assert.equal(receivedUpstream.url, 'http://supplier.test/private/search?country=AE');
  assert.equal(receivedUpstream.headers['x-master-key'], 'master-secret');
  assert.equal(receivedUpstream.headers.authorization, undefined);
  assert.deepEqual(receivedUpstream.body, { company_name: 'Example LLC' });

  const revoked = await fetch(`${appUrl}/admin/api/clients/${issued.client.id}/revoke`, { method: 'POST', headers: adminHeaders() });
  assert.equal(revoked.status, 200);
  const rejected = await fetch(`${appUrl}/service/company_search`, {
    method: 'POST', headers: { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(rejected.status, 401);
});
