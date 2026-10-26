import { createReadStream, readFileSync, existsSync, statSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/api-store.mjs';
import { createEntitySearchAuditPdf } from './lib/entity-search-report.mjs';
import { adverseMediaConfig, presentAdverseMediaResponse, screenAdverseMedia, validateAdverseMediaRequest } from './lib/adverse-media.mjs';
import { createDeepResearchQueue, makeDeepResearchJob, startDeepResearchWorker, validatePublicCallbackUrl } from './lib/deep-research-queue.mjs';
import { createAdverseMediaAuditPdf, createAdverseMediaNarrative } from './lib/adverse-media-report.mjs';
import { createAdverseMediaReportStore, reportOwnerId } from './lib/adverse-media-report-store.mjs';
import { merchantScreenshotAssets, screenMerchantWebsite, validateMerchantScreeningRequest } from './lib/merchant-screening.mjs';
import { createMerchantScreeningAuditPdf } from './lib/merchant-screening-report.mjs';
import { createScreeningCostGuard } from './lib/screening-cost-guard.mjs';
import { publicFormDefinition, resolveFormServiceInput, validateFormDefinition, validateFormSubmission } from './lib/forms.mjs';
import { createFormsQueue, makeFormsJob, startFormsWorker, validateFormsCallbackUrl } from './lib/forms-queue.mjs';
import { createFormsAuditPdf } from './lib/forms-report.mjs';
import {
  ADMIN_COOKIE, adminCookie, clearAdminCookie, createAdminAccount, createAdminSession,
  newSigningKey, parseCookies, safeAdminAccount, verifyAdminPassword, verifyAdminSession
} from './lib/admin-auth.mjs';

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

function requestOrigin(req) {
  const candidates = [req.headers['x-envoy-external-address'], req.headers['x-azure-clientip']]
    .map((value) => String(value || '').trim()).filter(Boolean);
  candidates.push(...String(req.headers['x-forwarded-for'] || '').split(',').map((value) => value.trim()).filter(Boolean));
  candidates.push(String(req.socket?.remoteAddress || '').replace(/^::ffff:/, ''));
  const networkOrigin = candidates.find((address) => isIP(address) && !isPrivateAddress(address));
  return {
    received_at: new Date().toISOString(),
    network_origin: networkOrigin || 'Unavailable (private or internal network)',
    processing_location: process.env.AZURE_REGION_DISPLAY || 'Microsoft Azure UAE North'
  };
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

async function finalizeAdverseMediaReport({ request, response, ownerId, origin, aiApiKey, fetchImpl, reportStore }) {
  try {
    const logo = await fetchPublicLogo(request.customer_logo_url);
    const narrative = await createAdverseMediaNarrative({ response, apiKey: aiApiKey, fetchImpl });
    const report = await createAdverseMediaAuditPdf({ request, response, narrative, origin, ...logo });
    const reportPath = `/service/adverse_media/reports/${report.reportId}.pdf`;
    const metadata = {
      report_id: report.reportId,
      transaction_id: response.screening_id,
      generated_at: report.generatedAt,
      download_url: process.env.API_PUBLIC_BASE_URL ? new URL(reportPath, process.env.API_PUBLIC_BASE_URL).href : reportPath,
      sha256: report.sha256,
      filename: report.filename,
      retention: 'permanent'
    };
    await reportStore.save({ ownerId, reportId: report.reportId, bytes: report.bytes, metadata: { ...metadata, report_type: 'adverse_media' } });
    return { ...response, report: metadata };
  } catch {
    const error = new Error('report_service_unavailable');
    error.statusCode = 503;
    throw error;
  }
}

async function createAdverseMediaScreening(req, res, store, fetchImpl, deepResearchQueue, reportStore) {
  const token = bearerToken(req);
  if (!(await store.isClientKey(token))) {
    return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  }
  try {
    const input = await readJson(req);
    const request = validateAdverseMediaRequest(input);
    if (request.deep_research && request.callback_url) {
      if (!deepResearchQueue) return json(res, 503, { status: 'Error', error: 'Deep research callback processing is temporarily unavailable.' });
      await validatePublicCallbackUrl(request.callback_url);
      const job = makeDeepResearchJob(request, { owner_id: reportOwnerId(token), request_origin: requestOrigin(req) });
      await deepResearchQueue.enqueue(job);
      return json(res, 202, {
        screening_id: job.screening_id,
        status: 'queued',
        deep_research: true,
        callback: {
          configured: true,
          event: 'adverse_media.deep_research.completed',
          signature_header: 'x-ai7-signature',
          signing_secret: job.callback_secret
        },
        message: 'The final screening result will be posted to the callback URL. Check data.status, data.summary.decision_eligible, and data.coverage before use. Store the signing secret now; it is not shown again.'
      });
    }
    const providerKey = await store.getMasterKey('adverse-media');
    if (!providerKey) return providerUnavailable(res);
    const aiApiKey = await store.getMasterKey('adverse-media-ai');
    const costGuard = createScreeningCostGuard(fetchImpl);
    const result = await screenAdverseMedia({ request, apiKey: providerKey, aiApiKey, fetchImpl, costGuard });
    const response = await finalizeAdverseMediaReport({
      request,
      response: presentAdverseMediaResponse(result),
      ownerId: reportOwnerId(token),
      origin: requestOrigin(req),
      aiApiKey,
      fetchImpl: costGuard.fetch,
      reportStore
    });
    return json(res, 200, response);
  } catch (error) {
    if (error.statusCode === 400 || (!error.statusCode && error.message !== 'search_provider_unavailable')) {
      return json(res, 400, { status: 'Error', error: error.message || 'The request is invalid.' });
    }
    if (String(error.message || '').startsWith('report_') || /Blob|Table|storage/i.test(String(error.message || ''))) {
      return json(res, 503, { status: 'Error', error: 'The screening report service is temporarily unavailable. Please try again shortly.' });
    }
    return json(res, 502, { status: 'Error', error: 'The media search service is temporarily unavailable. Please try again shortly.' });
  }
}

async function finalizeMerchantScreeningReport({ request, response, ownerId, origin, reportStore, screenshots }) {
  try {
    const logo = await fetchPublicLogo(request.customer_logo_url);
    const report = await createMerchantScreeningAuditPdf({ request, response, origin, screenshots, ...logo });
    const reportPath = `/service/merchant_screening/reports/${report.reportId}.pdf`;
    const metadata = {
      report_id: report.reportId,
      transaction_id: response.screening_id,
      generated_at: report.generatedAt,
      download_url: process.env.API_PUBLIC_BASE_URL ? new URL(reportPath, process.env.API_PUBLIC_BASE_URL).href : reportPath,
      sha256: report.sha256,
      filename: report.filename,
      retention: 'permanent'
    };
    await reportStore.save({ ownerId, reportId: report.reportId, bytes: report.bytes, metadata: { ...metadata, report_type: 'merchant_screening' } });
    return { ...response, report: metadata };
  } catch {
    const error = new Error('merchant_report_service_unavailable');
    error.statusCode = 503;
    throw error;
  }
}

async function createMerchantScreening(req, res, store, merchantScreener, reportStore) {
  const token = bearerToken(req);
  if (!(await store.isClientKey(token))) {
    return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  }
  try {
    const input = await readJson(req);
    const validation = validateMerchantScreeningRequest(input);
    if (validation.error) return json(res, 400, { status: 'Error', error: validation.error });
    const result = await merchantScreener(validation.value);
    const response = validation.value.get_pdf
      ? await finalizeMerchantScreeningReport({
        request: validation.value,
        response: result,
        ownerId: reportOwnerId(token),
        origin: requestOrigin(req),
        reportStore,
        screenshots: result[merchantScreenshotAssets] || []
      })
      : result;
    return json(res, 200, response);
  } catch (error) {
    if (error.statusCode === 400 || ['json_required', 'invalid_json', 'request_too_large'].includes(error.message)) {
      return json(res, 400, { status: 'Error', error: 'The request body must contain a valid JSON object.' });
    }
    if (['crawl_disallowed_by_robots', 'website_unavailable', 'request_timeout', 'destination_is_not_public'].includes(error.message)
      || String(error.message || '').startsWith('http_')) {
      return json(res, 502, { status: 'Error', error: 'The merchant website could not be collected safely.' });
    }
    if (String(error.message || '').startsWith('merchant_report_') || /Blob|Table|storage/i.test(String(error.message || ''))) {
      return json(res, 503, { status: 'Error', error: 'The merchant screening report service is temporarily unavailable. Please try again shortly.' });
    }
    return json(res, 503, { status: 'Error', error: 'Merchant screening is temporarily unavailable.' });
  }
}

async function configuredMerchantScreener(request) {
  if (process.env.MERCHANT_SCREENSHOT_WORKER_URL) {
    const screenshotProvider = async (screeningRequest, collection) => {
      const endpoint = new URL('/capture', process.env.MERCHANT_SCREENSHOT_WORKER_URL);
      const upstream = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(90_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request: screeningRequest,
          pages: collection.pages.slice(0, screeningRequest.max_pages).map((page) => ({
            url: page.url,
            body: String(page.body || '').slice(0, 20_000)
          }))
        })
      });
      if (!upstream.ok) throw new Error('screenshot_worker_unavailable');
      const result = await upstream.json();
      return {
        ...result,
        provider: 'ai7_rendered_capture',
        local_only: false,
        items: (result.items || []).map(({ image_base64, ...item }) => ({ ...item, __image_base64: image_base64 }))
      };
    };
    return screenMerchantWebsite(request, { screenshotProvider });
  }
  if (process.env.MERCHANT_SCREENSHOT_MODE !== 'local') return screenMerchantWebsite(request);
  if (process.env.NODE_ENV === 'production') throw new Error('local_screenshot_provider_disabled_in_production');
  const { captureMerchantScreenshots } = await import('./lib/merchant-screenshot.mjs');
  return screenMerchantWebsite(request, { screenshotProvider: captureMerchantScreenshots });
}

