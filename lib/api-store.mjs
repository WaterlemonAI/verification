import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

function matchesHash(token, expected) {
  if (!token || !/^[a-f0-9]{64}$/i.test(expected || '')) return false;
  return timingSafeEqual(Buffer.from(hash(token)), Buffer.from(expected.toLowerCase()));
}

function parseHashes(raw) {
  return String(raw || '').split(',').map((value) => value.trim().toLowerCase()).filter((value) => /^[a-f0-9]{64}$/.test(value));
}

function builtInIntegration() {
  if (!process.env.UAE_TLV_UPSTREAM_URL) return null;
  return {
    id: 'uae-trade-licence',
    name: 'UAE Trade Licence (All Emirates)',
    publicPath: '/service/uae_tlv',
    method: 'POST',
    upstreamUrl: process.env.UAE_TLV_UPSTREAM_URL,
    authType: 'bearer',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    acceptedContentTypes: ['application/json', 'multipart/form-data'],
    documentedStatuses: [200, 400, 401, 422, 500],
    enabled: true,
    createdAt: now(),
    updatedAt: now()
  };
}

function publicIntegration(integration) {
  return {
    id: integration.id,
    name: integration.name,
    publicPath: integration.publicPath,
    method: integration.method,
    acceptedContentTypes: integration.acceptedContentTypes || [],
    documentedStatuses: integration.documentedStatuses || [],
    enabled: integration.enabled,
    createdAt: integration.createdAt,
    updatedAt: integration.updatedAt
  };
}

function makeClient(name) {
  const id = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const apiKey = `ai7_live_${id}_${secret}`;
  return {
    record: { id, name, keyHash: hash(apiKey), lastFour: apiKey.slice(-4), status: 'active', createdAt: now(), updatedAt: now() },
    apiKey
  };
}

export class EnvironmentStore {
  constructor() {
    this.integrations = [];
    const initial = builtInIntegration();
    if (initial) this.integrations.push(initial);
    this.clients = [];
    this.masterKeys = new Map();
    if (process.env.UAE_TLV_UPSTREAM_TOKEN) this.masterKeys.set('uae-trade-licence', process.env.UAE_TLV_UPSTREAM_TOKEN);
  }

  async isAdminKey(token) {
    return parseHashes(process.env.AI7_ADMIN_KEY_HASHES).some((expected) => matchesHash(token, expected));
  }

  async isClientKey(token) {
    if (parseHashes(process.env.AI7_API_KEY_HASHES).some((expected) => matchesHash(token, expected))) return true;
    return this.clients.some((client) => client.status === 'active' && matchesHash(token, client.keyHash));
  }

  async listIntegrations({ publicOnly = false } = {}) {
    return this.integrations.map((item) => publicOnly ? publicIntegration(item) : { ...item, upstreamUrlConfigured: Boolean(item.upstreamUrl), upstreamUrl: undefined });
  }

  async getIntegration(pathname, method) {
    return this.integrations.find((item) => item.enabled && item.publicPath === pathname && item.method === method) || null;
  }

  async getMasterKey(id) {
    return this.masterKeys.get(id) || '';
  }

  async upsertIntegration(input, masterAuthKey) {
    const existing = this.integrations.find((item) => item.id === input.id);
    const conflict = this.integrations.find((item) => item.id !== input.id && item.publicPath === input.publicPath && item.method === input.method);
    if (conflict) throw new Error('That public method and path are already configured.');
    const record = { ...existing, ...input, createdAt: existing?.createdAt || now(), updatedAt: now() };
    this.integrations = [...this.integrations.filter((item) => item.id !== record.id), record];
    if (masterAuthKey) this.masterKeys.set(record.id, masterAuthKey);
    return { ...publicIntegration(record), masterAuthKeyConfigured: this.masterKeys.has(record.id) };
  }

  async listClients() {
    return this.clients.map(({ keyHash, ...safe }) => safe);
  }

  async createClient(name) {
    const { record, apiKey } = makeClient(name);
    this.clients.push(record);
    return { client: (({ keyHash, ...safe }) => safe)(record), apiKey };
  }

  async revokeClient(id) {
    const client = this.clients.find((item) => item.id === id);
    if (!client) return null;
    client.status = 'revoked';
    client.updatedAt = now();
    return (({ keyHash, ...safe }) => safe)(client);
  }
}

export class KeyVaultStore {
  constructor({ vaultUri, managedIdentityClientId, fetchImpl = fetch }) {
    this.vaultUri = vaultUri.endsWith('/') ? vaultUri : `${vaultUri}/`;
    this.managedIdentityClientId = managedIdentityClientId;
    this.fetch = fetchImpl;
    this.token = null;
    this.cache = new Map();
  }

  async accessToken() {
    if (this.token?.expiresAt > Date.now() + 60_000) return this.token.value;
    const endpoint = process.env.IDENTITY_ENDPOINT;
    const identityHeader = process.env.IDENTITY_HEADER;
    if (!endpoint || !identityHeader) throw new Error('managed_identity_unavailable');
    const url = new URL(endpoint);
    url.searchParams.set('resource', 'https://vault.azure.net');
    url.searchParams.set('api-version', '2019-08-01');
    if (this.managedIdentityClientId) url.searchParams.set('client_id', this.managedIdentityClientId);
    const response = await this.fetch(url, { headers: { 'X-IDENTITY-HEADER': identityHeader } });
    if (!response.ok) throw new Error('managed_identity_token_failed');
    const body = await response.json();
    this.token = { value: body.access_token, expiresAt: Number(body.expires_on) * 1000 };
    return this.token.value;
  }

