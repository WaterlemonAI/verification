import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { createPlatformMailer } from '../lib/platform-mail.mjs';
import { createPasswordResetToken, parsePasswordResetToken } from '../lib/password-reset.mjs';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');

function post(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('GoDaddy SMTP transport uses TLS, fixed sender and reply address', async () => {
  let options;
  let message;
  const mailer = createPlatformMailer({ password: 'test-only', transportFactory: (configuration) => {
    options = configuration;
    return { sendMail: async (input) => { message = input; } };
  } });
  await mailer.sendTest({ to: 'operator@example.com' });
  assert.equal(options.host, 'smtpout.secureserver.net');
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(message.from, 'KYCProbe <notify@kycprobe.com>');
  assert.equal(message.replyTo, 'notify@ai7lab.net');
  assert.equal(message.to, 'operator@example.com');
});

test('reset tokens are scoped, expire, and fail after a password version change', () => {
  const account = { email: 'user@example.com', version: 1 };
  const token = createPasswordResetToken({ kind: 'portal', account, signingKey: 'test-key', now: 1000 });
  assert.equal(parsePasswordResetToken(token, { kind: 'admin', signingKey: 'test-key', now: 1000 }), null);
  assert.equal(parsePasswordResetToken(token, { kind: 'portal', signingKey: 'test-key', now: 1000 })?.version, 1);
  assert.equal(parsePasswordResetToken(token, { kind: 'portal', signingKey: 'test-key', now: 31 * 60 * 1000 }), null);
  assert.equal(parsePasswordResetToken(`${token}x`, { kind: 'portal', signingKey: 'test-key', now: 1000 }), null);
});

test('portal and admin recovery email resets passwords without account enumeration; credential email is optional', async (t) => {
  const key = 'setup-key-for-mail-test';
  process.env.AI7_ADMIN_KEY_HASHES = createHash('sha256').update(key).digest('hex');
  const messages = [];
  const mailer = {
    configured: true,
    sendPasswordReset: async (value) => { messages.push({ type: 'reset', ...value }); },
    sendCredential: async (value) => { messages.push({ type: 'credential', ...value }); },
    sendSecurityAlert: async (value) => { messages.push({ type: 'alert', ...value }); }
  };
  const store = new EnvironmentStore();
  const customer = await store.createClient('Test Customer');
  const server = createAppServer({ store, mailer, startWorker: false, deepResearchQueue: null, formsQueue: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const signup = await post(base, '/portal/api/auth/signup', { api_key: customer.apiKey, email: 'user@example.com', password: 'OldPortalPass!123' });
  assert.equal(signup.status, 201);
  const oldPortalCookie = signup.headers.get('set-cookie').split(';')[0];
  const unknown = await post(base, '/portal/api/auth/forgot-password', { email: 'unknown@example.com' });
  const known = await post(base, '/portal/api/auth/forgot-password', { email: 'user@example.com' });
  assert.equal(unknown.status, 202);
  assert.deepEqual(await known.json(), await unknown.json());
  assert.equal(messages.filter(item => item.type === 'reset').length, 1);
  assert.equal(messages[0].to, 'user@example.com');
  const portalToken = new URL(messages[0].url).searchParams.get('reset');
  assert.match(messages[0].url, /^https:\/\/app\.kycprobe\.com\/login\?reset=/);
  const portalReset = await post(base, '/portal/api/auth/reset-password', { token: portalToken, password: 'NewPortalPass!123' });
  assert.equal(portalReset.status, 200);
  assert.equal((await fetch(`${base}/portal/api/auth/session`, { headers: { cookie: oldPortalCookie } })).status, 401);
  assert.equal((await post(base, '/portal/api/auth/reset-password', { token: portalToken, password: 'AnotherPass!123' })).status, 400);
  assert.equal((await post(base, '/portal/api/auth/login', { email: 'user@example.com', password: 'NewPortalPass!123' })).status, 200);

  const setup = await post(base, '/admin/api/auth/setup', { email: 'admin@example.com', password: 'OldAdminPass!123' }, { authorization: `Bearer ${key}` });
  assert.equal(setup.status, 201);
  const adminCookie = setup.headers.get('set-cookie').split(';')[0];
  const csrf = (await setup.json()).csrf_token;
  const adminForgot = await post(base, '/admin/api/auth/forgot-password', { email: 'admin@example.com' });
  assert.equal(adminForgot.status, 202);
  const adminLink = messages.findLast(item => item.type === 'reset').url;
  assert.match(adminLink, /^https:\/\/app\.kycprobe\.com\/admin\?reset=/);
  const adminToken = new URL(adminLink).searchParams.get('reset');
  assert.equal((await post(base, '/admin/api/auth/reset-password', { token: adminToken, password: 'NewAdminPass!123' })).status, 200);
  assert.equal((await fetch(`${base}/admin/api/auth/session`, { headers: { cookie: adminCookie } })).status, 401);
  const login = await post(base, '/admin/api/auth/login', { email: 'admin@example.com', password: 'NewAdminPass!123' });
  assert.equal(login.status, 200);
  const activeCookie = login.headers.get('set-cookie').split(';')[0];
  const activeCsrf = (await login.json()).csrf_token;
  const issued = await post(base, '/admin/api/clients', { name: 'New Workspace', recipient_email: 'customer@example.com' }, { cookie: activeCookie, 'x-ai7-csrf': activeCsrf });
  assert.equal(issued.status, 201);
  const issuedBody = await issued.json();
  assert.equal(issuedBody.delivery, 'sent');
  assert.equal(messages.find(item => item.type === 'credential')?.apiKey, issuedBody.apiKey);
  assert.equal(messages.find(item => item.type === 'credential')?.to, 'customer@example.com');
  const invalidRecipient = await post(base, '/admin/api/clients', { name: 'Invalid Workspace', recipient_email: 'bad-address' }, { cookie: activeCookie, 'x-ai7-csrf': activeCsrf });
  assert.equal(invalidRecipient.status, 400);
  const multipleRecipients = await post(base, '/admin/api/clients', { name: 'Invalid Workspace', recipient_email: 'one@example.com,two@example.com' }, { cookie: activeCookie, 'x-ai7-csrf': activeCsrf });
  assert.equal(multipleRecipients.status, 400);
  assert.equal(messages.filter(item => item.type === 'alert').length, 2);
  assert.ok(csrf);
});