async function downloadLocalMerchantScreenshot(req, res, store, batchId, filename) {
  if (process.env.MERCHANT_SCREENSHOT_MODE !== 'local' || process.env.NODE_ENV === 'production') {
    return json(res, 404, { status: 'Error', error: 'Screenshot was not found.' });
  }
  if (!(await store.isClientKey(bearerToken(req)))) {
    return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  }
  const outputRoot = process.env.MERCHANT_SCREENSHOT_OUTPUT_DIR || join(tmpdir(), 'ai7-merchant-screenshots');
  const screenshotPath = join(outputRoot, batchId, filename);
  if (!existsSync(screenshotPath) || !statSync(screenshotPath).isFile()) {
    return json(res, 404, { status: 'Error', error: 'Screenshot was not found.' });
  }
  const stat = statSync(screenshotPath);
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': stat.size,
    'content-disposition': `inline; filename="${filename}"`,
    'cache-control': 'private, no-store'
  });
  return createReadStream(screenshotPath).pipe(res);
}

async function downloadPublicScreeningReport(res, reportStore, reportId, expectedType) {
  try {
    const report = await reportStore.getPublic({ reportId });
    if (!report) return json(res, 404, { status: 'Error', error: 'The report was not found.' });
    const actualType = report.metadata.report_type;
    const typeMatches = expectedType === 'adverse_media'
      ? !actualType || actualType === expectedType
      : actualType === expectedType;
    if (!typeMatches) return json(res, 404, { status: 'Error', error: 'The report was not found.' });
    const fallback = expectedType === 'merchant_screening'
      ? 'ai7-merchant-screening'
      : expectedType === 'forms' ? 'ai7-forms' : 'ai7-adverse-media';
    const filename = String(report.metadata.filename || `${fallback}-${reportId}.pdf`).replace(/[^a-zA-Z0-9._-]/g, '-');
    res.writeHead(200, {
      'content-type': 'application/pdf', 'content-length': report.bytes.length,
      'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; sandbox", 'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'x-ai7-report-id': reportId, 'x-content-sha256': report.metadata.sha256
    });
    return res.end(report.bytes);
  } catch {
    return json(res, 503, { status: 'Error', error: 'The screening report service is temporarily unavailable. Please try again shortly.' });
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

async function executeEncryptedJsonIntegration(integration, store, fetchImpl, body) {
  const credential = await store.getMasterKey(integration.id);
  if (!credential) throw new Error('provider_credentials_unavailable');

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
  if (!encryptResponse.ok) throw new Error('provider_encryption_unavailable');
  const encryptedRequest = encryptedValue(await encryptResponse.text(), 'requestData');
  if (!encryptedRequest) throw new Error('provider_encryption_invalid');

  const verificationResponse = await fetchImpl(verificationUrl, {
    method: 'POST', headers, body: JSON.stringify({ requestData: encryptedRequest }), signal: AbortSignal.timeout(timeout)
  });
  const verificationText = await verificationResponse.text();
  const encryptedResponse = encryptedValue(verificationText, 'responseData');
  if (!encryptedResponse) {
    return {
      status: verificationResponse.status,
      body: Buffer.from(verificationText),
      contentType: verificationResponse.headers.get('content-type') || 'application/json; charset=utf-8'
    };
  }

  const decryptResponse = await fetchImpl(decryptUrl, {
    method: 'POST', headers, body: JSON.stringify({ responseData: encryptedResponse }), signal: AbortSignal.timeout(timeout)
  });
  if (!decryptResponse.ok) throw new Error('provider_decryption_unavailable');
  const decryptedBody = Buffer.from(await decryptResponse.arrayBuffer());
  return {
    status: verificationResponse.status,
    body: decryptedBody,
    contentType: decryptResponse.headers.get('content-type') || 'application/json; charset=utf-8'
  };
}

async function encryptedJsonRelay(res, integration, store, fetchImpl, body) {
  try {
    const result = await executeEncryptedJsonIntegration(integration, store, fetchImpl, body);
    return responseBytes(res, result.status, result.body, result.contentType);
  } catch {
    return providerUnavailable(res);
  }
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

function formsIbanTransactionId(submissionId) {
  const stableId = String(submissionId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 48);
  if (!stableId) throw new Error('form_submission_id_required');
  return `AI7F-${stableId}`;
}

async function executeProviderFormService(integration, input, store, fetchImpl, { submissionId } = {}) {
  let requestBody = input;
  if (integration.id === 'iban-verification') {
    requestBody = {
      ...requestBody,
      source: 'API',
      transID: formsIbanTransactionId(submissionId),
      docType: 610,
      requestCategory: 'business'
    };
  }
  if (integration.id === 'entity-search') requestBody = { country: '', gender: '', dob: '', ...requestBody };
  const body = Buffer.from(JSON.stringify(requestBody));
  if (integration.adapter === 'encrypted-json-relay') {
    const result = await executeEncryptedJsonIntegration(integration, store, fetchImpl, body);
    const stringBody = result.body.toString('utf8');
    return { httpStatus: result.status, response: parseJsonText(stringBody) ?? { raw_response: stringBody } };
  }
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (integration.authType !== 'none') {
    const masterKey = await store.getMasterKey(integration.id);
    if (!masterKey) throw new Error('provider_credentials_unavailable');
    headers[integration.authHeader] = `${integration.authPrefix || ''}${masterKey}`;
  }
  const upstream = await fetchImpl(new URL(integration.upstreamUrl), {
    method: integration.method,
    headers,
    body: ['GET', 'HEAD'].includes(integration.method) ? undefined : body,
    signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS || 120000))
  });
  const raw = Buffer.from(await upstream.arrayBuffer()).toString('utf8');
  return { httpStatus: upstream.status, response: parseJsonText(raw) ?? { raw_response: raw } };
}

async function executeSingleFormService({ service, data, submissionId, store, fetchImpl, merchantScreener }) {
  const integration = await store.getIntegrationById(service.service_id);
  const name = integration?.name || service.service_id;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  if (!integration) {
    return {
      service_id: service.service_id, name, status: 'failed', http_status: null,
      started_at: startedAt, completed_at: new Date().toISOString(), duration_ms: Date.now() - started,
      error: 'The configured API is disabled or unavailable.', response: null
    };
  }
  try {
    const input = resolveFormServiceInput(service, data);
    let httpStatus = 200;
    let response;
    if (integration.id === 'adverse-media') {
      const request = validateAdverseMediaRequest({ ...input, deep_research: false, callback_url: '' });
      const apiKey = await store.getMasterKey('adverse-media');
      if (!apiKey) throw new Error('provider_credentials_unavailable');
      const aiApiKey = await store.getMasterKey('adverse-media-ai');
      const costGuard = createScreeningCostGuard(fetchImpl);
      response = presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey, aiApiKey, fetchImpl, costGuard }));
    } else if (integration.id === 'merchant-screening') {
      const validation = validateMerchantScreeningRequest({ ...input, get_pdf: false, customer_logo_url: '' });
      if (validation.error) {
        httpStatus = 400;
        response = { status: 'Error', error: validation.error };
      } else response = await merchantScreener(validation.value);
    } else {
      const result = await executeProviderFormService(integration, input, store, fetchImpl, { submissionId });
      httpStatus = result.httpStatus;
      response = result.response;
    }
    const successful = httpStatus >= 200 && httpStatus < 300;
    return {
      service_id: integration.id,
      name,
      status: successful ? 'completed' : 'failed',
      http_status: httpStatus,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      ...(successful ? {} : { error: 'The API returned an unsuccessful status.' }),
      response
    };
  } catch {
    return {
      service_id: integration.id, name, status: 'failed', http_status: null,
      started_at: startedAt, completed_at: new Date().toISOString(), duration_ms: Date.now() - started,
      error: 'The API could not complete this check.', response: null
    };
  }
}

