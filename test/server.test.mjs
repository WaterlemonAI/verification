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

before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(req.headers.authorization, `Bearer ${upstreamToken}`);
    assert.equal(req.headers['content-type'], 'application/json');
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
