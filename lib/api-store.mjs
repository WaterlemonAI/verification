import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TableClient } from '@azure/data-tables';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';
import { createKeyCreationLock } from './key-creation-lock.mjs';
import { DOCUMENT_OCR_APIS } from './document-ocr-contracts.mjs';

const documentOcrIds = new Set(DOCUMENT_OCR_APIS.map((item) => item.id));
const extractionEngines = new Set(['azure', 'ollama']);
function checkedOcrEngine(id, engine) {
  if (!documentOcrIds.has(id) || !extractionEngines.has(engine)) throw new Error('document_ocr_engine_invalid');
  return engine;
}

const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

const nativeIntegrations = [
  ...DOCUMENT_OCR_APIS.map((item) => ({
    id: item.id,
    name: item.name,
    publicPath: item.publicPath,
    method: 'POST',
    authType: 'none',
    authHeader: '',
    authPrefix: '',
    adapter: 'native-document-ocr',
    acceptedContentTypes: ['multipart/form-data'],
    documentedStatuses: [202, 400, 401, 403, 413, 415, 429, 503],
    enabled: process.env.DOCUMENT_OCR_PRODUCTION_ENABLED === '1',
    native: true,
    formsCompatible: false,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z'
  })),
  {
    id: 'document-ocr-ai',
    name: 'Document OCR AI Structuring',
    publicPath: '/internal/document-ocr-ai',
    method: 'POST',
    authType: 'header',
    authHeader: 'x-goog-api-key',
    authPrefix: '',
    adapter: 'native-document-ocr-ai',
    acceptedContentTypes: ['application/json'],
    documentedStatuses: [200],
    enabled: true,
    native: true,
    internal: true,
    formsCompatible: false,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z'
  },
  {
    id: 'adverse-media',
    name: 'Global Adverse Media Screening',
    publicPath: '/service/adverse_media',
    method: 'POST',
    authType: 'header',
    authHeader: 'x-subscription-token',
    authPrefix: '',
    adapter: 'native-adverse-media',
    acceptedContentTypes: ['application/json'],
    documentedStatuses: [200, 400, 401, 500, 502],
    enabled: true,
    native: true,
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z'
  },
  {
    id: 'merchant-screening',
    name: 'Merchant Website Screening',
    publicPath: '/service/merchant_screening',
    method: 'POST',
    authType: 'none',
    authHeader: '',
    authPrefix: '',
    adapter: 'native-merchant-screening',
    acceptedContentTypes: ['application/json'],
    documentedStatuses: [200, 400, 401, 500, 502, 503],
    enabled: true,
    native: true,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z'
  },
  {
    id: 'ejari-verification',
    name: 'Dubai Ejari Verification',
    publicPath: '/service/dubai_ejari_verification',
    method: 'POST',
    authType: 'none',
    authHeader: '',
    authPrefix: '',
    adapter: 'native-ejari',
    acceptedContentTypes: ['application/json', 'multipart/form-data'],
    documentedStatuses: [202, 400, 401, 403, 409, 413, 415, 429, 503],
    enabled: process.env.EJARI_PLATFORM_ENABLED === '1',
    native: true,
    formsCompatible: false,
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z'
  },
  {
    id: 'adverse-media-ai',
    name: 'Adverse Media AI Classification',
    publicPath: '/internal/adverse-media-ai',
    method: 'POST',
    authType: 'header',
    authHeader: 'x-goog-api-key',
    authPrefix: '',
    adapter: 'native-adverse-media-ai',
    acceptedContentTypes: ['application/json'],
    documentedStatuses: [200],
    enabled: true,
    native: true,
    internal: true,
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z'
  }
];

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
    adapter: 'passthrough',
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
    updatedAt: integration.updatedAt,
    native: integration.native === true,
    formsCompatible: integration.formsCompatible !== false
  };
}

function makeClient(name, { workspaceId, label = 'Default key', ownerEmail = '', id = randomBytes(8).toString('hex'), apiKey = '' } = {}) {
  apiKey ||= `ai7_live_${id}_${randomBytes(32).toString('base64url')}`;
  return {
    record: { id, name, workspaceId: workspaceId || id, label, ownerEmail, keyHash: hash(apiKey), lastFour: apiKey.slice(-4), status: 'active', createdAt: now(), updatedAt: now() },
    apiKey
  };
}

