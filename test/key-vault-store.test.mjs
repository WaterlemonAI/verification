import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyVaultStore } from '../lib/api-store.mjs';

test('Key Vault store keeps customer credentials hashed and supports revocation', async () => {
  process.env.IDENTITY_ENDPOINT = 'http://identity.local/token';
  process.env.IDENTITY_HEADER = 'identity-proof';
  const secrets = new Map();

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'identity.local') {
      assert.equal(options.headers['X-IDENTITY-HEADER'], 'identity-proof');
      assert.equal(url.searchParams.get('client_id'), 'runtime-client-id');
      return Response.json({ access_token: 'managed-token', expires_on: String(Math.floor(Date.now() / 1000) + 3600) });
    }

    assert.equal(options.headers.authorization, 'Bearer managed-token');
    if (url.pathname === '/secrets' && (!options.method || options.method === 'GET')) {
      return Response.json({ value: [...secrets.entries()].map(([name, item]) => ({ id: `https://vault.test/secrets/${name}`, tags: item.tags })) });
    }

    const name = decodeURIComponent(url.pathname.split('/').pop());
    if (options.method === 'PUT') {
      const value = JSON.parse(options.body);
      secrets.set(name, value);
      return Response.json({ id: `https://vault.test/secrets/${name}/version`, ...value });
    }
    if (!secrets.has(name)) return new Response('', { status: 404 });
    return Response.json({ id: `https://vault.test/secrets/${name}/version`, ...secrets.get(name) });
  };

  const store = new KeyVaultStore({ vaultUri: 'https://vault.test/', managedIdentityClientId: 'runtime-client-id', fetchImpl });
  const issued = await store.createClient('Production Customer');
  assert.equal(await store.isClientKey(issued.apiKey), true);
  assert.deepEqual(await store.getClientForKey(issued.apiKey), { id: issued.client.id, key_id: issued.client.id, name: 'Production Customer', status: 'active' });

  const stored = secrets.get(`client-${issued.client.id}`);
  assert.notEqual(stored.value, issued.apiKey);
  assert.match(stored.value, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(await store.listClients()).includes(stored.value), false);

  const workspaceId = 'abcdef0123456789';
  const second = await store.createClient('Production Customer', { workspaceId, label: 'Automation' });
  assert.equal((await store.getClientForKey(second.apiKey)).id, workspaceId);
  assert.equal((await store.listClients()).find((item) => item.id === second.client.id).label, 'Automation');
  const rotated = await store.rotateClient(second.client.id, workspaceId);
  assert.equal(await store.isClientKey(second.apiKey), false);
  assert.equal(await store.isClientKey(rotated.apiKey), true);
  assert.equal(await store.rotateClient(second.client.id, 'wrong-workspace'), null);
  await store.setCustomer({ id: workspaceId, name: 'Production Customer', adminEmail: 'owner@example.com', status: 'pending', invitationHash: 'hash', invitationExpiresAt: '2026-10-30T00:00:00Z' });
  assert.equal((await store.getCustomer(workspaceId)).adminEmail, 'owner@example.com');
  assert.equal((await store.listCustomers()).length, 1);
  process.env.ADVERSE_MEDIA_REPORT_TABLE_URL = 'https://table.test';
  const claims = new Set();
  store.invitationTable = { createEntity: async (item) => {
    assert.equal(item.partitionKey, 'customer-invitations');
    if (claims.has(item.rowKey)) throw Object.assign(new Error('exists'), { statusCode: 409 });
    claims.add(item.rowKey);
  } };
  assert.equal(await store.claimInvitation('a'.repeat(64)), true);
  assert.equal(await store.claimInvitation('a'.repeat(64)), false);

  const portalAccount = {
    email: 'user@example.com', client_id: issued.client.id, client_name: issued.client.name,
    password_algorithm: 'scrypt-v1', password_salt: 'salt', password_hash: 'hash', version: 1,
    created_at: '2026-10-26T00:00:00.000Z', updated_at: '2026-10-26T00:00:00.000Z'
  };
  await store.setPortalUser(portalAccount);
  await store.setPortalSessionKey('portal-signing-key');
  assert.deepEqual(await store.getPortalUser('USER@example.com'), portalAccount);
  assert.equal(await store.getPortalSessionKey(), 'portal-signing-key');
  const storedPortalUser = [...secrets.values()].find((item) => item.tags.kind === 'portal-user');
  assert.equal(storedPortalUser.value.includes(issued.apiKey), false);
  assert.equal(storedPortalUser.tags.clientId, issued.client.id);
  const [portalSecretName, portalSecret] = [...secrets.entries()].find(([, item]) => item.tags.kind === 'portal-user');
  secrets.set(portalSecretName, { ...portalSecret, value: JSON.stringify({ ...portalAccount, version: 2 }) });
  assert.equal((await store.getPortalUser(portalAccount.email)).version, 1);
  assert.equal((await store.getPortalUser(portalAccount.email, { fresh: true })).version, 2);

  await store.revokeClient(issued.client.id);
  assert.equal(await store.isClientKey(issued.apiKey), false);

  const integration = {
    id: 'uae-trade-licence',
    name: 'UAE Trade Licence (All Emirates)',
    publicPath: '/service/uae_tlv',
    method: 'POST',
    upstreamUrl: 'https://provider.test/service/uae_tlv',
    authType: 'bearer',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    acceptedContentTypes: ['application/json'],
    documentedStatuses: [200, 401],
    enabled: true
  };
  await store.upsertIntegration(integration, '');
  assert.equal((await store.listIntegrations()).find((item) => item.id === 'uae-trade-licence').masterAuthKeyConfigured, false);

  await store.upsertIntegration(integration, 'upstream-master-key');
  assert.equal((await store.listIntegrations()).find((item) => item.id === 'uae-trade-licence').masterAuthKeyConfigured, true);
  assert.equal(secrets.get('integration-uae-trade-licence-master-key').value, 'upstream-master-key');

  const ibanIntegration = {
    ...integration,
    id: 'iban-verification',
    name: 'International Bank Account Verification',
    publicPath: '/service/iban_verification',
    upstreamUrl: 'https://provider.test/v1/apicall/bank/intl_bank_acc_verification',
    authType: 'header',
    authHeader: 'username',
    authPrefix: '',
    adapter: 'encrypted-json-relay'
  };
  await store.upsertIntegration(ibanIntegration, '');
  const savedCredential = await store.setMasterKey('iban-verification', 'private-username');
  assert.equal(savedCredential.masterAuthKeyConfigured, true);
  assert.equal(secrets.get('integration-iban-verification-master-key').value, 'private-username');
  assert.equal(secrets.get('integration-uae-trade-licence-master-key').value, 'upstream-master-key');
  assert.equal(JSON.stringify(await store.listIntegrations()).includes('private-username'), false);
});
