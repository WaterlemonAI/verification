import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';

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
let receivedEntitySearch;
let relayRequests = [];

const completeEntitySearchResponse = {
  apc_success: true,
  profiles_success: true,
  message: 'Search Successful',
  response_id: '4e9aa7cb-f42d-4f87-828f-ac1ea6d34c1e',
  data: {
    profiles: [{
      uid: 'PROFILE-1',
      category: ['PEP', 'WLT', 'SAN'],
      personal_details: {
        uid: 'PROFILE-1', type: 'Individual', gender: 'Male', deceased: '', nationalities: ['AE'], citizenships: ['AE'],
        name: [{ first_name: 'Test', middle_name: '', last_name: 'Person' }],
        aliases: [{ alias_name: 'Test Alias', alias_type: 'AKA', alias_language: 'English', alias_script: 'Latin' }],
        date_of_birth: [{ date_of_birth_year: '1980', date_of_birth_month: '1', date_of_birth_date: '2' }],
        image_details: [{ image_url: 'https://example.test/image.jpg' }], physical_description: []
      },
      sanctions: { authority: [{ sanction_authority: 'Authority', sanctions_list_name: 'List' }] },
      watchlists: { additional_information: ['Information'], authority: [{ watchlist_list_id: '1', watchlist_list_name: 'List' }] },
      apc_info: [{ date_published_year: '2026', date_published_month: '10', date_published_date: '1', apc_summary: 'Summary', apc_news_link: 'https://example.test/news' }],
      unknown_future_field: { preserved: true }
    }],
    aml: { data: [{ name: 'Test Person', AmlCategory: 'AML', Score: 0.99 }] },
    russiabridge: [{ uid: 'RB-1', name: 'Event', type: 'Individual' }]
  }
};

