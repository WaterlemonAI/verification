import assert from 'node:assert/strict';
import test from 'node:test';
import { EnvironmentStore } from '../lib/api-store.mjs';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');

function sessionCookie(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

test('portal signup verifies an AI7 key and creates an email/password session', async (t) => {
  const store = new EnvironmentStore();
  const createdClient = await store.createClient('Regulated Institution');
  const server = createAppServer({ store, startWorker: false, deepResearchQueue: null, formsQueue: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const protectedPage = await fetch(`${baseUrl}/adverse-media`, {
    redirect: 'manual', headers: { accept: 'text/html' }
  });
  assert.equal(protectedPage.status, 302);
  assert.equal(protectedPage.headers.get('location'), '/login?next=%2Fadverse-media');

  const publicForm = await fetch(`${baseUrl}/forms/public-onboarding`, { headers: { accept: 'text/html' } });
  assert.equal(publicForm.status, 200);
  assert.match(await publicForm.text(), /LIVE FORM/);

  const invalid = await fetch(`${baseUrl}/portal/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: 'invalid', email: 'user@example.com', password: 'PortalPass!234' })
  });
  assert.equal(invalid.status, 401);

  const signup = await fetch(`${baseUrl}/portal/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: createdClient.apiKey, email: 'User@Example.com', password: 'PortalPass!234' })
  });
  assert.equal(signup.status, 201);
  const signupBody = await signup.json();
  assert.equal(signupBody.account.email, 'user@example.com');
  assert.equal(signupBody.account.client_id, createdClient.client.id);
  assert.equal(signupBody.account.client_name, 'Regulated Institution');
  assert.ok(signupBody.csrf_token);
  const cookie = sessionCookie(signup);
  assert.match(cookie, /^ai7_portal_session=/);

  const stored = await store.getPortalUser('user@example.com');
  assert.equal(stored.client_id, createdClient.client.id);
  assert.notEqual(stored.password_hash, 'PortalPass!234');
  assert.equal(JSON.stringify(stored).includes(createdClient.apiKey), false);

  const duplicate = await fetch(`${baseUrl}/portal/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: createdClient.apiKey, email: 'user@example.com', password: 'AnotherPass!234' })
  });
  assert.equal(duplicate.status, 409);

  const session = await fetch(`${baseUrl}/portal/api/auth/session`, { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).account.email, 'user@example.com');

  const page = await fetch(`${baseUrl}/adverse-media`, { headers: { accept: 'text/html', cookie } });
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /portal-auth\.js/);
  assert.match(pageHtml, /kycprobe-logo-white\.png/);

  const loginPage = await fetch(`${baseUrl}/login`);
  const loginHtml = await loginPage.text();
  assert.match(loginHtml, /kycprobe-logo-white\.png/);
  assert.match(loginHtml, /kycprobe-logo-dark\.png/);
  const logo = await fetch(`${baseUrl}/assets/kycprobe-logo-white.png`);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.ok((await logo.arrayBuffer()).byteLength > 0);

  const badLogin = await fetch(`${baseUrl}/portal/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com', password: 'wrong' })
  });
  assert.equal(badLogin.status, 401);

  const login = await fetch(`${baseUrl}/portal/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com', password: 'PortalPass!234' })
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  const loginCookie = sessionCookie(login);

  const forbiddenLogout = await fetch(`${baseUrl}/portal/api/auth/logout`, { method: 'POST', headers: { cookie: loginCookie } });
  assert.equal(forbiddenLogout.status, 403);
  const logout = await fetch(`${baseUrl}/portal/api/auth/logout`, {
    method: 'POST', headers: { cookie: loginCookie, 'x-ai7-csrf': loginBody.csrf_token }
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});
