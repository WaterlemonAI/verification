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
let relayRequests = [];

before(async () => {
  app = createAppServer({
    store,
    fetchImpl: async (url, options) => {
      const requestUrl = new URL(url);
      if (requestUrl.hostname === 'bank.test') {
        relayRequests.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body.toString('utf8')) });
        if (requestUrl.pathname === '/v1/apicall/encrypt') {
          if (relayRequests.at(-1).body.transID === 'INTERNAL-FAIL') return new Response('private provider failed', { status: 502 });
          const encrypted = relayRequests.at(-1).body.transID === 'UPSTREAM-FAIL' ? 'encrypted-error-request' : 'encrypted-request-payload';
          return new Response(encrypted, { status: 200, headers: { 'content-type': 'text/plain' } });
        }
        if (requestUrl.pathname === '/v1/apicall/bank/intl_bank_acc_verification') {
          const failed = relayRequests.at(-1).body.requestData === 'encrypted-error-request';
          return new Response(JSON.stringify({ responseData: failed ? 'encrypted-error-response' : 'encrypted-response-payload' }), { status: failed ? 500 : 200, headers: { 'content-type': 'application/json' } });
        }
        if (requestUrl.pathname === '/v1/apicall/decrypt') {
          if (relayRequests.at(-1).body.responseData === 'encrypted-error-response') {
            return new Response(JSON.stringify({ msg: 'Something went wrong at the serverside, Please try again later...', status: 0, transID: 'UPSTREAM-FAIL', tsTransId: 'TS-ERROR-001' }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify({
            msg: 'success', status: 1, trans_id: '275829', ts_transaction_id: 'TS-TEST-001',
            data: { results: { bank: 'MATCH', result: 'Full Bank and Account Owner Match', country: 'AE', bankCode: 'MATCH', completeName: 'MATCH', bankAccountNumber: 'MATCH' } }
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      }
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

  const catalog = await (await fetch(`${appUrl}/catalog.json`)).text();
  assert.equal(catalog.includes('supplier.test'), false);
  assert.equal(catalog.includes('master-secret'), false);
  assert.equal(catalog.includes('x-master-key'), false);
  assert.equal(catalog.includes('/service/company_search'), true);
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

test('encrypted IBAN adapter privately encrypts, verifies and decrypts without changing the public contract', async () => {
  const configured = await fetch(`${appUrl}/admin/api/integrations/iban-verification`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify({
      name: 'International Bank Account Verification',
      publicPath: '/service/iban_verification',
      method: 'POST',
      upstreamUrl: 'http://bank.test/v1/apicall/bank/intl_bank_acc_verification',
      authType: 'header',
      authHeader: 'username',
      authPrefix: '',
      adapter: 'encrypted-json-relay',
      acceptedContentTypes: ['application/json'],
      documentedStatuses: [200, 400, 401, 500],
      enabled: true
    })
  });
  assert.equal(configured.status, 200);
  assert.equal((await configured.json()).integration.masterAuthKeyConfigured, false);

  const credential = await fetch(`${appUrl}/admin/api/integrations/iban-verification/credential`, {
    method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ credential: 'private-username' })
  });
  assert.equal(credential.status, 200);
  assert.equal((await credential.json()).integration.masterAuthKeyConfigured, true);

  const issued = await (await fetch(`${appUrl}/admin/api/clients`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ name: 'IBAN Test Workspace' })
  })).json();
  relayRequests = [];
  const requestBody = {
    source: 'API', transID: 'CLIENT-001', docType: 610, requestCategory: 'business', country: 'AE',
    firstName: 'FIRST', lastName: 'LAST', completeName: 'FIRST LAST', bankCode: 'BANKCODE',
    bankAccountNumber: '1234567890', bic: 'BICCODE', iban: 'AE000000000000000000000', id: 'ID-1', idType: 'PASSPORT'
  };
  const response = await fetch(`${appUrl}/service/iban_verification`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody)
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    msg: 'success', status: 1, trans_id: '275829', ts_transaction_id: 'TS-TEST-001',
    data: { results: { bank: 'MATCH', result: 'Full Bank and Account Owner Match', country: 'AE', bankCode: 'MATCH', completeName: 'MATCH', bankAccountNumber: 'MATCH' } }
  });
  assert.equal(relayRequests.length, 3);
  assert.deepEqual(relayRequests.map((item) => new URL(item.url).pathname), [
    '/v1/apicall/encrypt', '/v1/apicall/bank/intl_bank_acc_verification', '/v1/apicall/decrypt'
  ]);
  assert.deepEqual(relayRequests[0].body, requestBody);
  assert.deepEqual(relayRequests[1].body, { requestData: 'encrypted-request-payload' });
  assert.deepEqual(relayRequests[2].body, { responseData: 'encrypted-response-payload' });
  for (const request of relayRequests) {
    assert.equal(request.headers.username, 'private-username');
    assert.equal(request.headers.authorization, undefined);
  }

  const adminListing = JSON.stringify(await (await fetch(`${appUrl}/admin/api/integrations`, { headers: adminHeaders() })).json());
  const publicCatalog = await (await fetch(`${appUrl}/catalog.json`)).text();
  for (const output of [adminListing, publicCatalog]) {
    assert.equal(output.includes('bank.test'), false);
    assert.equal(output.includes('private-username'), false);
  }
});