export async function executeFormsJob({ job, store, fetchImpl, merchantScreener = configuredMerchantScreener, reportStore }) {
  const startedAt = new Date().toISOString();
  const services = await Promise.all(job.form.services.map((service) => executeSingleFormService({
    service, data: job.data, submissionId: job.submission_id, store, fetchImpl, merchantScreener
  })));
  const completed = services.filter((service) => service.status === 'completed').length;
  const failed = services.length - completed;
  const status = completed === services.length ? 'completed' : completed > 0 ? 'partial' : 'failed';
  const completedAt = new Date().toISOString();
  const processingLog = [
    { at: job.queued_at, stage: 'accepted', message: 'Authenticated submission accepted and queued.' },
    { at: startedAt, stage: 'orchestration_started', message: `${services.length} configured API checks started.` },
    ...services.map((service) => ({
      at: service.completed_at,
      stage: service.status === 'completed' ? 'api_completed' : 'api_failed',
      message: `${service.name} finished with ${service.http_status || 'no'} HTTP status in ${service.duration_ms} ms.`
    })),
    { at: completedAt, stage: 'consolidated', message: `Consolidated result created with status ${status}.` }
  ];
  let result = {
    submission_id: job.submission_id,
    status,
    form: { id: job.form.id, name: job.form.name, version: job.form.version },
    summary: { total: services.length, completed, failed, decision_eligible: status === 'completed' },
    services,
    processing: {
      queued_at: job.queued_at,
      started_at: startedAt,
      request_origin: job.request_origin.network_origin,
      location: job.request_origin.processing_location,
      log: processingLog
    },
    completed_at: completedAt
  };
  const logo = await fetchPublicLogo(job.customer_logo_url);
  const report = await createFormsAuditPdf({ job, result, ...logo });
  const reportPath = `/service/forms/reports/${report.reportId}.pdf`;
  const metadata = {
    report_id: report.reportId,
    transaction_id: job.submission_id,
    generated_at: report.generatedAt,
    download_url: process.env.API_PUBLIC_BASE_URL ? new URL(reportPath, process.env.API_PUBLIC_BASE_URL).href : reportPath,
    sha256: report.sha256,
    filename: report.filename,
    retention: 'permanent'
  };
  await reportStore.save({ ownerId: job.owner_id, reportId: report.reportId, bytes: report.bytes, metadata: { ...metadata, report_type: 'forms' } });
  result = { ...result, report: metadata };
  return result;
}

