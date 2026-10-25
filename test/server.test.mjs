import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');

const apiKey = 'ai7_test_key';
const upstreamToken = 'upstream_test_token';
process.env.AI7_API_KEY_HASHES = createHash('sha256').update(apiKey).digest('hex');
process.env.UAE_TLV_UPSTREAM_TOKEN = upstreamToken;

let upstream;
let app;
let appUrl;

const completeSuccess = {
  status: 'Success',
  client_id: '123e4567-e89b-12d3-a456-426614174000',
  seconds: 1.234,
  uae_tl_verification: {
    uae_licence_number: 'FULL-123',
    licence_registration_name: 'Example Trading LLC',
    licence_registration_name_arabic: 'شركة تجريبية',
    emirate_name: 'Dubai',
    emirate_name_arabic: 'دبي',
    governing_body_name: 'Dubai Department of Economy and Tourism',
    legal_type_from_entity: 'Limited Liability Company',
    registration_date: '2020-01-01',
    expiration_date: '2027-01-01',
    licence_registration_address: 'Dubai, UAE',
    licence_registration_address_arabic: 'دبي، الإمارات العربية المتحدة',
    license_status: 'Active',
    moec_status: 'Active',
    risk_scores: { trade_license_number: null }
  }
};

before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers.authorization, `Bearer ${upstreamToken}`);
    const contentType = req.headers['content-type'];
    const rawBody = Buffer.concat(chunks);

    if (contentType.startsWith('multipart/form-data; boundary=')) {
      const input = rawBody.toString('utf8');
      for (const expected of ['name="company_name"', 'Example Trading LLC', 'name="emirate"', 'dubai', 'name="authorising_body"', 'dubai_department_of_economy_and_tourism', 'name="license_document"; filename="licence.txt"', 'document-binary-content']) {
        assert.equal(input.includes(expected), true, `multipart body omitted ${expected}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(completeSuccess));
    }

    assert.equal(contentType, 'application/json');
    const input = JSON.parse(rawBody.toString('utf8'));
    if (input.license_number === 'FULL-123') {
      assert.deepEqual(input, {
        license_number: 'FULL-123',
        licence_number: 'ALT-123',
        company_name: 'Example Trading LLC',
        license_document: 'data:application/pdf;base64,VEVTVA==',
        emirate: 'dubai',
        authorising_body: 'dubai_department_of_economy_and_tourism'
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(completeSuccess));
    }
    if (input.license_number === 'SUCCESS-123') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'Success', client_id: '123e4567-e89b-12d3-a456-426614174000', seconds: 1.234, trade_licence_verification_api: { uae_licence_number: input.license_number } }));
    }
    res.writeHead(422, { 'content-type': 'application/json', 'x-provider-name': 'must-not-leak' });
    res.end(JSON.stringify({ status: 'Document identification failed', error: { file: input.license_number, title: 'Fields not found', message: 'Not recognised.' } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  process.env.UAE_TLV_UPSTREAM_URL = `http://127.0.0.1:${upstream.address().port}/service/uae_tlv`;

  app = createAppServer();
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${app.address().port}`;
});

test('relays a successful response without changing its shape', async () => {
  const response = await fetch(`${appUrl}/service/uae_tlv`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ license_number: 'SUCCESS-123' })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'Success',
    client_id: '123e4567-e89b-12d3-a456-426614174000',
    seconds: 1.234,
    trade_licence_verification_api: { uae_licence_number: 'SUCCESS-123' }
  });
});

test('relays every documented JSON input and complete output without changing names or values', async () => {
  const response = await fetch(`${appUrl}/service/uae_tlv`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      license_number: 'FULL-123',
      licence_number: 'ALT-123',
      company_name: 'Example Trading LLC',
      license_document: 'data:application/pdf;base64,VEVTVA==',
      emirate: 'dubai',
      authorising_body: 'dubai_department_of_economy_and_tourism'
    })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), completeSuccess);
});

test('relays multipart text fields and the original binary document', async () => {
  const body = new FormData();
  body.append('company_name', 'Example Trading LLC');
  body.append('emirate', 'dubai');
  body.append('authorising_body', 'dubai_department_of_economy_and_tourism');
  body.append('license_document', new Blob(['document-binary-content'], { type: 'text/plain' }), 'licence.txt');
  const response = await fetch(`${appUrl}/service/uae_tlv`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), completeSuccess);
});

after(async () => {
  await new Promise((resolve) => app.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
});

test('rejects missing client credentials with the documented 401 shape', async () => {
  const response = await fetch(`${appUrl}/service/uae_tlv`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ license_number: '123' })
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { status: 'Error', error: 'API key is missing or incorrect.' });
});

test('relays the request, status and JSON body while stripping provider headers', async () => {
  const response = await fetch(`${appUrl}/service/uae_tlv`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ license_number: 'ABC-123' })
  });
  assert.equal(response.status, 422);
  assert.equal(response.headers.get('x-provider-name'), null);
  assert.deepEqual(await response.json(), {
    status: 'Document identification failed',
    error: { file: 'ABC-123', title: 'Fields not found', message: 'Not recognised.' }
  });
});

test('serves provider-neutral API documentation', async () => {
  const response = await fetch(`${appUrl}/openapi.json`);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(text.includes('kycdd'), false);
  assert.equal(text.includes('api.ai7uae.com'), true);
  assert.equal(text.includes('/service/uae_tlv'), true);
});

test('serves a complete live tester and response-field reference', async () => {
  const html = await (await fetch(`${appUrl}/`)).text();
  const spec = await (await fetch(`${appUrl}/openapi.json`)).json();
  const inputs = spec.components.schemas.BaseRequest.properties;
  const idByInput = {
    license_number: 'license-number',
    licence_number: 'licence-number',
    company_name: 'company-name',
    license_document: 'license-document',
    emirate: 'emirate',
    authorising_body: 'authorising-body'
  };
  for (const [name, input] of Object.entries(idByInput)) {
    assert.equal(html.includes(`id="${input}"`), true, `tester omitted ${input}`);
    assert.equal(Object.hasOwn(inputs, name), true, `OpenAPI omitted ${name}`);
  }
  const outputs = spec.components.schemas.VerificationResult.properties;
  for (const output of Object.keys(outputs)) {
    assert.equal(html.includes(output), true, `response reference omitted ${output}`);
  }
  assert.equal(html.includes('uae_tl_verification'), true);
  assert.equal(html.includes('trade_licence_verification_api'), true);

  const script = await (await fetch(`${appUrl}/api.js`)).text();
  for (const value of inputs.emirate.enum) assert.equal(html.includes(`value="${value}"`), true, `tester omitted emirate ${value}`);
  for (const value of inputs.authorising_body.enum) assert.equal(script.includes(`'${value}'`), true, `tester omitted authority ${value}`);
  assert.equal(script.includes("format === 'multipart/form-data'"), true);
  assert.equal(script.includes('kycdd'), false);
});
