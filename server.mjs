import { createReadStream, readFileSync, existsSync, statSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/api-store.mjs';
import { createEntitySearchAuditPdf } from './lib/entity-search-report.mjs';
import { adverseMediaConfig, screenAdverseMedia, validateAdverseMediaRequest } from './lib/adverse-media.mjs';

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

async function readJson(req, limit = 1024 * 1024) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    const error = new Error('json_required');
    error.statusCode = 400;
    throw error;
  }
  const raw = await readBody(req, limit);
  try { return JSON.parse(raw.toString('utf8')); } catch {
    const error = new Error('invalid_json');
    error.statusCode = 400;
    throw error;
  }
}

function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized);
  }
  return true;
}

async function fetchPublicLogo(rawUrl) {
  if (!rawUrl) return {};
  let logoUrl;
  try { logoUrl = new URL(String(rawUrl)); } catch { return {}; }
  if (logoUrl.protocol !== 'https:' || logoUrl.username || logoUrl.password || (logoUrl.port && logoUrl.port !== '443')) return {};
  try {
    const addresses = await lookup(logoUrl.hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) return {};
    const pinned = addresses[0];
    return await new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      const request = httpsGet(logoUrl, {
        timeout: 5000,
        headers: { accept: 'image/png,image/jpeg' },
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        }
      }, (response) => {
        const logoType = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
        const declaredSize = Number(response.headers['content-length'] || 0);
        if (response.statusCode !== 200 || !['image/png', 'image/jpeg', 'image/jpg'].includes(logoType) || declaredSize > 2 * 1024 * 1024) {
          response.resume();
          return done({});
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) { request.destroy(); return done({}); }
          chunks.push(chunk);
        });
        response.on('end', () => done({ logoBytes: Buffer.concat(chunks), logoType }));
        response.on('error', () => done({}));
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => done({}));
    });
  } catch { return {}; }
}

function reportFilename(name) {
  const slug = String(name || 'entity').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'entity';
  return `ai7-entity-search-${slug}-${new Date().toISOString().slice(0, 10)}.pdf`;
}

async function createEntitySearchReport(req, res, store) {
  if (!(await store.isClientKey(bearerToken(req)))) {
    return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  }
  try {
    const body = await readJson(req, 10 * 1024 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !body.request || !Object.hasOwn(body, 'response')) {
      return json(res, 400, { status: 'Error', error: 'A request and response are required to create the audit PDF.' });
    }
    const logo = await fetchPublicLogo(String(body.logoUrl || '').slice(0, 2048));
    const report = await createEntitySearchAuditPdf({
      request: body.request,
      response: body.response,
      httpStatus: Number(body.httpStatus) || 0,
      completedAt: body.completedAt,
      ...logo
    });
    const filename = reportFilename(body.request.name);
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': report.bytes.length,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-ai7-report-id': report.reportId
    });
    res.end(report.bytes);
  } catch (error) {
    if (error.statusCode === 400) return json(res, 400, { status: 'Error', error: 'The report request is too large or invalid.' });
    return json(res, 500, { status: 'Error', error: 'The audit PDF could not be created.' });
  }
}

async function createAdverseMediaScreening(req, res, store, fetchImpl) {
  if (!(await store.isClientKey(bearerToken(req)))) {
    return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  }
  try {
    const input = await readJson(req);
    const request = validateAdverseMediaRequest(input);
    const providerKey = await store.getMasterKey('adverse-media');
    if (!providerKey) return providerUnavailable(res);
    const result = await screenAdverseMedia({ request, apiKey: providerKey, fetchImpl });
    return json(res, 200, result);
  } catch (error) {
    if (error.statusCode === 400 || (!error.statusCode && error.message !== 'search_provider_unavailable')) {
      return json(res, 400, { status: 'Error', error: error.message || 'The request is invalid.' });
    }
    return json(res, 502, { status: 'Error', error: 'The media search service is temporarily unavailable. Please try again shortly.' });
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

    if (integration.id === 'entity-search' && contentType.startsWith('application/json')) {
      const parsedBody = parseJsonText(body.toString('utf8'));
      if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
        body = Buffer.from(JSON.stringify({ country: '', gender: '', dob: '', ...parsedBody }));
      }
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
      if (req.method === 'POST' && url.pathname === '/reports/entity-search.pdf') return createEntitySearchReport(req, res, store);
      if (req.method === 'POST' && url.pathname === '/service/adverse_media') return createAdverseMediaScreening(req, res, store, fetchImpl);
      if (req.method === 'GET' && url.pathname === '/service/adverse_media/config') {
        return json(res, 200, {
          supported_languages: adverseMediaConfig.supportedLanguages,
          maximum_languages: adverseMediaConfig.maxLanguages,
          maximum_paid_queries: adverseMediaConfig.maxPaidQueries,
          cost_guardrail_usd: 0.12
        }, { 'cache-control': 'public, max-age=3600' });
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
      if (directory.endsWith('api-site') && (url.pathname === '/adverse-media' || url.pathname === '/adverse-media/')) return serveStatic(res, directory, '/adverse-media.html');
      return serveStatic(res, directory, url.pathname.replace(/^\/docs/, '') || '/');
    } catch {
      return json(res, 500, { status: 'Error', error: 'The service is temporarily unavailable. Please try again shortly.' });
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  createAppServer().listen(port, '0.0.0.0', () => console.log(`AI7 UAE service listening on port ${port}`));
}
