import { createReadStream, readFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/api-store.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8080);
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 15 * 1024 * 1024);
const apiHosts = new Set((process.env.API_HOSTS || 'api.ai7uae.com,localhost,127.0.0.1').split(',').map((v) => v.trim().toLowerCase()));

const mimeTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.webp': 'image/webp'
};

const hopByHopHeaders = new Set(['authorization', 'connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store', ...extraHeaders });
  res.end(payload);
}

function securityHeaders(res) {
  res.setHeader('content-security-policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self' https://api.ai7uae.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
}

function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return match?.[1] || '';
}

async function readBody(req, limit = maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('request_too_large');
      error.statusCode = 400;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    const error = new Error('json_required');
    error.statusCode = 400;
    throw error;
  }
  const raw = await readBody(req, 1024 * 1024);
  try { return JSON.parse(raw.toString('utf8')); } catch {
    const error = new Error('invalid_json');
    error.statusCode = 400;
    throw error;
  }
}

function validateIntegration(body) {
  const id = String(body.id || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const publicPath = String(body.publicPath || '').trim();
  const method = String(body.method || 'POST').toUpperCase();
  const upstreamUrl = String(body.upstreamUrl || '').trim();
  const authType = String(body.authType || 'bearer');
  const authHeader = String(body.authHeader || 'authorization').trim().toLowerCase();
  const authPrefix = String(body.authPrefix ?? (authType === 'bearer' ? 'Bearer ' : ''));
  const adapter = String(body.adapter || 'passthrough');
  const acceptedContentTypes = Array.isArray(body.acceptedContentTypes) ? body.acceptedContentTypes.map(String).filter(Boolean) : [];
  const documentedStatuses = Array.isArray(body.documentedStatuses) ? body.documentedStatuses.map(Number).filter((value) => Number.isInteger(value) && value >= 100 && value <= 599) : [];

  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) throw new Error('Integration ID must use lowercase letters, numbers, and hyphens.');
  if (name.length < 3 || name.length > 100) throw new Error('Display name must be between 3 and 100 characters.');
  if (!/^\/service\/[a-z0-9_/-]+$/.test(publicPath)) throw new Error('Public path must start with /service/ and use URL-safe characters.');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported HTTP method.');
  let parsedUpstream;
  try { parsedUpstream = new URL(upstreamUrl); } catch { throw new Error('Upstream URL is invalid.'); }
  if (parsedUpstream.protocol !== 'https:' && process.env.NODE_ENV !== 'test') throw new Error('Upstream URL must use HTTPS.');
  if (!['bearer', 'header', 'none'].includes(authType)) throw new Error('Authentication type is invalid.');
  if (authType !== 'none' && !/^[a-z0-9-]{2,64}$/.test(authHeader)) throw new Error('Authentication header is invalid.');
  if (!['passthrough', 'encrypted-json-relay'].includes(adapter)) throw new Error('Protocol adapter is invalid.');
  if (adapter === 'encrypted-json-relay' && (method !== 'POST' || !acceptedContentTypes.includes('application/json'))) {
    throw new Error('Encrypted JSON relay integrations must accept JSON over POST.');
  }

  return { id, name, publicPath, method, upstreamUrl, authType, authHeader, authPrefix, adapter, acceptedContentTypes, documentedStatuses, enabled: body.enabled !== false };
}

function forwardHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (!headers.accept) headers.accept = 'application/json';
  return headers;
}

function providerUnavailable(res) {
  return json(res, 500, { status: 'Error', error: 'The service is temporarily unavailable. Please try again shortly.' });
}

function responseBytes(res, status, body, contentType = 'application/json; charset=utf-8') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'content-type': contentType, 'content-length': payload.length, 'cache-control': 'no-store' });
  res.end(payload);
}

