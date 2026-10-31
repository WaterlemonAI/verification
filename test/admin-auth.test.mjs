import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DOCUMENT_OCR_WORKER_IMAGE = 'registry.example/ocr@sha256:test';
const setupKey = 'ai7_admin_setup_test_key';
process.env.AI7_ADMIN_KEY_HASHES = createHash('sha256').update(setupKey).digest('hex');

const { createAppServer } = await import('../server.mjs');
const { EnvironmentStore } = await import('../lib/api-store.mjs');

const store = new EnvironmentStore();
const sentCodes = [];
const mailer = { configured: true, sendLoginCode: async (message) => { sentCodes.push(message); } };
let app;
let appUrl;
let cookie = '';
let csrf = '';
let paddleReady = false;
let capabilityRecent = true;
let capabilityImage = process.env.DOCUMENT_OCR_WORKER_IMAGE;

before(async () => {
  app = createAppServer({ store, mailer, startWorker: false,
    documentOcrStore: { getWorkerCapability: async () => ({ azure: true, paddle: paddleReady,
      recent: capabilityRecent, imageDigest: capabilityImage, checkedAt: new Date().toISOString() }) } });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${app.address().port}`;
});

after(async () => new Promise((resolve) => app.close(resolve)));

test('admin account reports first-run setup and rejects an invalid setup key', async () => {
  const status = await fetch(`${appUrl}/admin/api/auth/status`);
  assert.deepEqual(await status.json(), { configured: false });
  const invalid = await fetch(`${appUrl}/admin/api/auth/setup`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'VeryStrong!123' })
  });
  assert.equal(invalid.status, 401);
});

test('one-time setup stores only a salted password record and requires a new sign-in', async () => {
  const response = await fetch(`${appUrl}/admin/api/auth/setup`, {
    method: 'POST',
    headers: { authorization: `Bearer ${setupKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'Admin@Example.com', password: 'VeryStrong!123' })
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(body.account.email, 'admin@example.com');
  assert.equal((await fetch(`${appUrl}/admin/api/auth/session`)).status, 401);
  assert.equal(store.adminAccount.password_hash.includes('VeryStrong!123'), false);
  assert.equal(store.adminAccount.password_algorithm, 'scrypt-v1');
  assert.equal(Object.hasOwn(body.account, 'password_hash'), false);
});

test('legacy admin key no longer authorizes console operations after setup', async () => {
  const response = await fetch(`${appUrl}/admin/api/integrations`, { headers: { authorization: `Bearer ${setupKey}` } });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { status: 'Error', error: 'Sign in to continue.' });
});

test('email login requires a one-use code before issuing a session', async () => {
  const invalid = await fetch(`${appUrl}/admin/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'WrongPassword!1' })
  });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).error, 'Email or password is incorrect.');

  const response = await fetch(`${appUrl}/admin/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'VeryStrong!123' })
  });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('set-cookie'), null);
  const challenge = (await response.json()).challenge_id;
  assert.equal(sentCodes.at(-1).to, 'admin@example.com');
  assert.equal((await fetch(`${appUrl}/admin/api/auth/session`)).status, 401);
  const wrongCode = await fetch(`${appUrl}/admin/api/auth/verify-code`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com',
      challenge_id: challenge, code: sentCodes.at(-1).code === '00000000' ? '00000001' : '00000000' }) });
  assert.equal(wrongCode.status, 401);
  const verified = await fetch(`${appUrl}/admin/api/auth/verify-code`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', challenge_id: challenge, code: sentCodes.at(-1).code }) });
  assert.equal(verified.status, 200);
  const body = await verified.json();
  cookie = verified.headers.get('set-cookie').split(';')[0];
  csrf = body.csrf_token;
  assert.equal(cookie.startsWith('ai7_admin_session='), true);
  assert.equal(verified.headers.get('set-cookie').includes('HttpOnly'), true);
  assert.equal((await fetch(`${appUrl}/admin/api/auth/verify-code`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', challenge_id: challenge, code: sentCodes.at(-1).code }) })).status, 401);
  const listing = await fetch(`${appUrl}/admin/api/integrations`, { headers: { cookie } });
  assert.equal(listing.status, 200);
});

test('state-changing admin operations require the session CSRF token', async () => {
  const withoutCsrf = await fetch(`${appUrl}/admin/api/clients`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Secure Client' })
  });
  assert.equal(withoutCsrf.status, 403);
  const created = await fetch(`${appUrl}/admin/api/clients`, {
    method: 'POST', headers: { cookie, 'x-ai7-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Secure Client' })
  });
  assert.equal(created.status, 201);
});