before(async () => {
  app = createAppServer({
    store,
    fetchImpl: async (url, options) => {
      const requestUrl = new URL(url);
      if (requestUrl.hostname === 'screening.test') {
        receivedEntitySearch = { url: String(url), headers: options.headers, body: JSON.parse(options.body.toString('utf8')) };
        return new Response(JSON.stringify(completeEntitySearchResponse), { status: 200, headers: { 'content-type': 'application/json', 'x-supplier': 'hidden' } });
      }
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
  assert.equal(body.integrations.length, 3);
  assert.ok(body.integrations.some((item) => item.id === 'adverse-media-ai'));
  const companySearch = body.integrations.find((item) => item.id === 'company-search');
  assert.equal(companySearch.publicPath, '/service/company_search');
  assert.equal(companySearch.upstreamUrl, undefined);
  assert.equal(JSON.stringify(body).includes('supplier.test'), false);
  assert.equal(JSON.stringify(body).includes('master-secret'), false);

  const catalog = await (await fetch(`${appUrl}/catalog.json`)).text();
  assert.equal(catalog.includes('supplier.test'), false);
  assert.equal(catalog.includes('master-secret'), false);
  assert.equal(catalog.includes('x-master-key'), false);
  assert.equal(catalog.includes('/service/company_search'), true);
  assert.equal(catalog.includes('/internal/adverse-media-ai'), false);
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
    source: 'API', transID: 'CLIENT-001', docType: 999, requestCategory: 'business', country: 'AE',
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
  assert.deepEqual(relayRequests[0].body, { ...requestBody, docType: 610 });
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
  assert.equal(html.includes('id="trans-id"'), false);
  assert.equal(html.includes('id="doc-type"'), false);
  assert.equal(html.includes('id="country" required'), true);
  assert.equal(html.includes('id="request-category" required'), true);
  assert.equal(spec.components.schemas.IbanVerificationRequest.required.includes('docType'), false);
  assert.equal(spec.components.schemas.IbanVerificationRequest.properties.docType.const, 610);
  assert.equal(script.includes("globalThis.crypto.randomUUID()"), true);
  assert.equal(script.includes('docType: 610'), true);
  assert.equal(script.includes('AE AF AG'), true);
  const countryCodes = script.match(/const countryCodes = `([\s\S]*?)`\.trim/)[1].trim().split(/\s+/);
  assert.equal(countryCodes.length, 249);
  assert.equal(new Set(countryCodes).size, 249);
  for (const code of ['AE', 'GB', 'IN', 'PK', 'US', 'ZA']) assert.equal(countryCodes.includes(code), true);
  assert.equal(script.includes("requestCategory: 'business'"), true);
  assert.equal(Object.hasOwn(spec.paths, '/service/iban_verification'), true);
  for (const publicAsset of [html, script, specText]) {
    assert.equal(publicAsset.toLowerCase().includes('truthscreen'), false);
    assert.equal(publicAsset.includes('www.truthscreen.com'), false);
  }
});

test('comprehensive entity search preserves every request field and the exact response body', async () => {
  const configured = await fetch(`${appUrl}/admin/api/integrations/entity-search`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify({
      name: 'Comprehensive Entity Search',
      publicPath: '/service/entity_search',
      method: 'POST',
      upstreamUrl: 'http://screening.test/rzolut-one/v1/search',
      authType: 'header',
      authHeader: 'x-api-key',
      authPrefix: '',
      adapter: 'passthrough',
      acceptedContentTypes: ['application/json'],
      documentedStatuses: [200, 400, 401, 500],
      enabled: true
    })
  });
  assert.equal(configured.status, 200);
  assert.equal((await configured.json()).integration.masterAuthKeyConfigured, false);

  const credential = await fetch(`${appUrl}/admin/api/integrations/entity-search/credential`, {
    method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ credential: 'private-screening-key' })
  });
  assert.equal(credential.status, 200);

  const issued = await (await fetch(`${appUrl}/admin/api/clients`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ name: 'Entity Search Test' })
  })).json();
  const requestBody = {
    name: 'Test Person',
    type: 'Individual',
    alias: ['Test Alias'],
    country: 'AE',
    city: 'Dubai',
    state: 'Dubai',
    designation: 'Director',
    gender: 'Male',
    dob: '1980/01/02',
    identifier: [{ type: 'passport', value: 'P123' }],
    watchlist_list_ids: [1, 2],
    sanction_list_ids: [3, 4],
    search_type: ['pep', 'sanction', 'aml', 'watchlist', 'russiabridge', 'dualgoods', 'sanctionedgoods', 'er_apc'],
    fields_weightage: [
      { field: 'name', weightage: 0.7 }, { field: 'alias', weightage: 0.1 }, { field: 'country', weightage: 0.1 },
      { field: 'dob', weightage: 0.1 }, { field: 'address', weightage: 0 }, { field: 'gender', weightage: 0 },
      { field: 'identifier', weightage: 0 }
    ],
    fuzziness: 0.8,
    event_stage_score: 2,
    sentiment_confidence: 0.7,
    apc_duration: 365,
    apc_countries: 'global',
    apc_sort_by: 'relevance'
  };
  const response = await fetch(`${appUrl}/service/entity_search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody)
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), completeEntitySearchResponse);
  assert.equal(response.headers.get('x-supplier'), null);
  assert.equal(receivedEntitySearch.url, 'http://screening.test/rzolut-one/v1/search');
  assert.equal(receivedEntitySearch.headers['x-api-key'], 'private-screening-key');
  assert.equal(receivedEntitySearch.headers.authorization, undefined);
  assert.deepEqual(receivedEntitySearch.body, requestBody);

  const requestWithoutBlankRequiredKeys = {
    name: 'Test Person',
    type: 'Individual',
    search_type: ['pep'],
    fields_weightage: [{ field: 'name', weightage: 1 }],
    fuzziness: 0.8
  };
  const defaultedResponse = await fetch(`${appUrl}/service/entity_search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(requestWithoutBlankRequiredKeys)
  });
  assert.equal(defaultedResponse.status, 200);
  assert.deepEqual(receivedEntitySearch.body, {
    country: '',
    gender: '',
    dob: '',
    ...requestWithoutBlankRequiredKeys
  });

  const unauthorisedReport = await fetch(`${appUrl}/reports/entity-search.pdf`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
    body: JSON.stringify({ request: requestBody, response: completeEntitySearchResponse })
  });
  assert.equal(unauthorisedReport.status, 401);

  const reportResponse = await fetch(`${appUrl}/reports/entity-search.pdf`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      request: requestBody,
      response: completeEntitySearchResponse,
      httpStatus: 200,
      completedAt: '2026-10-25T18:45:46.000Z'
    })
  });
  assert.equal(reportResponse.status, 200);
  assert.equal(reportResponse.headers.get('content-type'), 'application/pdf');
  assert.match(reportResponse.headers.get('content-disposition'), /ai7-entity-search-test-person-\d{4}-\d{2}-\d{2}\.pdf/);
  assert.match(reportResponse.headers.get('x-ai7-report-id'), /^AI7-[A-F0-9]{16}$/);
  const reportBytes = new Uint8Array(await reportResponse.arrayBuffer());
  assert.equal(new TextDecoder().decode(reportBytes.slice(0, 5)), '%PDF-');
  const reportDocument = await PDFDocument.load(reportBytes);
  assert.ok(reportDocument.getPageCount() >= 3);
  assert.match(reportDocument.getTitle(), /AI7 UAE Entity Screening Audit/);
});