async function submitForm(req, res, formId, store, formsQueue) {
  const token = bearerToken(req);
  if (!(await store.isClientKey(token))) return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  if (!formsQueue) return json(res, 503, { status: 'Error', error: 'Forms processing is temporarily unavailable.' });
  const form = await store.getForm(formId);
  if (!form || !form.enabled) return json(res, 404, { status: 'Error', error: 'Form was not found.' });
  let job;
  try {
    const submission = validateFormSubmission(form, await readJson(req, 64 * 1024));
    await validateFormsCallbackUrl(submission.callback_url);
    if (submission.customer_logo_url) await validateFormsCallbackUrl(submission.customer_logo_url);
    job = makeFormsJob({
      form,
      submission,
      ownerId: reportOwnerId(token),
      origin: requestOrigin(req)
    });
  } catch (error) {
    const reason = String(error.message || '');
    if (reason === 'callback_url_required') return json(res, 400, { status: 'Error', error: 'A public HTTPS callback_url is required.' });
    if (reason.startsWith('callback_url_')) return json(res, 400, { status: 'Error', error: 'callback_url and customer_logo_url must be public HTTPS URLs.' });
    if (reason === 'form_submission_too_large') return json(res, 400, { status: 'Error', error: 'The mapped Form submission is too large for asynchronous processing.' });
    return json(res, 400, { status: 'Error', error: reason || 'The Form submission is invalid.' });
  }
  try {
    await formsQueue.enqueue(job);
  } catch {
    return json(res, 503, { status: 'Error', error: 'Forms processing is temporarily unavailable.' });
  }
  return json(res, 202, {
    submission_id: job.submission_id,
    status: 'queued',
    form: { id: form.id, name: form.name, version: form.version },
    callback: {
      configured: true,
      event: 'forms.submission.completed',
      signature_header: 'x-ai7-signature',
      delivery_id_header: 'x-ai7-delivery-id',
      signing_secret: job.callback_secret
    },
    message: 'The consolidated response and permanent PDF link will be posted to the callback URL. Store the signing secret now; it is not shown again.'
  });
}