test('only a signed-in administrator can select a verified OCR engine', async () => {
  const path = `${appUrl}/admin/api/document-ocr/engines/cheque-ocr`;
  const put = (headers, engine) => fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ engine }) });
  assert.equal((await put({}, 'paddle')).status, 401);
  assert.equal((await put({ cookie }, 'paddle')).status, 403);
  assert.equal((await put({ cookie, 'x-ai7-csrf': csrf }, 'paddle')).status, 409);
  assert.equal(await store.getDocumentOcrEngine('cheque-ocr'), 'ollama');
  paddleReady = true;
  capabilityRecent = false;
  assert.equal((await put({ cookie, 'x-ai7-csrf': csrf }, 'paddle')).status, 409);
  capabilityRecent = true;
  capabilityImage = 'registry.example/ocr@sha256:other';
  assert.equal((await put({ cookie, 'x-ai7-csrf': csrf }, 'paddle')).status, 409);
  capabilityImage = process.env.DOCUMENT_OCR_WORKER_IMAGE;
  const selected = await put({ cookie, 'x-ai7-csrf': csrf }, 'paddle');
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).extractionEngine, 'paddle');
  assert.equal(await store.getDocumentOcrEngine('cheque-ocr'), 'paddle');
  assert.equal(store.documentOcrEngineAudit.at(-1).actor, 'admin@example.com');
  const adminCatalog = await fetch(`${appUrl}/admin/api/integrations`, { headers: { cookie } });
  assert.equal((await adminCatalog.json()).integrations.find((item) => item.id === 'cheque-ocr').extractionEngine, 'paddle');
  const publicCatalog = await store.listIntegrations({ publicOnly: true });
  assert.equal(Object.hasOwn(publicCatalog.find((item) => item.id === 'cheque-ocr'), 'extractionEngine'), false);
  assert.equal((await put({ cookie, 'x-ai7-csrf': csrf }, 'azure')).status, 200);
});

test('Ejari admin setup requires the signed session and never returns provider keys', async (t) => {
  const previous = process.env.EJARI_PLATFORM_ENABLED;
  process.env.EJARI_PLATFORM_ENABLED = '1';
  t.after(() => { if (previous === undefined) delete process.env.EJARI_PLATFORM_ENABLED;
    else process.env.EJARI_PLATFORM_ENABLED = previous; });
  const input = { enabled: true, ocr_model: 'gpt-6-luna', ocr_detail: 'high',
    openai_key: 'synthetic-ocr-secret', capsolver_key: 'synthetic-captcha-secret' };
  const url = `${appUrl}/admin/api/ejari/config`;
  assert.equal((await fetch(url, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(input) })).status, 403);
  const saved = await fetch(url, { method: 'PUT', headers: { cookie, 'x-ai7-csrf': csrf, 'content-type': 'application/json' },
    body: JSON.stringify(input) });
  assert.equal(saved.status, 200);
  const response = await saved.json();
  assert.equal(response.config.enabled, true);
  assert.equal(response.config.openaiKeyConfigured, true);
  assert.equal(response.config.capsolverKeyConfigured, true);
  assert.equal(JSON.stringify(response).includes('synthetic-ocr-secret'), false);
  assert.equal(JSON.stringify(await (await fetch(url, { headers: { cookie } })).json()).includes('synthetic-captcha-secret'), false);
});

test('logout clears the browser session cookie', async () => {
  const response = await fetch(`${appUrl}/admin/api/auth/logout`, { method: 'POST', headers: { cookie, 'x-ai7-csrf': csrf } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie').includes('Max-Age=0'), true);
});

test('email delivery failure issues no session and allows a safe retry', async () => {
  const send = mailer.sendLoginCode;
  mailer.sendLoginCode = async () => { throw new Error('synthetic_mail_failure'); };
  try {
    const failed = await fetch(`${appUrl}/admin/api/auth/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'VeryStrong!123' }) });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('set-cookie'), null);
  } finally { mailer.sendLoginCode = send; }
  const retry = await fetch(`${appUrl}/admin/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'VeryStrong!123' }) });
  assert.equal(retry.status, 202);
  assert.equal(retry.headers.get('set-cookie'), null);
});