test('entity search docs expose every official response path and no supplier details', async () => {
  const html = await (await fetch(`${appUrl}/entity-search`)).text();
  const script = await (await fetch(`${appUrl}/entity-search.js`)).text();
  const fieldsScript = await (await fetch(`${appUrl}/entity-search-fields.js`)).text();
  const specText = await (await fetch(`${appUrl}/openapi.json`)).text();
  const spec = JSON.parse(specText);
  const requestFields = [
    'name', 'type', 'alias', 'country', 'city', 'state', 'designation', 'gender', 'dob', 'identifier',
    'watchlist_list_ids', 'sanction_list_ids', 'search_type', 'fields_weightage', 'fuzziness',
    'event_stage_score', 'sentiment_confidence', 'apc_duration', 'apc_countries', 'apc_sort_by'
  ];
  for (const field of requestFields) {
    assert.equal(html.includes(field), true, `entity-search page omitted request field ${field}`);
    assert.equal(Object.hasOwn(spec.components.schemas.EntitySearchRequest.properties, field), true, `OpenAPI omitted request field ${field}`);
  }
  for (const requiredKey of ['country', 'gender', 'dob']) {
    assert.equal(spec.components.schemas.EntitySearchRequest.required.includes(requiredKey), true, `OpenAPI did not mark ${requiredKey} as a required key`);
  }
  for (const value of ['pep', 'sanction', 'aml', 'watchlist', 'russiabridge', 'dualgoods', 'sanctionedgoods', 'apc', 'er_apc']) {
    assert.equal(html.includes(`value="${value}"`), true, `tester omitted search type ${value}`);
  }

  const serializedFields = fieldsScript.match(/= (\[[\s\S]*\]);\s*$/)?.[1];
  assert.ok(serializedFields, 'response field catalog was not parseable');
  const fields = JSON.parse(serializedFields);
  assert.equal(fields.length, 382);
  assert.equal(new Set(fields.map((field) => field.path)).size, 382);

  const schemaPaths = new Set();
  function collectPaths(schema, path = '') {
    if (!schema || typeof schema !== 'object') return;
    for (const [name, value] of Object.entries(schema.properties || {})) {
      const next = path ? `${path}.${name}` : name;
      schemaPaths.add(next);
      collectPaths(value, next);
    }
    if ((schema.type === 'array' || schema.type?.includes?.('array')) && schema.items) {
      const next = `${path}[]`;
      schemaPaths.add(next);
      collectPaths(schema.items, next);
    }
  }
  collectPaths(spec.components.schemas.EntitySearchResponse);
  for (const field of fields) assert.equal(schemaPaths.has(field.path), true, `OpenAPI omitted response path ${field.path}`);
  for (const path of [
    'data.profiles[].sanctions.authority[].sanctions_list_name',
    'data.profiles[].watchlists.authority[].watchlist_list_name',
    'data.profiles[].apc_info[].apc_summary',
    'data.apc.data[].framework[].risk_areas[].categories[].subcategories[].events[].keywords[].event_stages',
    'data.aml.data[].Total FineAmountUSD',
    'data.russiabridge[].percentage_of_shareholding'
  ]) assert.equal(fields.some((field) => field.path === path), true, `response catalog omitted ${path}`);

  assert.equal(script.includes("fetch('/service/entity_search'"), true);
  assert.equal(script.includes("new Set(['country', 'gender', 'dob'])"), true);
  assert.equal(script.includes("status: 'pending', request: body"), true);
  assert.equal(html.includes('id="response-label"'), true);
  assert.equal(html.includes('/entity-search.js?v=3'), true);
  assert.equal(html.includes('id="copy-response"'), true);
  assert.equal(html.includes('id="report-logo-url"'), true);
  assert.equal(html.includes('id="get-pdf"'), true);
  assert.equal(script.includes("fetch('/reports/entity-search.pdf'"), true);
  assert.equal(script.includes("copyText(responseJson.textContent"), true);
  assert.equal(Object.hasOwn(spec.paths, '/service/entity_search'), true);
  for (const publicAsset of [html, script, fieldsScript, specText]) {
    assert.equal(publicAsset.toLowerCase().includes('rzolut'), false);
    assert.equal(publicAsset.includes('api-datasets'), false);
  }
});
