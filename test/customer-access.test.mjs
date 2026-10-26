import assert from 'node:assert/strict';
import test from 'node:test';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { createAdminAccount } from '../lib/admin-auth.mjs';
import { createInvitation, validInvitation } from '../lib/customer-invitation.mjs';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');

async function post(base, path, body = {}, headers = {}) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('invited customer manages multiple workspace keys, rotation and service health', async (t) => {
  const store = new EnvironmentStore();
  await store.setAdminAccount(createAdminAccount('operator@example.com', 'AdminPassword!123'));
  await store.setAdminSessionKey('test-admin-session-key');
  const sent = [];
  const mailer = { configured: true, sendInvitation: async (message) => sent.push(message) };
  const server = createAppServer({ store, mailer, startWorker: false, deepResearchQueue: null, formsQueue: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const adminLogin = await post(base, '/admin/api/auth/login', { email: 'operator@example.com', password: 'AdminPassword!123' });
  const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];
  const adminCsrf = (await adminLogin.json()).csrf_token;
  const adminHeaders = { cookie: adminCookie, 'x-ai7-csrf': adminCsrf };
  const invite = await post(base, '/admin/api/customers', { name: 'Bank A', admin_email: 'owner@banka.example' }, adminHeaders);
  assert.equal(invite.status, 201);
  const invited = await invite.json();
  assert.equal(invited.customer.status, 'pending');
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(sent).includes('ai7_live_'), false);
  const token = new URL(sent[0].url).hash.replace('#invite=', '');
  const preview = await post(base, '/portal/api/invitations/preview', { token });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).customer.admin_email, 'owner@banka.example');
  assert.equal((await post(base, '/portal/api/invitations/accept', { token, password: 'weak' })).status, 400);

  const accepted = await post(base, '/portal/api/invitations/accept', { token, password: 'CustomerPass!123' });
  assert.equal(accepted.status, 201);
  const setup = await accepted.json();
  assert.equal(setup.account.client_id, invited.customer.id);
  assert.equal(await store.isClientKey(setup.api_key), true);
  assert.equal((await post(base, '/portal/api/invitations/accept', { token, password: 'CustomerPass!123' })).status, 400);
  const portalCookie = accepted.headers.get('set-cookie').split(';')[0];
  const portalHeaders = { cookie: portalCookie, 'x-ai7-csrf': setup.csrf_token };
  const initialList = await fetch(`${base}/portal/api/keys`, { headers: { cookie: portalCookie } });
  assert.equal((await initialList.json()).keys.length, 1);
  assert.equal((await post(base, '/portal/api/keys', { label: 'Production' }, { cookie: portalCookie })).status, 403);
  const second = await post(base, '/portal/api/keys', { label: 'Production' }, portalHeaders);
  assert.equal(second.status, 201);
  const secondBody = await second.json();
  assert.equal(secondBody.key.workspaceId, invited.customer.id);
  assert.equal(await store.isClientKey(secondBody.api_key), true);
  const oldKey = secondBody.api_key;
  const rotated = await post(base, `/portal/api/keys/${secondBody.key.id}/rotate`, {}, portalHeaders);
  assert.equal(rotated.status, 200);
  const newKey = (await rotated.json()).api_key;
  assert.equal(await store.isClientKey(oldKey), false);
  assert.equal(await store.isClientKey(newKey), true);
  const selfRotate = await post(base, '/service/keys/self/rotate', {}, { authorization: `Bearer ${newKey}` });
  assert.equal(selfRotate.status, 200);
  const newestKey = (await selfRotate.json()).api_key;
  assert.equal(await store.isClientKey(newKey), false);
  assert.equal(await store.isClientKey(newestKey), true);
  const health = await fetch(`${base}/service/health`, { headers: { authorization: `Bearer ${newestKey}` } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).upstream_probe, 'not_performed');
  assert.equal((await fetch(`${base}/service/health`)).status, 401);

  const another = await store.createClient('Bank B');
  assert.equal((await post(base, `/portal/api/keys/${another.client.id}/rotate`, {}, portalHeaders)).status, 404);
  assert.equal((await post(base, `/portal/api/keys/${another.client.id}/revoke`, {}, portalHeaders)).status, 404);
  assert.equal(await store.isClientKey(another.apiKey), true);
  const legacyInvite = await post(base, `/admin/api/customers/${another.client.id}/invite`, { admin_email: 'owner@bankb.example' }, adminHeaders);
  assert.equal(legacyInvite.status, 201);
  const legacyToken = new URL(sent.at(-1).url).hash.replace('#invite=', '');
  const legacyAccept = await post(base, '/portal/api/invitations/accept', { token: legacyToken, password: 'AnotherPass!123' });
  assert.equal(legacyAccept.status, 201);
  assert.equal((await legacyAccept.json()).account.client_id, another.client.id);
  assert.equal(await store.isClientKey(another.apiKey), true);
  assert.equal(await store.claimInvitation('once'), true);
  assert.equal(await store.claimInvitation('once'), false);
  const adminList = await fetch(`${base}/admin/api/customers`, { headers: { cookie: adminCookie } });
  const registry = await adminList.json();
  assert.equal(registry.keys.filter((key) => key.workspaceId === invited.customer.id).length, 2);
  assert.equal(JSON.stringify(registry).includes(newestKey), false);
  assert.equal(JSON.stringify(registry).includes('invitationHash'), false);
});

test('invitation hash expires and cannot validate a modified token', () => {
  const issued = createInvitation('abcdef0123456789', 1000);
  const customer = { id: 'abcdef0123456789', status: 'pending', invitationHash: issued.tokenHash, invitationExpiresAt: issued.expiresAt };
  assert.equal(validInvitation(customer, issued.token, 1000), true);
  assert.equal(validInvitation(customer, `${issued.token}x`, 1000), false);
  assert.equal(validInvitation(customer, issued.token, 1000 + 49 * 60 * 60 * 1000), false);
});