function idempotentClientKey(workspaceId, idempotencyKey, master) {
  if (!master) throw new Error('key_derivation_unavailable');
  const context = `customer-key-v1:${workspaceId}:${idempotencyKey}`;
  const id = createHash('sha256').update(context).digest('hex').slice(0, 16);
  const secret = createHmac('sha256', master).update(context).digest('base64url');
  return { id, apiKey: `ai7_live_${id}_${secret}` };
}

export class EnvironmentStore {
  constructor() {
    this.integrations = nativeIntegrations.map((item) => ({ ...item }));
    const initial = builtInIntegration();
    if (initial) this.integrations.push(initial);
    this.clients = [];
    this.customers = new Map();
    this.invitationClaims = new Set();
    this.forms = [];
    this.masterKeys = new Map();
    this.ejariConfig = { enabled: false, ocr_model: 'gpt-6-luna', ocr_detail: 'high' };
    this.ejariCredentials = new Map();
    this.adminAccount = null;
    this.adminSessionKey = '';
    this.portalUsers = new Map();
    this.portalSessionKey = '';
    if (process.env.UAE_TLV_UPSTREAM_TOKEN) this.masterKeys.set('uae-trade-licence', process.env.UAE_TLV_UPSTREAM_TOKEN);
    if (process.env.BRAVE_SEARCH_API_KEY) this.masterKeys.set('adverse-media', process.env.BRAVE_SEARCH_API_KEY);
    if (process.env.GEMINI_API_KEY) this.masterKeys.set('adverse-media-ai', process.env.GEMINI_API_KEY);
    if (process.env.DOCUMENT_OCR_GEMINI_API_KEY) this.masterKeys.set('document-ocr-ai', process.env.DOCUMENT_OCR_GEMINI_API_KEY);
  }

  async isAdminKey(token) {
    return parseHashes(process.env.AI7_ADMIN_KEY_HASHES).some((expected) => matchesHash(token, expected));
  }

  async getAdminAccount() {
    return this.adminAccount ? { ...this.adminAccount } : null;
  }

  async setAdminAccount(account) {
    this.adminAccount = { ...account };
    return { ...this.adminAccount };
  }

  async getAdminSessionKey() {
    return this.adminSessionKey;
  }

  async setAdminSessionKey(key) {
    this.adminSessionKey = key;
  }

  async getClientForKey(token) {
    if (parseHashes(process.env.AI7_API_KEY_HASHES).some((expected) => matchesHash(token, expected))) {
      return { id: `environment-${hash(token).slice(0, 16)}`, name: 'AI7 API workspace', status: 'active' };
    }
    const client = this.clients.find((item) => item.status === 'active' && matchesHash(token, item.keyHash));
    return client ? { id: client.workspaceId || client.id, key_id: client.id, name: client.name, status: client.status } : null;
  }

  async isClientKey(token) {
    return Boolean(await this.getClientForKey(token));
  }

  async getPortalUser(email) {
    const account = this.portalUsers.get(String(email || '').trim().toLowerCase());
    return account ? { ...account } : null;
  }

  async setPortalUser(account) {
    this.portalUsers.set(account.email, { ...account });
    return { ...account };
  }

  async getPortalSessionKey() {
    return this.portalSessionKey;
  }

  async setPortalSessionKey(key) {
    this.portalSessionKey = key;
  }

  async listIntegrations({ publicOnly = false } = {}) {
    const integrations = publicOnly ? this.integrations.filter((item) => !item.internal) : this.integrations;
    return integrations.map((item) => publicOnly ? publicIntegration(item) : { ...item,
      ...(documentOcrIds.has(item.id) ? { extractionEngine: this.documentOcrEngines?.get(item.id) || 'azure' } : {}),
      upstreamUrlConfigured: item.native === true || Boolean(item.upstreamUrl), upstreamUrl: undefined,
      masterAuthKeyConfigured: item.authType === 'none' || this.masterKeys.has(item.id) });
  }

  async getDocumentOcrEngine(id) {
    if (!documentOcrIds.has(id)) throw new Error('document_ocr_engine_invalid');
    if (process.env.DOCUMENT_OCR_FORCE_OLLAMA === '1') return 'ollama';
    return this.documentOcrEngines?.get(id) || 'azure';
  }

