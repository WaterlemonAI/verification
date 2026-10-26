import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
const setupKey = 'ai7_admin_setup_test_key';
process.env.AI7_ADMIN_KEY_HASHES = createHash('sha256').update(setupKey).digest('hex');

const { createAppServer } = await import('../server.mjs');
const { EnvironmentStore } = await import('../lib/api-store.mjs');

const store = new EnvironmentStore();
let app;
let appUrl;
let cookie = '';
let csrf = '';

before(async () => {
  app = createAppServer({ store, startWorker: false });
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

test('one-time setup stores only a salted password record and creates a signed session', async () => {
  const response = await fetch(`${appUrl}/admin/api/auth/setup`, {
    method: 'POST',
    headers: { authorization: `Bearer ${setupKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'Admin@Example.com', password: 'VeryStrong!123' })
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  cookie = response.headers.get('set-cookie').split(';')[0];
  csrf = body.csrf_token;
  assert.equal(body.account.email, 'admin@example.com');
  assert.equal(cookie.startsWith('ai7_admin_session='), true);
  assert.equal(response.headers.get('set-cookie').includes('HttpOnly'), true);
  assert.equal(response.headers.get('set-cookie').includes('SameSite=Strict'), true);
  assert.equal(store.adminAccount.password_hash.includes('VeryStrong!123'), false);
  assert.equal(store.adminAccount.password_algorithm, 'scrypt-v1');
  assert.equal(Object.hasOwn(body.account, 'password_hash'), false);
});

test('legacy admin key no longer authorizes console operations after setup', async () => {
  const response = await fetch(`${appUrl}/admin/api/integrations`, { headers: { authorization: `Bearer ${setupKey}` } });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { status: 'Error', error: 'Sign in to continue.' });
});

test('email login rejects the wrong password and returns a usable session for the right one', async () => {
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
  assert.equal(response.status, 200);
  const body = await response.json();
  cookie = response.headers.get('set-cookie').split(';')[0];
  csrf = body.csrf_token;
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

test('logout clears the browser session cookie', async () => {
  const response = await fetch(`${appUrl}/admin/api/auth/logout`, { method: 'POST', headers: { cookie, 'x-ai7-csrf': csrf } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie').includes('Max-Age=0'), true);
});