function secureRequest(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  return forwarded === 'https' || !['localhost', '127.0.0.1', '::1'].includes(host);
}

function sameOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  try { return new URL(origin).host === String(req.headers.host || ''); } catch { return false; }
}

function createLoginThrottle() {
  const attempts = new Map();
  return {
    blocked(key) {
      const record = attempts.get(key);
      if (!record || record.until <= Date.now()) { attempts.delete(key); return false; }
      return record.count >= 5;
    },
    failed(key) {
      const record = attempts.get(key);
      attempts.set(key, record?.until > Date.now() ? { ...record, count: record.count + 1 } : { count: 1, until: Date.now() + 15 * 60 * 1000 });
    },
    clear(key) { attempts.delete(key); }
  };
}

function loginThrottleKey(req, email) {
  return `${requestOrigin(req).network_origin}:${String(email || '').trim().toLowerCase()}`;
}

async function currentAdminSession(req, store) {
  const account = await store.getAdminAccount();
  if (!account) return { account: null, session: null };
  const signingKey = await store.getAdminSessionKey();
  const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
  return { account, session: verifyAdminSession(token, account, signingKey) };
}

async function requireAdmin(req, res, store, { csrf = false } = {}) {
  const { account, session } = await currentAdminSession(req, store);
  if (!account) {
    if (await store.isAdminKey(bearerToken(req))) return { legacy: true };
    json(res, 401, { status: 'Error', error: 'Admin key is missing or incorrect.' });
    return null;
  }
  if (!session) {
    json(res, 401, { status: 'Error', error: 'Sign in to continue.' });
    return null;
  }
  if (csrf && (!sameOrigin(req) || String(req.headers['x-ai7-csrf'] || '') !== session.csrf)) {
    json(res, 403, { status: 'Error', error: 'The security token is missing or invalid. Sign in again.' });
    return null;
  }
  return { account, session };
}