  async setDocumentOcrEngine(id, engine, actor) {
    checkedOcrEngine(id, engine);
    if (!actor) throw new Error('document_ocr_actor_required');
    this.documentOcrEngines ||= new Map();
    this.documentOcrEngineAudit ||= [];
    const previous = await this.getDocumentOcrEngine(id);
    this.documentOcrEngines.set(id, engine);
    this.documentOcrEngineAudit.push({ id, previous, engine, actor, at: now() });
    return { serviceId: id, extractionEngine: engine };
  }

  async getIntegration(pathname, method) {
    return this.integrations.find((item) => !item.internal && item.enabled && item.publicPath === pathname && item.method === method) || null;
  }

  async getIntegrationById(id) {
    return this.integrations.find((item) => !item.internal && item.enabled && item.id === id) || null;
  }

  async listForms() {
    return this.forms.map((item) => JSON.parse(JSON.stringify(item)));
  }

  async getForm(id) {
    const form = this.forms.find((item) => item.id === id);
    return form ? JSON.parse(JSON.stringify(form)) : null;
  }

  async upsertForm(input) {
    const existing = this.forms.find((item) => item.id === input.id);
    const timestamp = now();
    const record = {
      ...input,
      version: (existing?.version || 0) + 1,
      created_at: existing?.created_at || timestamp,
      updated_at: timestamp
    };
    this.forms = [...this.forms.filter((item) => item.id !== input.id), record];
    return JSON.parse(JSON.stringify(record));
  }

  async getMasterKey(id) {
    return this.masterKeys.get(id) || '';
  }

  async getEjariConfig() {
    return { ...this.ejariConfig, openaiKeyConfigured: this.ejariCredentials.has('openai'),
      capsolverKeyConfigured: this.ejariCredentials.has('capsolver') };
  }

  async saveEjariConfig(input) {
    if (input.openai_key) this.ejariCredentials.set('openai', input.openai_key);
    if (input.capsolver_key) this.ejariCredentials.set('capsolver', input.capsolver_key);
    this.ejariConfig = { enabled: input.enabled, ocr_model: input.ocr_model, ocr_detail: input.ocr_detail };
    return this.getEjariConfig();
  }

  async upsertIntegration(input, masterAuthKey) {
    if (nativeIntegrations.some((item) => item.id === input.id || (item.publicPath === input.publicPath && item.method === input.method))) {
      throw new Error('That integration is managed by the AI7 runtime. Update its credential instead.');
    }
    const existing = this.integrations.find((item) => item.id === input.id);
    const conflict = this.integrations.find((item) => item.id !== input.id && item.publicPath === input.publicPath && item.method === input.method);
    if (conflict) throw new Error('That public method and path are already configured.');
    const record = { ...existing, ...input, createdAt: existing?.createdAt || now(), updatedAt: now() };
    this.integrations = [...this.integrations.filter((item) => item.id !== record.id), record];
    if (masterAuthKey) this.masterKeys.set(record.id, masterAuthKey);
    return { ...publicIntegration(record), masterAuthKeyConfigured: this.masterKeys.has(record.id) };
  }

  async setMasterKey(id, credential) {
    const integration = this.integrations.find((item) => item.id === id);
    if (!integration) return null;
    this.masterKeys.set(id, credential);
    return { ...publicIntegration(integration), masterAuthKeyConfigured: true };
  }

  async listClients() {
    return this.clients.map(({ keyHash, ...safe }) => safe);
  }

  async getClient(id) {
    const record = this.clients.find((item) => item.id === id);
    return record ? (({ keyHash, ...safe }) => safe)(record) : null;
  }

  async createClient(name, options = {}) {
    const { record, apiKey } = makeClient(name, options);
    this.clients.push(record);
    return { client: (({ keyHash, ...safe }) => safe)(record), apiKey };
  }

  async createClientIdempotent(name, options = {}, idempotencyKey) {
    const workspaceId = options.workspaceId;
    const identity = idempotentClientKey(workspaceId, idempotencyKey, await this.getPortalSessionKey());
    const existing = this.clients.find((item) => item.id === identity.id);
    if (existing) {
      if (existing.keyHash !== hash(identity.apiKey) || existing.status !== 'active'
        || existing.workspaceId !== workspaceId || existing.label !== options.label) throw new Error('idempotency_conflict');
      return { client: (({ keyHash, ...safe }) => safe)(existing), apiKey: identity.apiKey, reused: true };
    }
    if (this.clients.filter((item) => item.workspaceId === workspaceId && item.status === 'active').length >= 20) {
      throw new Error('workspace_key_limit_reached');
    }
    const { record } = makeClient(name, { ...options, ...identity });
    this.clients.push(record);
    return { client: (({ keyHash, ...safe }) => safe)(record), apiKey: identity.apiKey, reused: false };
  }