test('IBAN adapter preserves decrypted upstream error status and hides private relay failures', async () => {
  const issued = await (await fetch(`${appUrl}/admin/api/clients`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ name: 'IBAN Error Test' })
  })).json();
  const headers = { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' };

  const upstreamFailure = await fetch(`${appUrl}/service/iban_verification`, {
    method: 'POST', headers, body: JSON.stringify({ transID: 'UPSTREAM-FAIL', docType: 610, country: 'AE' })
  });
  assert.equal(upstreamFailure.status, 500);
  assert.deepEqual(await upstreamFailure.json(), {
    msg: 'Something went wrong at the serverside, Please try again later...', status: 0,
    transID: 'UPSTREAM-FAIL', tsTransId: 'TS-ERROR-001'
  });

  const privateFailure = await fetch(`${appUrl}/service/iban_verification`, {
    method: 'POST', headers, body: JSON.stringify({ transID: 'INTERNAL-FAIL', docType: 610, country: 'AE' })
  });
  assert.equal(privateFailure.status, 500);
  const privateBody = await privateFailure.json();
  assert.deepEqual(privateBody, { status: 'Error', error: 'The service is temporarily unavailable. Please try again shortly.' });
  assert.equal(JSON.stringify(privateBody).includes('provider'), false);
});

test('IBAN public docs include every input and response field without provider details', async () => {
  const html = await (await fetch(`${appUrl}/iban`)).text();
  const script = await (await fetch(`${appUrl}/iban.js`)).text();
  const specText = await (await fetch(`${appUrl}/openapi.json`)).text();
  const spec = JSON.parse(specText);
  const requestFields = ['source', 'transID', 'docType', 'requestCategory', 'country', 'firstName', 'lastName', 'completeName', 'bankCode', 'bankAccountNumber', 'bic', 'iban', 'id', 'idType'];
  const responseFields = ['msg', 'status', 'data', 'bank', 'result', 'country', 'bankCode', 'completeName', 'bankAccountNumber', 'trans_id', 'ts_transaction_id', 'transID', 'tsTransId'];
  for (const field of requestFields) {
    assert.equal(html.includes(field), true, `IBAN page omitted request field ${field}`);
    assert.equal(Object.hasOwn(spec.components.schemas.IbanVerificationRequest.properties, field), true, `OpenAPI omitted request field ${field}`);
  }
  for (const field of responseFields) assert.equal(html.includes(field), true, `IBAN page omitted response field ${field}`);
  assert.equal(spec.components.schemas.IbanVerificationRequest.required.includes('requestCategory'), true);
  assert.deepEqual(spec.components.schemas.IbanVerificationRequest.properties.requestCategory.enum, ['business']);
  assert.equal(html.includes('id="request-category" type="text" value="business" required'), true);
  assert.equal(script.includes("requestCategory: 'business'"), true);
  assert.equal(Object.hasOwn(spec.paths, '/service/iban_verification'), true);
  for (const publicAsset of [html, script, specText]) {
    assert.equal(publicAsset.toLowerCase().includes('truthscreen'), false);
    assert.equal(publicAsset.includes('www.truthscreen.com'), false);
  }
});