function parseJsonText(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function encryptedValue(text, field) {
  const parsed = parseJsonText(text);
  if (typeof parsed === 'string' && parsed) return parsed;
  if (parsed && typeof parsed[field] === 'string' && parsed[field]) return parsed[field];
  const trimmed = text.trim();
  return trimmed && parsed === null ? trimmed : '';
}

async function encryptedJsonRelay(res, integration, store, fetchImpl, body) {
  const credential = await store.getMasterKey(integration.id);
  if (!credential) return providerUnavailable(res);

  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    [integration.authHeader]: `${integration.authPrefix || ''}${credential}`
  };
  const timeout = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
  const verificationUrl = new URL(integration.upstreamUrl);
  const encryptUrl = new URL('/v1/apicall/encrypt', verificationUrl.origin);
  const decryptUrl = new URL('/v1/apicall/decrypt', verificationUrl.origin);

  const encryptResponse = await fetchImpl(encryptUrl, {
    method: 'POST', headers, body, signal: AbortSignal.timeout(timeout)
  });
  if (!encryptResponse.ok) return providerUnavailable(res);
  const encryptedRequest = encryptedValue(await encryptResponse.text(), 'requestData');
  if (!encryptedRequest) return providerUnavailable(res);

  const verificationResponse = await fetchImpl(verificationUrl, {
    method: 'POST', headers, body: JSON.stringify({ requestData: encryptedRequest }), signal: AbortSignal.timeout(timeout)
  });
  const verificationText = await verificationResponse.text();
  const encryptedResponse = encryptedValue(verificationText, 'responseData');
  if (!encryptedResponse) {
    return responseBytes(res, verificationResponse.status, verificationText, verificationResponse.headers.get('content-type') || 'application/json; charset=utf-8');
  }

  const decryptResponse = await fetchImpl(decryptUrl, {
    method: 'POST', headers, body: JSON.stringify({ responseData: encryptedResponse }), signal: AbortSignal.timeout(timeout)
  });
  if (!decryptResponse.ok) return providerUnavailable(res);
  const decryptedBody = Buffer.from(await decryptResponse.arrayBuffer());
  return responseBytes(res, verificationResponse.status, decryptedBody, decryptResponse.headers.get('content-type') || 'application/json; charset=utf-8');
}

async function proxyIntegration(req, res, url, integration, store, fetchImpl) {
  if (!(await store.isClientKey(bearerToken(req)))) {
    return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  }

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (integration.acceptedContentTypes?.length && !integration.acceptedContentTypes.some((type) => contentType.startsWith(type))) {
    return json(res, 400, { status: 'Error', error: `Content-Type must be one of: ${integration.acceptedContentTypes.join(', ')}.` });
  }

  let body;
  if (!['GET', 'HEAD'].includes(req.method)) {
    try { body = await readBody(req); } catch (error) {
      if (error.statusCode === 400) return json(res, 400, { status: 'Error', error: 'The request body is too large.' });
      throw error;
    }
  }

  try {
    if (integration.adapter === 'encrypted-json-relay') {
      if (!contentType.startsWith('application/json')) return json(res, 400, { status: 'Error', error: 'Content-Type must be application/json.' });
      const parsedBody = parseJsonText(body.toString('utf8'));
      if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) return json(res, 400, { status: 'Error', error: 'The request body must contain a valid JSON object.' });
      if (integration.id === 'iban-verification') body = Buffer.from(JSON.stringify({ ...parsedBody, docType: 610 }));
      return await encryptedJsonRelay(res, integration, store, fetchImpl, body);
    }

    const target = new URL(integration.upstreamUrl);
    target.search = url.search;
    const headers = forwardHeaders(req);
    if (integration.authType !== 'none') {
      const masterKey = await store.getMasterKey(integration.id);
      if (!masterKey) return providerUnavailable(res);
      headers[integration.authHeader] = `${integration.authPrefix || ''}${masterKey}`;
    }
    const upstream = await fetchImpl(target, {
      method: integration.method,
      headers,
      body,
      signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS || 120000))
    });
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'content-length': responseBody.length,
      'cache-control': 'no-store'
    });
    res.end(responseBody);
  } catch {
    providerUnavailable(res);
  }
}

async function requireAdmin(req, res, store) {
  if (await store.isAdminKey(bearerToken(req))) return true;
  json(res, 401, { status: 'Error', error: 'Admin key is missing or incorrect.' });
  return false;
}