  async rotateClient(id, workspaceId) {
    const record = this.clients.find((item) => item.id === id);
    if (!record || record.status !== 'active' || (record.workspaceId || record.id) !== workspaceId) return null;
    const apiKey = `ai7_live_${id}_${randomBytes(32).toString('base64url')}`;
    record.keyHash = hash(apiKey);
    record.lastFour = apiKey.slice(-4);
    record.updatedAt = now();
    return { client: (({ keyHash, ...safe }) => safe)(record), apiKey };
  }

  async getCustomer(id) { return this.customers.get(id) || null; }
  async setCustomer(customer) { this.customers.set(customer.id, { ...customer }); return customer; }
  async listCustomers() { return [...this.customers.values()]; }
  async claimInvitation(tokenHash) {
    if (this.invitationClaims.has(tokenHash)) return false;
    this.invitationClaims.add(tokenHash);
    return true;
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
  constructor({ vaultUri, managedIdentityClientId, fetchImpl = fetch, keyCreationLock = undefined }) {
    this.vaultUri = vaultUri.endsWith('/') ? vaultUri : `${vaultUri}/`;
    this.managedIdentityClientId = managedIdentityClientId;
    this.fetch = fetchImpl;
    this.token = null;
    this.cache = new Map();
    this.invitationTable = null;
    this.keyCreationLock = keyCreationLock === undefined ? createKeyCreationLock() : keyCreationLock;
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

  async getSecretDocument(name, { fresh = false } = {}) {
    const cached = this.cache.get(name);
    if (!fresh && cached?.expiresAt > Date.now()) return cached.document;
    const response = await this.requestSecret(name);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('key_vault_read_failed');
    const document = await response.json();
    this.cache.set(name, { document, expiresAt: Date.now() + 30_000 });
    return document;
  }

  async getSecret(name, fallback = '', options = {}) {
    const document = await this.getSecretDocument(name, options);
    return document?.value ?? fallback;
  }

  async setSecret(name, value, tags = {}) {
    const response = await this.requestSecret(name, { method: 'PUT', body: JSON.stringify({ value, tags }) });
    if (!response.ok) throw new Error('key_vault_write_failed');
    this.cache.delete(name);
  }

  async getJson(name, fallback, options = {}) {
    const value = await this.getSecret(name, '', options);
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { throw new Error('key_vault_data_invalid'); }
  }

  async setJson(name, value) {
    await this.setSecret(name, JSON.stringify(value));
  }

  async isAdminKey(token) {
    return parseHashes(await this.getSecret('ai7-admin-key-hashes')).some((expected) => matchesHash(token, expected));
  }

  async getAdminAccount(options = {}) {
    return this.getJson('ai7-admin-account', null, options);
  }

  async setAdminAccount(account) {
    await this.setSecret('ai7-admin-account', JSON.stringify(account), {
      kind: 'admin-account',
      version: String(account.version),
      updatedAt: account.updated_at
    });
    return account;
  }

  async getAdminSessionKey() {
    return this.getSecret('ai7-admin-session-key', '');
  }

  async setAdminSessionKey(key) {
    await this.setSecret('ai7-admin-session-key', key, { kind: 'admin-session-signing-key' });
  }

  async getClientForKey(token) {
    const match = /^ai7_live_([a-f0-9]{16})_[A-Za-z0-9_-]+$/.exec(token || '');
    if (!match) return null;
    const document = await this.getSecretDocument(`client-${match[1]}`, { fresh: true });
    if (document?.tags?.status !== 'active' || !matchesHash(token, document.value)) return null;
    return { id: document.tags.workspaceId || match[1], key_id: match[1], name: document.tags.name || 'AI7 API workspace', status: 'active' };
  }

  async isClientKey(token) {
    return Boolean(await this.getClientForKey(token));
  }

  async getPortalUser(email, options = {}) {
    return this.getJson(`portal-user-${hash(String(email || '').trim().toLowerCase()).slice(0, 40)}`, null, options);
  }

  async setPortalUser(account) {
    await this.setSecret(`portal-user-${hash(account.email).slice(0, 40)}`, JSON.stringify(account), {
      kind: 'portal-user',
      clientId: account.client_id,
      version: String(account.version),
      updatedAt: account.updated_at
    });
    return account;
  }

  async getPortalSessionKey() {
    return this.getSecret('ai7-portal-session-key', '');
  }

  async setPortalSessionKey(key) {
    await this.setSecret('ai7-portal-session-key', key, { kind: 'portal-session-signing-key' });
  }

  async listIntegrations({ publicOnly = false } = {}) {
    const integrations = await this.getJson('api-engine-integrations', []);
    const native = await Promise.all(nativeIntegrations.map(async (item) => ({
      ...item,
      masterAuthKeyConfigured: Boolean(await this.getSecretDocument(`integration-${item.id}-master-key`))
    })));
    const available = publicOnly ? [...native, ...integrations].filter((item) => !item.internal) : [...native, ...integrations];
    return Promise.all(available.map(async (item) => publicOnly ? publicIntegration(item) : {
      ...publicIntegration(item),
      ...(documentOcrIds.has(item.id) ? { extractionEngine: await this.getDocumentOcrEngine(item.id) } : {}),
      upstreamUrlConfigured: item.native === true || Boolean(item.upstreamUrl),
      masterAuthKeyConfigured: item.authType === 'none' || item.masterAuthKeyConfigured === true
    }));
  }

  async getDocumentOcrEngine(id) {
    if (!documentOcrIds.has(id)) throw new Error('document_ocr_engine_invalid');
    if (process.env.DOCUMENT_OCR_FORCE_OLLAMA === '1') return 'ollama';
    const record = await this.getJson(`document-ocr-engine-${id}`, null, { fresh: true });
    return record?.engine === 'paddle' ? 'azure'
      : record ? checkedOcrEngine(id, record.engine) : 'azure';
  }

  async setDocumentOcrEngine(id, engine, actor) {
    checkedOcrEngine(id, engine);
    if (!actor) throw new Error('document_ocr_actor_required');
    const previous = await this.getDocumentOcrEngine(id);
    const at = now();
    const record = { engine, previous, actor, at };
    await this.setSecret(`document-ocr-engine-${id}`, JSON.stringify(record), {
      kind: 'document-ocr-engine', serviceId: id, engine, previous, actor, updatedAt: at
    });
    return { serviceId: id, extractionEngine: engine };
  }

  async getIntegration(pathname, method) {
    const integrations = await this.getJson('api-engine-integrations', []);
    return integrations.find((item) => item.enabled && item.publicPath === pathname && item.method === method) || null;
  }

  async getIntegrationById(id) {
    const native = nativeIntegrations.find((item) => !item.internal && item.enabled && item.id === id);
    if (native) return { ...native };
    const integrations = await this.getJson('api-engine-integrations', []);
    return integrations.find((item) => item.enabled && item.id === id) || null;
  }

  async listForms() {
    const token = await this.accessToken();
    let next = `${this.vaultUri}secrets?api-version=7.4&maxresults=25`;
    const forms = [];
    while (next) {
      const response = await this.fetch(next, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('key_vault_list_failed');
      const page = await response.json();
      for (const item of page.value || []) {
        if (item.tags?.kind !== 'form') continue;
        const secretName = item.id.split('/').pop();
        const form = await this.getJson(secretName, null);
        if (form) forms.push(form);
      }
      next = page.nextLink || '';
    }
    return forms.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  async getForm(id) {
    return this.getJson(`form-${id}`, null);
  }

  async upsertForm(input) {
    const existing = await this.getForm(input.id);
    const timestamp = now();
    const record = {
      ...input,
      version: (existing?.version || 0) + 1,
      created_at: existing?.created_at || timestamp,
      updated_at: timestamp
    };
    await this.setSecret(`form-${input.id}`, JSON.stringify(record), {
      kind: 'form',
      name: record.name,
      enabled: String(record.enabled),
      version: String(record.version),
      updatedAt: timestamp
    });
    return record;
  }

  async getMasterKey(id) {
    return this.getSecret(`integration-${id}-master-key`);
  }

  async getEjariConfig() {
    const config = await this.getJson('ejari-config', { enabled: false, ocr_model: 'gpt-6-luna', ocr_detail: 'high' });
    const [openai, capsolver] = await Promise.all([
      this.getSecretDocument('ejari-openai-key'), this.getSecretDocument('ejari-capsolver-key')
    ]);
    return { ...config, openaiKeyConfigured: Boolean(openai), capsolverKeyConfigured: Boolean(capsolver) };
  }

  async saveEjariConfig(input) {
    if (input.openai_key) await this.setSecret('ejari-openai-key', input.openai_key, { purpose: 'ejari-ocr' });
    if (input.capsolver_key) await this.setSecret('ejari-capsolver-key', input.capsolver_key, { purpose: 'ejari-captcha' });
    await this.setJson('ejari-config', { enabled: input.enabled, ocr_model: input.ocr_model, ocr_detail: input.ocr_detail });
    return this.getEjariConfig();
  }

  async upsertIntegration(input, masterAuthKey) {
    if (nativeIntegrations.some((item) => item.id === input.id || (item.publicPath === input.publicPath && item.method === input.method))) {
      throw new Error('That integration is managed by the AI7 runtime. Update its credential instead.');
    }
    const integrations = await this.getJson('api-engine-integrations', []);
    const existing = integrations.find((item) => item.id === input.id);
    const conflict = integrations.find((item) => item.id !== input.id && item.publicPath === input.publicPath && item.method === input.method);
    if (conflict) throw new Error('That public method and path are already configured.');
    const secretName = `integration-${input.id}-master-key`;
    const record = {
      ...existing,
      ...input,
      upstreamSecretName: input.authType === 'none' ? '' : secretName,
      masterAuthKeyConfigured: input.authType === 'none' || Boolean(masterAuthKey) || existing?.masterAuthKeyConfigured === true,
      createdAt: existing?.createdAt || now(),
      updatedAt: now()
    };
    if (masterAuthKey) await this.setSecret(secretName, masterAuthKey, { integration: input.id, purpose: 'upstream-auth' });
    await this.setJson('api-engine-integrations', [...integrations.filter((item) => item.id !== input.id), record]);
    return { ...publicIntegration(record), masterAuthKeyConfigured: record.masterAuthKeyConfigured };
  }

  async setMasterKey(id, credential) {
    const integrations = await this.getJson('api-engine-integrations', []);
    const integration = nativeIntegrations.find((item) => item.id === id) || integrations.find((item) => item.id === id);
    if (!integration) return null;
    if (integration.native) {
      await this.setSecret(`integration-${id}-master-key`, credential, { integration: id, purpose: 'upstream-auth' });
      return { ...publicIntegration(integration), masterAuthKeyConfigured: true };
    }
    const updatedAt = now();
    const updated = { ...integration, masterAuthKeyConfigured: true, updatedAt };
    await this.setSecret(`integration-${id}-master-key`, credential, { integration: id, purpose: 'upstream-auth' });
    await this.setJson('api-engine-integrations', integrations.map((item) => item.id === id ? updated : item));
    return { ...publicIntegration(updated), masterAuthKeyConfigured: true };
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
          workspaceId: item.tags.workspaceId || secretName.replace(/^client-/, ''),
          label: item.tags.label || 'Default key',
          ownerEmail: item.tags.ownerEmail || '',
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

  async getClient(id) {
    const document = await this.getSecretDocument(`client-${id}`, { fresh: true });
    if (!document) return null;
    const tags = document.tags || {};
    return { id, name: tags.name, workspaceId: tags.workspaceId || id, label: tags.label || 'Default key', ownerEmail: tags.ownerEmail || '', lastFour: tags.lastFour, status: tags.status, createdAt: tags.createdAt, updatedAt: tags.updatedAt };
  }

  async createClient(name, options = {}) {
    const { record, apiKey } = makeClient(name, options);
    await this.setSecret(`client-${record.id}`, record.keyHash, {
      kind: 'client', name: record.name, lastFour: record.lastFour, status: record.status,
      workspaceId: record.workspaceId, label: record.label,
      ...(record.ownerEmail ? { ownerEmail: record.ownerEmail } : {}),
      createdAt: record.createdAt, updatedAt: record.updatedAt
    });
    return { client: (({ keyHash, ...safe }) => safe)(record), apiKey };
  }

  async createClientIdempotent(name, options = {}, idempotencyKey) {
    if (!this.keyCreationLock) throw new Error('workspace_key_lock_unavailable');
    const workspaceId = options.workspaceId;
    const identity = idempotentClientKey(workspaceId, idempotencyKey, await this.getPortalSessionKey());
    return this.keyCreationLock(workspaceId, async (leaseValid) => {
      const existing = await this.getSecretDocument(`client-${identity.id}`, { fresh: true });
      if (existing) {
        if (existing.value !== hash(identity.apiKey) || existing.tags?.status !== 'active'
          || existing.tags?.workspaceId !== workspaceId || existing.tags?.label !== options.label) {
          throw new Error('idempotency_conflict');
        }
        return { client: await this.getClient(identity.id), apiKey: identity.apiKey, reused: true };
      }
      const active = (await this.listClients()).filter((item) => item.workspaceId === workspaceId && item.status === 'active').length;
      if (active >= 20) throw new Error('workspace_key_limit_reached');
      if (!leaseValid()) throw new Error('workspace_key_lock_expired');
      const { record } = makeClient(name, { ...options, ...identity });
      await this.setSecret(`client-${record.id}`, record.keyHash, {
        kind: 'client', name: record.name, lastFour: record.lastFour, status: record.status,
        workspaceId: record.workspaceId, label: record.label,
        ...(record.ownerEmail ? { ownerEmail: record.ownerEmail } : {}),
        createdAt: record.createdAt, updatedAt: record.updatedAt
      });
      return { client: (({ keyHash, ...safe }) => safe)(record), apiKey: identity.apiKey, reused: false };
    });
  }

  async revokeClient(id) {
    const secretName = `client-${id}`;
    const document = await this.getSecretDocument(secretName);
    if (!document) return null;
    const updatedAt = now();
    const tags = { ...(document.tags || {}), status: 'revoked', updatedAt };
    await this.setSecret(secretName, document.value, tags);
    return { id, name: tags.name, workspaceId: tags.workspaceId || id, label: tags.label || 'Default key', ownerEmail: tags.ownerEmail || '', lastFour: tags.lastFour, status: tags.status, createdAt: tags.createdAt, updatedAt };
  }

  async rotateClient(id, workspaceId) {
    const secretName = `client-${id}`;
    const document = await this.getSecretDocument(secretName, { fresh: true });
    if (!document || document.tags?.status !== 'active' || (document.tags.workspaceId || id) !== workspaceId) return null;
    const apiKey = `ai7_live_${id}_${randomBytes(32).toString('base64url')}`;
    const tags = { ...document.tags, lastFour: apiKey.slice(-4), updatedAt: now() };
    await this.setSecret(secretName, hash(apiKey), tags);
    return { client: await this.getClient(id), apiKey };
  }

  async getCustomer(id) { return this.getJson(`customer-${id}`, null, { fresh: true }); }
  async setCustomer(customer) {
    await this.setSecret(`customer-${customer.id}`, JSON.stringify(customer), {
      kind: 'customer', name: customer.name, status: customer.status, updatedAt: customer.updatedAt
    });
    return customer;
  }
  async listCustomers() {
    const token = await this.accessToken();
    let next = `${this.vaultUri}secrets?api-version=7.4&maxresults=25`;
    const customers = [];
    while (next) {
      const response = await this.fetch(next, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('key_vault_list_failed');
      const page = await response.json();
      for (const item of page.value || []) {
        if (item.tags?.kind !== 'customer') continue;
        const customer = await this.getCustomer(item.id.split('/').pop().replace(/^customer-/, ''));
        if (customer) customers.push(customer);
      }
      next = page.nextLink || '';
    }
    return customers;
  }

  async claimInvitation(tokenHash) {
    const tableUrl = process.env.ADVERSE_MEDIA_REPORT_TABLE_URL;
    if (!tableUrl) throw new Error('invitation_claim_store_unavailable');
    this.invitationTable ||= new TableClient(tableUrl, process.env.ADVERSE_MEDIA_REPORT_TABLE || 'AdverseMediaReports', new ContainerAppsManagedIdentityCredential());
    try {
      await this.invitationTable.createEntity({ partitionKey: 'customer-invitations', rowKey: tokenHash, claimedAt: now() });
      return true;
    } catch (error) {
      if (error.statusCode === 409) return false;
      throw new Error('invitation_claim_store_unavailable');
    }
  }
}

export function createStore() {
  if (process.env.KEY_VAULT_URI) {
    return new KeyVaultStore({ vaultUri: process.env.KEY_VAULT_URI, managedIdentityClientId: process.env.RUNTIME_IDENTITY_CLIENT_ID });
  }
  return new EnvironmentStore();
}
