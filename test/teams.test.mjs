import assert from 'node:assert/strict';
import test from 'node:test';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { createPortalAccount } from '../lib/portal-auth.mjs';
import { MemoryCustomerUsageStore, moneyMicros, validateUsagePolicy } from '../lib/customer-usage.mjs';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');

async function post(base, path, body = {}, headers = {}) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('same-domain team invitation, member keys, shared credit, and removal remain organization scoped', async (t) => {
  const store = new EnvironmentStore();
  const usageStore = new MemoryCustomerUsageStore();
  const workspaceId = 'abcdef0123456789';
  await store.setCustomer({ id: workspaceId, name: 'Example Bank', adminEmail: 'owner@bank.example', status: 'active', usagePolicyVersion: 1 });
  await store.setPortalUser(createPortalAccount('owner@bank.example', 'OwnerPassword!123', { id: workspaceId, name: 'Example Bank' }));
  await store.setPortalSessionKey('test-team-session-signing-key');
  const sent = [];
  const codes = [];
  const mailer = { configured: true, sendTeamInvitation: async (message) => sent.push(message),
    sendLoginCode: async (message) => codes.push(message) };
  const server = createAppServer({ store, usageStore, mailer, startWorker: false, deepResearchQueue: null, formsQueue: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  async function signIn(email, password) {
    const login = await post(base, '/portal/api/auth/login', { email, password });
    assert.equal(login.status, 202);
    const challenge = (await login.json()).challenge_id;
    const verified = await post(base, '/portal/api/auth/verify-code', { email, challenge_id: challenge, code: codes.at(-1).code });
    assert.equal(verified.status, 200);
    const payload = await verified.json();
    return { cookie: verified.headers.get('set-cookie').split(';')[0], csrf: payload.csrf_token, account: payload.account };
  }

  const admin = await signIn('owner@bank.example', 'OwnerPassword!123');
  assert.equal(admin.account.role, 'org_admin');
  const adminHeaders = { cookie: admin.cookie, 'x-ai7-csrf': admin.csrf };
  assert.equal((await post(base, '/portal/api/team/invitations', { email: 'member@bank.example' }, adminHeaders)).status, 409);
  assert.equal((await post(base, '/portal/api/team', {}, { cookie: admin.cookie })).status, 403);
  assert.equal((await post(base, '/portal/api/team', {}, adminHeaders)).status, 200);
  assert.equal((await store.getCustomer(workspaceId)).teamCreatedAt !== undefined, true);
  assert.equal((await post(base, '/portal/api/team/invitations', { email: 'outsider@other.example' }, adminHeaders)).status, 400);
  assert.equal((await fetch(`${base}/admin/api/customers`, { headers: { cookie: admin.cookie } })).status, 401);
  const invite = await post(base, '/portal/api/team/invitations', { email: 'member@bank.example' }, adminHeaders);
  assert.equal(invite.status, 201);
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(sent).includes('ai7_live_'), false);
  const token = new URL(sent[0].url).hash.replace('#team-invite=', '');
  const preview = await post(base, '/portal/api/team/invitations/preview', { token });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).team.email, 'member@bank.example');
  assert.equal((await post(base, '/portal/api/team/invitations/accept', { token: `${token}x`, password: 'MemberPassword!123' })).status, 400);
  assert.equal((await post(base, '/portal/api/team/invitations/accept', { token, password: 'weak' })).status, 400);
  const accepted = await post(base, '/portal/api/team/invitations/accept', { token, password: 'MemberPassword!123' });
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).account.role, 'member');
  assert.equal((await post(base, '/portal/api/team/invitations/accept', { token, password: 'MemberPassword!123' })).status, 400);

  const member = await signIn('member@bank.example', 'MemberPassword!123');
  const memberHeaders = { cookie: member.cookie, 'x-ai7-csrf': member.csrf };
  assert.equal(member.account.client_id, workspaceId);
  assert.equal((await post(base, '/portal/api/team/invitations', { email: 'another@bank.example' }, memberHeaders)).status, 403);
  assert.equal((await post(base, '/portal/api/team/members/remove', { email: 'owner@bank.example' }, memberHeaders)).status, 403);
  assert.equal((await fetch(`${base}/portal/api/team`, { headers: { cookie: member.cookie } })).status, 200);
  const memberKeyResponse = await post(base, '/portal/api/keys', { label: 'Member integration' },
    { ...memberHeaders, 'idempotency-key': 'member-key-request-0001' });
  assert.equal(memberKeyResponse.status, 201);
  const memberKey = await memberKeyResponse.json();
  assert.equal(memberKey.key.workspaceId, workspaceId);
  assert.equal(memberKey.key.ownerEmail, 'member@bank.example');
  assert.equal((await store.getClientForKey(memberKey.api_key)).id, workspaceId);
  const adminKeyResponse = await post(base, '/portal/api/keys', { label: 'Admin integration' },
    { ...adminHeaders, 'idempotency-key': 'admin-key-request-0001' });
  assert.equal(adminKeyResponse.status, 201);
  const adminKey = await adminKeyResponse.json();
  assert.equal((await post(base, `/portal/api/keys/${adminKey.key.id}/rotate`, {}, memberHeaders)).status, 404);
  assert.equal((await post(base, `/portal/api/keys/${adminKey.key.id}/revoke`, {}, memberHeaders)).status, 404);
  assert.equal((await post(base, '/portal/api/keys', { label: 'Member integration' },
    { ...adminHeaders, 'idempotency-key': 'member-key-request-0001' })).status, 409);

  const policy = validateUsagePolicy({ mode: 'prepaid', currency: 'USD', allowed_modules: ['team-test'],
    rates: { 'team-test': [{ up_to: null, price: '0.10' }] } }, new Set(['team-test']));
  await usageStore.configure(workspaceId, policy, true);
  await usageStore.addCredit(workspaceId, moneyMicros('0.20'), true);
  for (const [transactionId, keyId] of [['team-admin-call', adminKey.key.id], ['team-member-call', memberKey.key.id]]) {
    const admitted = await usageStore.admit(workspaceId, { transactionId, keyId, moduleIds: ['team-test'], method: 'POST', path: '/service/team-test' }, true);
    assert.equal(admitted.allowed, true);
    await usageStore.complete(workspaceId, admitted.logKey, 200);
  }
  assert.equal((await usageStore.account(workspaceId, true)).balance, '0.000000');
  assert.deepEqual(new Set((await usageStore.logs(workspaceId)).map((row) => row.key_id)), new Set([adminKey.key.id, memberKey.key.id]));
  const portalUsage = await fetch(`${base}/portal/api/usage`, { headers: { cookie: member.cookie } });
  assert.equal((await portalUsage.json()).account.balance, '0.000000');

  const removed = await post(base, '/portal/api/team/members/remove', { email: 'member@bank.example' }, adminHeaders);
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).revoked_keys, 1);
  assert.equal((await fetch(`${base}/portal/api/auth/session`, { headers: { cookie: member.cookie } })).status, 401);
  assert.equal(await store.getClientForKey(memberKey.api_key), null);
  assert.equal((await fetch(`${base}/service/health`, { headers: { authorization: `Bearer ${memberKey.api_key}` } })).status, 401);
  assert.equal((await store.getClientForKey(adminKey.api_key)).id, workspaceId);

  const reinvite = await post(base, '/portal/api/team/invitations', { email: 'member@bank.example' }, adminHeaders);
  assert.equal(reinvite.status, 201);
  const replacement = new URL(sent.at(-1).url).hash.replace('#team-invite=', '');
  assert.equal((await post(base, '/portal/api/team/invitations/accept', { token: replacement, password: 'NewMemberPass!123' })).status, 201);
  assert.equal((await signIn('member@bank.example', 'NewMemberPass!123')).account.role, 'member');
  await store.setCustomer({ ...(await store.getCustomer(workspaceId)), status: 'disabled' });
  assert.equal(await store.getClientForKey(adminKey.api_key), null);
});