async function handleAdminApi(req, res, url, store) {
  if (!(await requireAdmin(req, res, store))) return;

  if (req.method === 'GET' && url.pathname === '/admin/api/integrations') {
    return json(res, 200, { integrations: await store.listIntegrations() });
  }

  if (req.method === 'PUT' && /^\/admin\/api\/integrations\/[a-z0-9-]+$/.test(url.pathname)) {
    try {
      const body = await readJson(req);
      const pathId = url.pathname.split('/').pop();
      const integration = validateIntegration({ ...body, id: pathId });
      const saved = await store.upsertIntegration(integration, String(body.masterAuthKey || ''));
      return json(res, 200, { integration: saved });
    } catch (error) {
      return json(res, error.statusCode || 400, { status: 'Error', error: error.statusCode ? 'The request is invalid.' : error.message });
    }
  }

  if (req.method === 'PUT' && /^\/admin\/api\/integrations\/[a-z0-9-]+\/credential$/.test(url.pathname)) {
    try {
      const body = await readJson(req);
      const integrationId = url.pathname.split('/')[4];
      const credential = String(body.credential || '');
      if (!credential) return json(res, 400, { status: 'Error', error: 'A private credential is required.' });
      const saved = await store.setMasterKey(integrationId, credential);
      return saved ? json(res, 200, { integration: saved }) : json(res, 404, { status: 'Error', error: 'Integration was not found.' });
    } catch (error) {
      return json(res, error.statusCode || 500, { status: 'Error', error: error.statusCode ? 'The request is invalid.' : 'The private credential could not be saved.' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/clients') {
    return json(res, 200, { clients: await store.listClients() });
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/clients') {
    try {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      if (name.length < 2 || name.length > 100) return json(res, 400, { status: 'Error', error: 'Client name must be between 2 and 100 characters.' });
      const created = await store.createClient(name);
      return json(res, 201, { ...created, notice: 'Copy this API key now. It will not be shown again.' });
    } catch (error) {
      return json(res, error.statusCode || 500, { status: 'Error', error: error.statusCode ? 'The request is invalid.' : 'The client credential could not be created.' });
    }
  }

  if (req.method === 'POST' && /^\/admin\/api\/clients\/[a-f0-9]+\/revoke$/.test(url.pathname)) {
    const id = url.pathname.split('/')[4];
    const client = await store.revokeClient(id);
    return client ? json(res, 200, { client }) : json(res, 404, { status: 'Error', error: 'Client was not found.' });
  }

  json(res, 404, { status: 'Error', error: 'Admin operation was not found.' });
}

function safeAssetPath(directory, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const wanted = decoded === '/' ? '/index.html' : decoded;
  const candidate = normalize(join(directory, wanted));
  return candidate.startsWith(directory) ? candidate : null;
}

function serveStatic(res, directory, requestPath) {
  let filePath = safeAssetPath(directory, requestPath);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(directory, 'index.html');
  const stat = statSync(filePath);
  res.writeHead(200, { 'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-cache' });
  createReadStream(filePath).pipe(res);
}

export function createAppServer({ store = createStore(), fetchImpl = fetch } = {}) {
  return createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url || '/', 'http://localhost');
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();

    try {
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('ok\n');
      }
      if (url.pathname.startsWith('/admin/api/')) return handleAdminApi(req, res, url, store);
      if (url.pathname === '/admin' || url.pathname === '/admin/') return serveStatic(res, join(root, 'admin-site'), '/');
      if (url.pathname.startsWith('/admin/')) return serveStatic(res, join(root, 'admin-site'), url.pathname.replace(/^\/admin/, '') || '/');
      if (url.pathname === '/catalog.json') return json(res, 200, { integrations: await store.listIntegrations({ publicOnly: true }) }, { 'cache-control': 'public, max-age=60' });
      if (url.pathname === '/openapi.json') {
        const spec = readFileSync(join(root, 'api', 'openapi.json'));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': spec.length, 'cache-control': 'public, max-age=300' });
        return res.end(spec);
      }

      const integration = await store.getIntegration(url.pathname, req.method || 'GET');
      if (integration) return proxyIntegration(req, res, url, integration, store, fetchImpl);
      if (url.pathname.startsWith('/service/')) return json(res, 404, { status: 'Error', error: 'Service was not found.' });

      const directory = apiHosts.has(host) || url.pathname.startsWith('/docs') ? join(root, 'api-site') : join(root, 'site');
      if (directory.endsWith('api-site') && (url.pathname === '/iban' || url.pathname === '/iban/')) return serveStatic(res, directory, '/iban.html');
      if (directory.endsWith('api-site') && (url.pathname === '/entity-search' || url.pathname === '/entity-search/')) return serveStatic(res, directory, '/entity-search.html');
      return serveStatic(res, directory, url.pathname.replace(/^\/docs/, '') || '/');
    } catch {
      return json(res, 500, { status: 'Error', error: 'The service is temporarily unavailable. Please try again shortly.' });
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  createAppServer().listen(port, '0.0.0.0', () => console.log(`AI7 UAE service listening on port ${port}`));
}