async function handleAdminApi(req, res, url, store, loginThrottle) {
  if (req.method === 'GET' && url.pathname === '/admin/api/auth/status') {
    const account = await store.getAdminAccount();
    return json(res, 200, { configured: Boolean(account) });
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/auth/setup') {
    if (await store.getAdminAccount()) return json(res, 409, { status: 'Error', error: 'The administrator account is already configured.' });
    if (!(await store.isAdminKey(bearerToken(req)))) return json(res, 401, { status: 'Error', error: 'The one-time setup key is missing or incorrect.' });
    try {
      const body = await readJson(req);
      const account = createAdminAccount(body.email, body.password);
      const signingKey = newSigningKey();
      await store.setAdminSessionKey(signingKey);
      await store.setAdminAccount(account);
      const created = createAdminSession(account, signingKey);
      return json(res, 201, { account: safeAdminAccount(account), csrf_token: created.csrfToken, expires_in: created.expiresIn }, { 'set-cookie': adminCookie(created.token, { secure: secureRequest(req) }) });
    } catch (error) {
      return json(res, error.statusCode || 400, { status: 'Error', error: error.statusCode ? 'The request is invalid.' : error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/auth/login') {
    try {
      const body = await readJson(req);
      const key = loginThrottleKey(req, body.email);
      if (loginThrottle.blocked(key)) return json(res, 429, { status: 'Error', error: 'Too many sign-in attempts. Try again later.' });
      const account = await store.getAdminAccount();
      if (!verifyAdminPassword(account, body.email, body.password)) {
        loginThrottle.failed(key);
        return json(res, 401, { status: 'Error', error: 'Email or password is incorrect.' });
      }
      loginThrottle.clear(key);
      const signingKey = await store.getAdminSessionKey();
      const created = createAdminSession(account, signingKey);
      return json(res, 200, { account: safeAdminAccount(account), csrf_token: created.csrfToken, expires_in: created.expiresIn }, { 'set-cookie': adminCookie(created.token, { secure: secureRequest(req) }) });
    } catch (error) {
      return json(res, error.statusCode || 400, { status: 'Error', error: 'The sign-in request is invalid.' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/auth/session') {
    const access = await requireAdmin(req, res, store);
    if (!access || access.legacy) return access ? json(res, 200, { legacy_setup_required: true }) : undefined;
    return json(res, 200, { account: safeAdminAccount(access.account), csrf_token: access.session.csrf, expires_at: access.session.expires_at });
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/auth/logout') {
    const access = await requireAdmin(req, res, store, { csrf: true });
    if (!access) return;
    return json(res, 200, { signed_out: true }, { 'set-cookie': clearAdminCookie({ secure: secureRequest(req) }) });
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/auth/password') {
    const access = await requireAdmin(req, res, store, { csrf: true });
    if (!access || access.legacy) return access ? json(res, 409, { status: 'Error', error: 'Complete account setup first.' }) : undefined;
    try {
      const body = await readJson(req);
      if (!verifyAdminPassword(access.account, access.account.email, body.current_password)) return json(res, 401, { status: 'Error', error: 'Current password is incorrect.' });
      const account = createAdminAccount(access.account.email, body.new_password, access.account);
      await store.setAdminAccount(account);
      const signingKey = await store.getAdminSessionKey();
      const created = createAdminSession(account, signingKey);
      return json(res, 200, { account: safeAdminAccount(account), csrf_token: created.csrfToken, expires_in: created.expiresIn }, { 'set-cookie': adminCookie(created.token, { secure: secureRequest(req) }) });
    } catch (error) {
      return json(res, 400, { status: 'Error', error: error.message });
    }
  }

  const access = await requireAdmin(req, res, store, { csrf: !['GET', 'HEAD'].includes(req.method || 'GET') });
  if (!access) return;

  if (req.method === 'GET' && url.pathname === '/admin/api/integrations') {
    return json(res, 200, { integrations: await store.listIntegrations() });
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/forms') {
    return json(res, 200, { forms: await store.listForms() });
  }

  if (req.method === 'PUT' && /^\/admin\/api\/forms\/[a-z0-9-]+$/.test(url.pathname)) {
    try {
      const body = await readJson(req, 256 * 1024);
      const id = url.pathname.split('/').pop();
      const integrations = await store.listIntegrations({ publicOnly: true });
      const form = validateFormDefinition({ ...body, id }, integrations);
      return json(res, 200, { form: await store.upsertForm(form) });
    } catch (error) {
      return json(res, error.statusCode || 400, { status: 'Error', error: error.statusCode ? 'The request is invalid.' : error.message });
    }
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

export function createAppServer({ store = createStore(), fetchImpl = fetch, deepResearchQueue = createDeepResearchQueue(), formsQueue = createFormsQueue(), reportStore = createAdverseMediaReportStore(), merchantScreener = configuredMerchantScreener, startWorker = process.env.NODE_ENV !== 'test' } = {}) {
  const loginThrottle = createLoginThrottle();
  if (startWorker && deepResearchQueue) {
    startDeepResearchWorker({
      queue: deepResearchQueue,
      store,
      screen: screenAdverseMedia,
      present: presentAdverseMediaResponse,
      finalize: async ({ job, response, aiApiKey, costGuard }) => finalizeAdverseMediaReport({
        request: job.request, response, ownerId: job.owner_id, origin: job.request_origin,
        aiApiKey, fetchImpl: costGuard.fetch, reportStore
      }),
      fetchImpl
    });
  }
  if (startWorker && formsQueue) {
    startFormsWorker({
      queue: formsQueue,
      execute: (job) => executeFormsJob({ job, store, fetchImpl, merchantScreener, reportStore }),
      resultStore: reportStore
    });
  }
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
      if (req.method === 'POST' && url.pathname === '/service/adverse_media') return createAdverseMediaScreening(req, res, store, fetchImpl, deepResearchQueue, reportStore);
      if (req.method === 'POST' && url.pathname === '/service/merchant_screening') return createMerchantScreening(req, res, store, merchantScreener, reportStore);
      const formSubmissionMatch = /^\/forms\/([a-z0-9-]+)\/submissions$/.exec(url.pathname);
      if (req.method === 'POST' && formSubmissionMatch) return submitForm(req, res, formSubmissionMatch[1], store, formsQueue);
      const formSchemaMatch = /^\/forms\/([a-z0-9-]+)\/schema$/.exec(url.pathname);
      if (req.method === 'GET' && formSchemaMatch) {
        const form = await store.getForm(formSchemaMatch[1]);
        if (!form || !form.enabled) return json(res, 404, { status: 'Error', error: 'Form was not found.' });
        return json(res, 200, { form: publicFormDefinition(form, await store.listIntegrations({ publicOnly: true })) }, { 'cache-control': 'public, max-age=60' });
      }
      const merchantScreenshotMatch = /^\/service\/merchant_screening\/screenshots\/([0-9a-f-]{36})\/([a-z0-9-]{1,128}\.png)$/i.exec(url.pathname);
      if (req.method === 'GET' && merchantScreenshotMatch) {
        return downloadLocalMerchantScreenshot(req, res, store, merchantScreenshotMatch[1], merchantScreenshotMatch[2]);
      }
      const adverseReportMatch = /^\/service\/adverse_media\/reports\/([0-9a-f-]{36})\.pdf$/i.exec(url.pathname);
      if (req.method === 'GET' && adverseReportMatch) return downloadPublicScreeningReport(res, reportStore, adverseReportMatch[1], 'adverse_media');
      const merchantReportMatch = /^\/service\/merchant_screening\/reports\/([0-9a-f-]{36})\.pdf$/i.exec(url.pathname);
      if (req.method === 'GET' && merchantReportMatch) return downloadPublicScreeningReport(res, reportStore, merchantReportMatch[1], 'merchant_screening');
      const formsReportMatch = /^\/service\/forms\/reports\/([0-9a-f-]{36})\.pdf$/i.exec(url.pathname);
      if (req.method === 'GET' && formsReportMatch) return downloadPublicScreeningReport(res, reportStore, formsReportMatch[1], 'forms');
      if (req.method === 'GET' && url.pathname === '/service/adverse_media/config') {
        return json(res, 200, {
          supported_languages: adverseMediaConfig.supportedLanguages,
          regions: adverseMediaConfig.regions,
          maximum_languages: adverseMediaConfig.maxLanguages,
          maximum_paid_queries: adverseMediaConfig.maxPaidQueries,
          maximum_ai_candidates: adverseMediaConfig.maxAiCandidates,
          default_risk_threshold: adverseMediaConfig.defaultRiskThreshold,
          default_review_threshold_percent: adverseMediaConfig.defaultReviewThresholdPercent,
          default_high_risk_threshold_percent: adverseMediaConfig.defaultHighRiskThresholdPercent,
          cost_guardrail_usd: adverseMediaConfig.costGuardrailUsd
        }, { 'cache-control': 'public, max-age=3600' });
      }
      if (url.pathname.startsWith('/admin/api/')) return handleAdminApi(req, res, url, store, loginThrottle);
      if (url.pathname === '/admin' || url.pathname === '/admin/') return serveStatic(res, join(root, 'admin-site'), '/');
      if (url.pathname.startsWith('/admin/')) return serveStatic(res, join(root, 'admin-site'), url.pathname.replace(/^\/admin/, '') || '/');
      if (url.pathname === '/catalog.json') return json(res, 200, { integrations: await store.listIntegrations({ publicOnly: true }) }, { 'cache-control': 'public, max-age=60' });
      if (url.pathname === '/forms.json') {
        const integrations = await store.listIntegrations({ publicOnly: true });
        const forms = (await store.listForms()).filter((form) => form.enabled).map((form) => publicFormDefinition(form, integrations));
        return json(res, 200, { forms }, { 'cache-control': 'public, max-age=60' });
      }
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
      if (directory.endsWith('api-site') && (url.pathname === '/merchant-screening' || url.pathname === '/merchant-screening/')) return serveStatic(res, directory, '/merchant-screening.html');
      if (directory.endsWith('api-site') && (url.pathname === '/forms' || url.pathname === '/forms/' || /^\/forms\/[a-z0-9-]+\/?$/.test(url.pathname))) return serveStatic(res, directory, '/forms.html');
      return serveStatic(res, directory, url.pathname.replace(/^\/docs/, '') || '/');
    } catch {
      return json(res, 500, { status: 'Error', error: 'The service is temporarily unavailable. Please try again shortly.' });
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  createAppServer().listen(port, '0.0.0.0', () => console.log(`AI7 UAE service listening on port ${port}`));
}