  async requestSecret(name, options = {}) {
    const token = await this.accessToken();
    const url = `${this.vaultUri}secrets/${encodeURIComponent(name)}?api-version=7.4`;
    return this.fetch(url, {
      ...options,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers || {}) }
    });
  }

  async getSecretDocument(name) {
    const cached = this.cache.get(name);
    if (cached?.expiresAt > Date.now()) return cached.document;
    const response = await this.requestSecret(name);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('key_vault_read_failed');
    const document = await response.json();
    this.cache.set(name, { document, expiresAt: Date.now() + 30_000 });
    return document;
  }

  async getSecret(name, fallback = '') {
    const document = await this.getSecretDocument(name);
    return document?.value ?? fallback;
  }

  async setSecret(name, value, tags = {}) {
    const response = await this.requestSecret(name, { method: 'PUT', body: JSON.stringify({ value, tags }) });
    if (!response.ok) throw new Error('key_vault_write_failed');
    this.cache.delete(name);
  }

  async getJson(name, fallback) {
    const value = await this.getSecret(name, '');
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { throw new Error('key_vault_data_invalid'); }
  }

  async setJson(name, value) {
    await this.setSecret(name, JSON.stringify(value));
  }

  async isAdminKey(token) {
    return parseHashes(await this.getSecret('ai7-admin-key-hashes')).some((expected) => matchesHash(token, expected));
  }

  async isClientKey(token) {
    const match = /^ai7_live_([a-f0-9]{16})_[A-Za-z0-9_-]+$/.exec(token || '');
    if (!match) return false;
    const document = await this.getSecretDocument(`client-${match[1]}`);
    return document?.tags?.status === 'active' && matchesHash(token, document.value);
  }

  async listIntegrations({ publicOnly = false } = {}) {
    const integrations = await this.getJson('api-engine-integrations', []);
    return integrations.map((item) => publicOnly ? publicIntegration(item) : { ...publicIntegration(item), upstreamUrlConfigured: Boolean(item.upstreamUrl), masterAuthKeyConfigured: Boolean(item.upstreamSecretName) });
  }

  async getIntegration(pathname, method) {
    const integrations = await this.getJson('api-engine-integrations', []);
    return integrations.find((item) => item.enabled && item.publicPath === pathname && item.method === method) || null;
  }

  async getMasterKey(id) {
    return this.getSecret(`integration-${id}-master-key`);
  }

  async upsertIntegration(input, masterAuthKey) {
    const integrations = await this.getJson('api-engine-integrations', []);
    const existing = integrations.find((item) => item.id === input.id);
    const conflict = integrations.find((item) => item.id !== input.id && item.publicPath === input.publicPath && item.method === input.method);
    if (conflict) throw new Error('That public method and path are already configured.');
    const secretName = `integration-${input.id}-master-key`;
    const record = {
      ...existing,
      ...input,
      upstreamSecretName: input.authType === 'none' ? '' : secretName,
      createdAt: existing?.createdAt || now(),
      updatedAt: now()
    };
    if (masterAuthKey) await this.setSecret(secretName, masterAuthKey, { integration: input.id, purpose: 'upstream-auth' });
    await this.setJson('api-engine-integrations', [...integrations.filter((item) => item.id !== input.id), record]);
    return { ...publicIntegration(record), masterAuthKeyConfigured: Boolean(masterAuthKey || existing?.upstreamSecretName) };
  }

  async listClients() {
    const token = await this.accessToken();
    let next = `${this.vaultUri}secrets?api-version=7.4&maxresults=25`;
    const clients = [];
    while (next) {
      const response = await this.fetch(next, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('key_vault_list_failed');
      const page = await response.json();
      for (const item of page.value || []) {
        if (item.tags?.kind !== 'client') continue;
        const secretName = item.id.split('/').pop();
        clients.push({
          id: secretName.replace(/^client-/, ''),
          name: item.tags.name,
          lastFour: item.tags.lastFour,
          status: item.tags.status,
          createdAt: item.tags.createdAt,
          updatedAt: item.tags.updatedAt
        });
      }
      next = page.nextLink || '';
    }
    return clients.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createClient(name) {
    const { record, apiKey } = makeClient(name);
    await this.setSecret(`client-${record.id}`, record.keyHash, {
      kind: 'client', name: record.name, lastFour: record.lastFour, status: record.status,
      createdAt: record.createdAt, updatedAt: record.updatedAt
    });
    return { client: (({ keyHash, ...safe }) => safe)(record), apiKey };
  }

  async revokeClient(id) {
    const secretName = `client-${id}`;
    const document = await this.getSecretDocument(secretName);
    if (!document) return null;
    const updatedAt = now();
    const tags = { ...(document.tags || {}), status: 'revoked', updatedAt };
    await this.setSecret(secretName, document.value, tags);
    return { id, name: tags.name, lastFour: tags.lastFour, status: tags.status, createdAt: tags.createdAt, updatedAt };
  }
}

export function createStore() {
  if (process.env.KEY_VAULT_URI) {
    return new KeyVaultStore({ vaultUri: process.env.KEY_VAULT_URI, managedIdentityClientId: process.env.RUNTIME_IDENTITY_CLIENT_ID });
  }
  return new EnvironmentStore();
}
