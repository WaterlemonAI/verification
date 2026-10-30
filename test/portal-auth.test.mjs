import assert from 'node:assert/strict';
import test from 'node:test';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { createInvitation } from '../lib/customer-invitation.mjs';
import { MemoryCustomerUsageStore, validateUsagePolicy } from '../lib/customer-usage.mjs';
import { MemoryCaseManagerStore } from '../lib/case-manager-store.mjs';
import { recoverCaseRetirements } from '../lib/case-manager-retirement.mjs';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');

function sessionCookie(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

test('one-time customer invitation creates a portal account and initial workspace key', async (t) => {
  const store = new EnvironmentStore();
  const usageStore = new MemoryCustomerUsageStore();
  const caseStore = new MemoryCaseManagerStore();
  const codes = [];
  const mailer = { configured: true, sendLoginCode: async (value) => { codes.push(value); } };
  const customerId = 'abcdef0123456789';
  const invitation = createInvitation(customerId);
  await store.setCustomer({ id: customerId, name: 'Regulated Institution', adminEmail: 'user@example.com', status: 'pending', usagePolicyVersion: 1,
    invitationHash: invitation.tokenHash, invitationExpiresAt: invitation.expiresAt });
  const server = createAppServer({ store, usageStore, caseStore, mailer,
    startWorker: false, deepResearchQueue: null, formsQueue: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const protectedPage = await fetch(`${baseUrl}/adverse-media`, {
    redirect: 'manual', headers: { accept: 'text/html' }
  });
  assert.equal(protectedPage.status, 302);
  assert.equal(protectedPage.headers.get('location'), '/login?next=%2Fadverse-media');

  const protectedForm = await fetch(`${baseUrl}/forms/public-onboarding`, { redirect: 'manual', headers: { accept: 'text/html' } });
  assert.equal(protectedForm.status, 302);
  assert.match(protectedForm.headers.get('location'), /^\/login\?next=/);

  const invalid = await fetch(`${baseUrl}/portal/api/invitations/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'invalid', password: 'PortalPass!234' })
  });
  assert.equal(invalid.status, 400);

  const signup = await fetch(`${baseUrl}/portal/api/invitations/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: invitation.token, password: 'PortalPass!234' })
  });
  assert.equal(signup.status, 201);
  const signupBody = await signup.json();
  assert.equal(signupBody.account.email, 'user@example.com');
  assert.equal(signupBody.account.client_id, customerId);
  assert.equal(signupBody.account.client_name, 'Regulated Institution');
  assert.equal(signup.headers.get('set-cookie'), null);
  assert.equal(signupBody.api_key, undefined);

  const firstLogin = await fetch(`${baseUrl}/portal/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com', password: 'PortalPass!234' }) });
  assert.equal(firstLogin.status, 202);
  const firstChallenge = (await firstLogin.json()).challenge_id;
  assert.equal((await fetch(`${baseUrl}/portal/api/auth/session`)).status, 401);
  const firstVerify = await fetch(`${baseUrl}/portal/api/auth/verify-code`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com',
      challenge_id: firstChallenge, code: codes.at(-1).code }) });
  assert.equal(firstVerify.status, 200);
  Object.assign(signupBody, await firstVerify.json());
  assert.ok(signupBody.csrf_token);
  const cookie = sessionCookie(firstVerify);
  assert.match(cookie, /^ai7_portal_session=/);
  assert.equal(firstVerify.headers.get('set-cookie').toLowerCase().includes('domain='), false);

  const stored = await store.getPortalUser('user@example.com');
  assert.equal(stored.client_id, customerId);
  assert.notEqual(stored.password_hash, 'PortalPass!234');
  assert.equal(JSON.stringify(stored).includes(signupBody.api_key), false);
  assert.equal(await store.isClientKey(signupBody.api_key), true);

  const duplicate = await fetch(`${baseUrl}/portal/api/invitations/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: invitation.token, password: 'AnotherPass!234' })
  });
  assert.equal(duplicate.status, 400);

  const legacySignup = await fetch(`${baseUrl}/portal/api/auth/signup`, { method: 'POST' });
  assert.equal(legacySignup.status, 410);

  const session = await fetch(`${baseUrl}/portal/api/auth/session`, { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).account.email, 'user@example.com');
  const entitlements = await (await fetch(`${baseUrl}/portal/api/entitlements`, { headers: { cookie } })).json();
  assert.equal(entitlements.allowed_modules.includes('bank-statement-analysis'), false);
  assert.equal(entitlements.available_modules.includes('bank-statement-analysis'), false);
  const portalHealth = await fetch(`${baseUrl}/portal/api/health`, { headers: { cookie } });
  assert.equal(portalHealth.status, 200);
  assert.deepEqual((await portalHealth.json()).checks, []);
  const keyHealth = await fetch(`${baseUrl}/service/health`, { headers: { authorization: `Bearer ${signupBody.api_key}` } });
  assert.equal(keyHealth.status, 200);
  assert.deepEqual((await keyHealth.json()).checks, []);
  await usageStore.configure(customerId, validateUsagePolicy({ mode: 'prepaid', currency: 'USD',
    allowed_modules: ['adverse-media'], rates: {} }, new Set(['adverse-media'])), true);
  const allowedHealth = await fetch(`${baseUrl}/portal/api/health`, { headers: { cookie } });
  assert.deepEqual((await allowedHealth.json()).checks.map((check) => check.id), ['adverse-media']);
  const allowedKeyHealth = await fetch(`${baseUrl}/service/health`, { headers: { authorization: `Bearer ${signupBody.api_key}` } });
  assert.deepEqual((await allowedKeyHealth.json()).checks.map((check) => check.id), ['adverse-media']);

  const page = await fetch(`${baseUrl}/adverse-media`, { headers: { accept: 'text/html', cookie } });
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /portal-auth\.js/);
  assert.match(pageHtml, /kycprobe-logo-white\.png/);
  const accountPage = await fetch(`${baseUrl}/account`, { headers: { accept: 'text/html', cookie } });
  assert.equal(accountPage.status, 200);
  assert.match(await accountPage.text(), /Your API keys/);

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
  assert.equal(login.status, 202);
  const challenge = (await login.json()).challenge_id;
  assert.equal(login.headers.get('set-cookie'), null);
  const verified = await fetch(`${baseUrl}/portal/api/auth/verify-code`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com',
      challenge_id: challenge, code: codes.at(-1).code }) });
  assert.equal(verified.status, 200);
  const loginBody = await verified.json();
  assert.equal(loginBody.api_key, undefined);
  const loginCookie = sessionCookie(verified);

  const caseSettingsUrl = `${baseUrl}/portal/api/case-manager/settings`;
  const defaultCaseSettings = await (await fetch(caseSettingsUrl, { headers: { cookie: loginCookie } })).json();
  assert.deepEqual(defaultCaseSettings, { available: false, policy: { version: 0, visible_from_version: 0, enabled: false, ttl_days: null } });
  const disabledUpdate = await fetch(caseSettingsUrl, { method: 'PUT', headers: {
    cookie: loginCookie, 'content-type': 'application/json', 'x-ai7-csrf': loginBody.csrf_token
  }, body: JSON.stringify({ version: 0, enabled: true, ttl_days: 30 }) });
  assert.equal(disabledUpdate.status, 503);
  process.env.CASE_MANAGER_ENABLED = 'true';
  t.after(() => { delete process.env.CASE_MANAGER_ENABLED; });
  const missingCaseCsrf = await fetch(caseSettingsUrl, { method: 'PUT', headers: { cookie: loginCookie,
    'content-type': 'application/json' }, body: JSON.stringify({ version: 0, enabled: true, ttl_days: 30 }) });
  assert.equal(missingCaseCsrf.status, 403);
  const invalidCaseTtl = await fetch(caseSettingsUrl, { method: 'PUT', headers: {
    cookie: loginCookie, 'content-type': 'application/json', 'x-ai7-csrf': loginBody.csrf_token
  }, body: JSON.stringify({ version: 0, enabled: true, ttl_days: 46 }) });
  assert.equal(invalidCaseTtl.status, 400);
  const prepareRetirement = caseStore.prepareRetirement.bind(caseStore);
  caseStore.prepareRetirement = async () => { throw new Error('synthetic_table_unavailable'); };
  const unavailableCaseSettings = await fetch(caseSettingsUrl, { method: 'PUT', headers: {
    cookie: loginCookie, 'content-type': 'application/json', 'x-ai7-csrf': loginBody.csrf_token
  }, body: JSON.stringify({ version: 0, enabled: true, ttl_days: 30 }) });
  assert.equal(unavailableCaseSettings.status, 503);
  assert.equal((await usageStore.casePolicy(customerId)).version, 0);
  caseStore.prepareRetirement = prepareRetirement;
  const savedCaseSettings = await fetch(caseSettingsUrl, { method: 'PUT', headers: {
    cookie: loginCookie, 'content-type': 'application/json', 'x-ai7-csrf': loginBody.csrf_token
  }, body: JSON.stringify({ version: 0, enabled: true, ttl_days: 30 }) });
  assert.equal(savedCaseSettings.status, 200);
  assert.deepEqual((await savedCaseSettings.json()).policy, { version: 1, visible_from_version: 1, enabled: true, ttl_days: 30 });
  const intent = await caseStore.createIntent({ workspaceId: customerId, serviceId: 'synthetic', transactionId: 'retirement-tx',
    acceptedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
  await caseStore.captureFinal(customerId, intent.id, { response: { synthetic: true },
    contentType: 'application/json', httpStatus: 200, outcome: 'unclassified' });
  caseStore.scheduleRetirement = async () => { throw new Error('synthetic_queue_unavailable'); };
  const disabledCaseSettings = await fetch(caseSettingsUrl, { method: 'PUT', headers: {
    cookie: loginCookie, 'content-type': 'application/json', 'x-ai7-csrf': loginBody.csrf_token
  }, body: JSON.stringify({ version: 1, enabled: false }) });
  assert.equal(disabledCaseSettings.status, 200);
  assert.equal((await disabledCaseSettings.json()).retirement_scheduled, false);
  assert.equal((await caseStore.getCase(customerId, intent.id, { activePolicyVersion: 2 })), null);
  assert.equal(caseStore.rows.has(intent.id), true);
  const retirement = await recoverCaseRetirements({ usageStore, caseStore });
  assert.equal(retirement.completed, 2);
  assert.equal(caseStore.rows.has(intent.id), false);
  assert.equal(caseStore.payloads.has(intent.id), false);
  const staleCaseSettings = await fetch(caseSettingsUrl, { method: 'PUT', headers: {
    cookie: loginCookie, 'content-type': 'application/json', 'x-ai7-csrf': loginBody.csrf_token
  }, body: JSON.stringify({ version: 0, enabled: false }) });
  assert.equal(staleCaseSettings.status, 409);
  delete process.env.CASE_MANAGER_ENABLED;

  const keyHeaders = { cookie: loginCookie, 'content-type': 'application/json', 'x-ai7-csrf': loginBody.csrf_token };
  const noCsrfKey = await fetch(`${baseUrl}/portal/api/keys`, { method: 'POST', headers: { cookie: loginCookie, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Denied' }) });
  assert.equal(noCsrfKey.status, 403);
  const newKeyResponse = await fetch(`${baseUrl}/portal/api/keys`, { method: 'POST',
    headers: { ...keyHeaders, 'idempotency-key': 'integration-key-request-0001' }, body: JSON.stringify({ label: 'Integration test' }) });
  assert.equal(newKeyResponse.status, 201);
  const newKey = await newKeyResponse.json();
  assert.equal(newKey.key.workspaceId, customerId);
  assert.equal(newKey.key.ownerEmail, 'user@example.com');
  assert.equal(await store.isClientKey(newKey.api_key), true);
  assert.equal(await store.isClientKey(signupBody.api_key), true);
  const rotatedResponse = await fetch(`${baseUrl}/portal/api/keys/${newKey.key.id}/rotate`, { method: 'POST', headers: keyHeaders });
  assert.equal(rotatedResponse.status, 200);
  const rotated = await rotatedResponse.json();
  assert.equal(await store.isClientKey(newKey.api_key), false);
  assert.equal(await store.isClientKey(rotated.api_key), true);
  assert.equal(await store.isClientKey(signupBody.api_key), true);
  const revokedResponse = await fetch(`${baseUrl}/portal/api/keys/${newKey.key.id}/revoke`, { method: 'POST', headers: keyHeaders });
  assert.equal(revokedResponse.status, 200);
  assert.equal(await store.isClientKey(rotated.api_key), false);
  assert.equal(await store.isClientKey(signupBody.api_key), true);

  const otherCustomerId = '0123456789abcdef';
  const otherKey = await store.createClient('Other Customer', { workspaceId: otherCustomerId, label: 'Separate workspace' });
  const crossWorkspace = await fetch(`${baseUrl}/portal/api/keys/${otherKey.client.id}/rotate`, { method: 'POST', headers: keyHeaders });
  assert.equal(crossWorkspace.status, 404);
  assert.equal(await store.isClientKey(otherKey.apiKey), true);

  for (let index = 0; index < 19; index++) {
    const response = await fetch(`${baseUrl}/portal/api/keys`, { method: 'POST',
      headers: { ...keyHeaders, 'idempotency-key': `limit-key-request-${String(index).padStart(4, '0')}` },
      body: JSON.stringify({ label: `Limit test ${index}` }) });
    assert.equal(response.status, 201);
  }
  const atLimit = await fetch(`${baseUrl}/portal/api/keys`, { method: 'POST',
    headers: { ...keyHeaders, 'idempotency-key': 'limit-key-request-overflow' }, body: JSON.stringify({ label: 'Should be denied' }) });
  assert.equal(atLimit.status, 409);
  assert.equal((await store.listClients()).filter((item) => item.workspaceId === customerId && item.status === 'active').length, 20);

  const forbiddenLogout = await fetch(`${baseUrl}/portal/api/auth/logout`, { method: 'POST', headers: { cookie: loginCookie } });
  assert.equal(forbiddenLogout.status, 403);
  const logout = await fetch(`${baseUrl}/portal/api/auth/logout`, {
    method: 'POST', headers: { cookie: loginCookie, 'x-ai7-csrf': loginBody.csrf_token }
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});