test('an existing portal admin can create a team when the legacy workspace has no customer record', async (t) => {
  const store = new EnvironmentStore();
  const { client } = await store.createClient('Legacy Workspace');
  await store.setPortalUser(createPortalAccount('owner@ai7lab.net', 'OwnerPassword!123', { id: client.id, name: client.name }));
  await store.setPortalSessionKey('legacy-team-session-signing-key');
  const sent = [];
  const codes = [];
  const mailer = { configured: true, sendTeamInvitation: async (message) => sent.push(message),
    sendLoginCode: async (message) => codes.push(message) };
  const server = createAppServer({ store, mailer, startWorker: false, deepResearchQueue: null, formsQueue: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = await post(base, '/portal/api/auth/login', { email: 'owner@ai7lab.net', password: 'OwnerPassword!123' });
  assert.equal(login.status, 202);
  const challenge = (await login.json()).challenge_id;
  const verified = await post(base, '/portal/api/auth/verify-code',
    { email: 'owner@ai7lab.net', challenge_id: challenge, code: codes.at(-1).code });
  assert.equal(verified.status, 200);
  const cookie = verified.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'x-ai7-csrf': (await verified.json()).csrf_token };

  const before = await fetch(`${base}/portal/api/team`, { headers: { cookie } });
  assert.equal(before.status, 200);
  assert.deepEqual((({ created, domain, role }) => ({ created, domain, role }))(await before.json()),
    { created: false, domain: 'ai7lab.net', role: 'org_admin' });
  assert.equal(await store.getCustomer(client.id), null);

  assert.equal((await post(base, '/portal/api/team', {}, headers)).status, 200);
  const customer = await store.getCustomer(client.id);
  assert.equal(customer.status, 'active');
  assert.equal(customer.adminEmail, 'owner@ai7lab.net');
  assert.ok(customer.teamCreatedAt);
  assert.equal((await post(base, '/portal/api/team/invitations', { email: 'outside@example.net' }, headers)).status, 400);
  assert.equal((await post(base, '/portal/api/team/invitations', { email: 'sales@ai7lab.net' }, headers)).status, 201);
  assert.equal(sent.length, 1);
});
