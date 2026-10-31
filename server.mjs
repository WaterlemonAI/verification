import { createReadStream, readFileSync, existsSync, statSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/api-store.mjs';
import { createPlatformMailer } from './lib/platform-mail.mjs';
import { createCustomerUsageStore, moneyMicros, validateUsagePolicy, validateCasePolicy } from './lib/customer-usage.mjs';
import { createInvitation, invitationCustomerId, validInvitation, publicCustomer, INVITATION_HOURS } from './lib/customer-invitation.mjs';
import { createPasswordResetToken, parsePasswordResetToken, RESET_MINUTES } from './lib/password-reset.mjs';
import { createEntitySearchAuditPdf } from './lib/entity-search-report.mjs';
import { adverseMediaConfig, presentAdverseMediaResponse, screenAdverseMedia, validateAdverseMediaRequest } from './lib/adverse-media.mjs';
import { createDeepResearchQueue, makeDeepResearchJob, startDeepResearchWorker, validatePublicCallbackUrl } from './lib/deep-research-queue.mjs';
import { createAdverseMediaAuditPdf, createAdverseMediaNarrative } from './lib/adverse-media-report.mjs';
import { createAdverseMediaReportStore, reportOwnerId } from './lib/adverse-media-report-store.mjs';
import { createAdverseMediaJsonStore } from './lib/adverse-media-json-store.mjs';
import { merchantScreenshotAssets, screenMerchantWebsite, validateMerchantScreeningRequest } from './lib/merchant-screening.mjs';
import { createMerchantScreeningAuditPdf } from './lib/merchant-screening-report.mjs';
import { createScreeningCostGuard } from './lib/screening-cost-guard.mjs';
import { publicFormDefinition, resolveFormServiceInput, validateFormDefinition, validateFormSubmission } from './lib/forms.mjs';
import { createFormsQueue, makeFormsJob, startFormsWorker, validateFormsCallbackUrl } from './lib/forms-queue.mjs';
import { createFormsSubmissionStore, formSubmissionFingerprint, publicFormQueueReceipt } from './lib/forms-submission-store.mjs';
import { createFormsAuditPdf } from './lib/forms-report.mjs';
import { CapacityError, createRequestCapacity } from './lib/request-capacity.mjs';
import {
  ADMIN_COOKIE, adminCookie, clearAdminCookie, createAdminAccount, createAdminSession,
  newSigningKey, normalizeAdminEmail, parseCookies, safeAdminAccount, verifyAdminPassword, verifyAdminSession
} from './lib/admin-auth.mjs';
import {
  PORTAL_COOKIE, clearPortalCookie, createPortalAccount, createPortalSession,
  portalCookie, safePortalAccount, verifyPortalPassword, verifyPortalSession
} from './lib/portal-auth.mjs';
import { bsaEnabled, bsaMode, bsaCapabilities, createBsaJob, getBsaJob, getBsaResult, getBsaArtifact, presentBsaResult } from './lib/bsa-store.mjs';
import { DOCUMENT_OCR_BY_ID, DOCUMENT_OCR_BY_PATH } from './lib/document-ocr-contracts.mjs';
import { createDocumentOcrStore } from './lib/document-ocr-store.mjs';
import { CASE_OUTCOMES, CASE_REQUEST_STATUSES, caseExpiresAt, caseRequestStatus,
  classifyCaseSubmission } from './lib/case-manager-contract.mjs';
import { caseOutcome } from './lib/case-manager-outcomes.mjs';
import { createLoginOtpStore, LOGIN_OTP_SECONDS, loginOtpHash, newLoginOtp } from './lib/login-otp.mjs';
import { createCaseManagerStore } from './lib/case-manager-store.mjs';
import { createEjariStore } from './lib/ejari-store.mjs';
import { documentOcrArtifactUrl, documentOcrSignedAccess } from './lib/document-ocr-artifact-url.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8080);
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 15 * 1024 * 1024);
const apiHosts = new Set((process.env.API_HOSTS || 'api.ai7uae.com,app.kycprobe.com,localhost,127.0.0.1').split(',').map((v) => v.trim().toLowerCase()));
const reconciledCaseServices = new Set(['bank-statement-analysis', 'ejari-verification', ...[...DOCUMENT_OCR_BY_PATH.values()].map((item) => item.id)]);
const caseRouteIsReconciled = (serviceId) => reconciledCaseServices.has(serviceId);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.pdf': 'application/pdf'
};

const hopByHopHeaders = new Set(['authorization', 'connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function presentDocumentOcrResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const presented = { ...value };
  if (value.provider_calls && typeof value.provider_calls === 'object') {
    const { gemini, ...otherCalls } = value.provider_calls;
    if (gemini !== undefined) presented.provider_calls = { ...otherCalls, ai7edd_model: gemini };
  }
  if (value.processing && typeof value.processing === 'object') {
    presented.processing = presentDocumentOcrResponse(value.processing);
    if (typeof value.processing.ai_model === 'string' && /gemini/i.test(value.processing.ai_model)) {
      presented.processing.ai_model = 'ai7edd model';
    }
  }
  if (value.job && typeof value.job === 'object') presented.job = presentDocumentOcrResponse(value.job);
  return presented;
}

function validateCallbackAccessKey(value, callbackUrl) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || !callbackUrl || value.length < 1 || value.length > 512
    || !/^[A-Za-z0-9._~+/-]+=*$/.test(value)) throw new Error('invalid_callback_access_key');
  return value;
}

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
  res.setHeader('access-control-expose-headers', 'x-ai7-transaction-id, x-ai7-queue-wait-ms, x-ai7-report-id, x-ai7-report-status, retry-after');
}

function moduleCatalog(integrations) {
  return [
    ...integrations.map((item) => ({ id: item.id, name: item.name, available: item.enabled !== false })),
    { id: 'bank-statement-analysis', name: 'Bank Statement Analysis', available: bsaEnabled() },
    { id: 'entity-search-report', name: 'Entity Search PDF report', available: true },
    { id: 'forms', name: 'Forms orchestration', available: true }
  ];
}

async function classifyCustomerApi(req, url, store) {
  const path = url.pathname;
  const fixed = {
    '/service/adverse_media': 'adverse-media',
    '/service/merchant_screening': 'merchant-screening',
    '/service/bank_statement_analysis': 'bank-statement-analysis',
    '/service/dubai_ejari_verification': 'ejari-verification',
    '/reports/entity-search.pdf': 'entity-search-report'
  };
  if (path === '/service/health') return { moduleIds: [], method: 'GET', billable: false };
  if (path === '/service/keys/self/rotate') return { moduleIds: [], method: 'POST', billable: false };
  const documentOcr = DOCUMENT_OCR_BY_PATH.get(path);
  if (documentOcr) return { moduleIds: [documentOcr.id], method: 'POST', billable: true };
  const documentOcrJob = /^\/service\/([a-z_]+)\/(?:jobs\/)?(ocr_[0-9a-f-]{36})(?:\/(?:result|artifacts\/(?:photo|signature)))?$/.exec(path);
  if (documentOcrJob) {
    const definition = DOCUMENT_OCR_BY_PATH.get(`/service/${documentOcrJob[1]}`);
    if (definition) return { moduleIds: [definition.id], method: 'GET', billable: false };
  }
  if (fixed[path]) return { moduleIds: [fixed[path]], method: 'POST', billable: true };
  if (path === '/service/adverse_media/config' || /\/service\/(?:adverse_media|merchant_screening|forms)\/reports\//.test(path)
    || /\/service\/merchant_screening\/screenshots\//.test(path)) return null;
  if (path.startsWith('/service/bank_statement_analysis/')) return { moduleIds: ['bank-statement-analysis'], method: 'GET', billable: false };
  if (path.startsWith('/service/dubai_ejari_verification/jobs/')) return { moduleIds: ['ejari-verification'], method: 'GET', billable: false };
  const formMatch = /^\/forms\/([a-z0-9-]+)\/submissions$/.exec(path);
  if (formMatch) {
    const form = await store.getForm(formMatch[1]);
    return { moduleIds: ['forms', ...(form?.enabled ? form.services.map((item) => item.service_id) : [])], method: 'POST', billable: Boolean(form?.enabled) };
  }
  const integration = await store.getIntegration?.(path, req.method || 'GET');
  if (integration) return { moduleIds: [integration.id], method: integration.method, billable: true };
  if (path.startsWith('/service/') && store.listIntegrations) {
    const configured = (await store.listIntegrations({ publicOnly: true })).find((item) => item.publicPath === path);
    if (configured) return { moduleIds: [configured.id], method: configured.method, billable: false };
  }
  return null;
}

function completeUsageBeforeResponse(res, usageStore, workspaceId, logKey, transactionId, details, billable, capture = null) {
  const originalEnd = res.end;
  let called = false;
  res.end = function (...args) {
    if (called) return this;
    called = true;
    const status = this.statusCode;
    const operation = billable
      ? usageStore.complete(workspaceId, logKey, status, this.ai7BillingReason || '')
      : usageStore.record(workspaceId, { ...details, transactionId }, status);
    let timer;
    const completion = capture ? Promise.all([operation, capture(this, args)]) : operation;
    Promise.race([completion, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('usage_log_timeout')), 5000); timer.unref?.(); })])
      .catch(() => console.warn('customer_usage_completion_failed'))
      .finally(() => { clearTimeout(timer); originalEnd.apply(this, args); });
    return this;
  };
}

async function gateCustomerApi(req, res, url, store, usageStore, formsQueue, formSubmissionStore, caseStore, transactionId) {
  const route = await classifyCustomerApi(req, url, store);
  if (!route) return true;
  const token = bearerToken(req);
  let client = await store.getClientForKey?.(token);
  if (!client && !store.getClientForKey && await store.isClientKey?.(token)) {
    client = { id: `test-${createHash('sha256').update(token).digest('hex').slice(0, 16)}`, key_id: '' };
  }
  if (!client) return true; // The existing route returns its unchanged 401 body.
  req.ai7Client = client;
  req.ai7OriginalArtifactOwner = reportOwnerId(token);
  const workspaceId = client.id;
  const details = { transactionId, keyId: client.key_id || '', moduleIds: route.moduleIds, method: req.method || 'GET', path: url.pathname };
  const managed = Boolean((await store.getCustomer?.(workspaceId))?.usagePolicyVersion);
  const captureRejectedAttempt = async (status, body, policySnapshot = null) => {
    if (process.env.CASE_MANAGER_ENABLED !== 'true' || !caseStore) return;
    try {
      const policy = policySnapshot || await usageStore.casePolicy(workspaceId, managed);
      if (!policy.enabled) return;
      const caseRoute = classifyCaseSubmission(route.method, url.pathname,
        url.pathname.startsWith('/service/')
          ? { id: route.moduleIds[0], publicPath: url.pathname, method: route.method, enabled: true } : null);
      if (!caseRoute) return;
      const acceptedAt = new Date().toISOString();
      const formHasOcr = caseRoute.service === 'forms' && route.moduleIds.some((id) =>
        [...DOCUMENT_OCR_BY_PATH.values()].some((definition) => definition.id === id));
      const intent = await caseStore.createIntent({ workspaceId, serviceId: caseRoute.service, transactionId, acceptedAt,
        expiresAt: caseExpiresAt(acceptedAt, policy.ttl_days, { ocr: Boolean(caseRoute.ocr), formHasOcr }),
        policyVersion: policy.version });
      const mapping = caseOutcome(caseRoute.service, body, { httpStatus: status });
      await caseStore.captureFinal(workspaceId, intent.id, { response: body, contentType: 'application/json',
        httpStatus: status, outcome: mapping.outcome, reasonCodes: mapping.reasonCodes });
    } catch {
      console.warn('case_manager_rejected_attempt_capture_failed', JSON.stringify({ transaction_id: transactionId }));
    }
  };
  if (req.method !== route.method) {
    await usageStore.record(workspaceId, details, 405);
    const body = { status: 'Error', error: `Method must be ${route.method}.` };
    await captureRejectedAttempt(405, body);
    json(res, 405, body, { allow: route.method });
    return false;
  }
  const formMatch = /^\/forms\/([a-z0-9-]+)\/submissions$/.exec(url.pathname);
  if (formMatch && route.billable) {
    const prepared = await prepareFormSubmission(req, formMatch[1], store, formsQueue, transactionId);
    if (prepared.status) {
      await usageStore.record(workspaceId, details, prepared.status);
      const body = { status: 'Error', error: prepared.error };
      await captureRejectedAttempt(prepared.status, body);
      json(res, prepared.status, body);
      return false;
    }
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      await usageStore.record(workspaceId, details, 400);
      const body = { status: 'Error', error: 'Idempotency-Key must contain 16–128 letters, digits, dots, underscores, colons or hyphens.' };
      await captureRejectedAttempt(400, body);
      json(res, 400, body);
      return false;
    }
    const claim = await formSubmissionStore.claim({ workspaceId, form: prepared.form, idempotencyKey,
      payloadHash: formSubmissionFingerprint(prepared.form, prepared.submission), job: prepared.job });
    if (claim.status !== 'new') {
      const status = claim.status === 'replayed' ? 202 : claim.status === 'conflict' ? 409 : 503;
      await usageStore.record(workspaceId, details, status);
      if (claim.status === 'replayed' && process.env.CASE_MANAGER_ENABLED === 'true' && caseStore) {
        const policy = await usageStore.casePolicy(workspaceId, managed);
        if (policy.enabled) {
          try {
            const acceptedAt = new Date().toISOString();
            await caseStore.createIntent({ workspaceId, serviceId: 'forms', transactionId, acceptedAt,
              expiresAt: caseExpiresAt(acceptedAt, policy.ttl_days, {
                formHasOcr: route.moduleIds.some((id) => [...DOCUMENT_OCR_BY_PATH.values()].some((definition) => definition.id === id))
              }), policyVersion: policy.version, logicalKey: `${url.pathname}:${idempotencyKey}` });
          } catch { console.warn('case_manager_replay_attempt_failed', JSON.stringify({ transaction_id: transactionId })); }
        }
      }
      if (claim.status === 'replayed') json(res, 202, publicFormQueueReceipt(claim.row));
      else json(res, status, { status: 'Error', reasonCode: claim.status === 'conflict' ? 'IDEMPOTENCY_CONFLICT' : 'SUBMISSION_PENDING',
        error: claim.status === 'conflict' ? 'This Idempotency-Key was used with different input.' : 'Submission admission is pending reconciliation. No additional check was queued or charged.' },
      claim.status === 'in_progress' ? { 'retry-after': '2' } : {});
      return false;
    }
    prepared.claim = claim.row;
    prepared.job.idempotency = { partitionKey: claim.row.partitionKey, rowKey: claim.row.rowKey };
    req.ai7PreparedForm = prepared;
  }
  if (route.billable) {
    let admission;
    try { admission = await usageStore.admit(workspaceId, details, managed); }
    catch (error) {
      if (req.ai7PreparedForm?.claim) await formSubmissionStore.abandon(req.ai7PreparedForm.claim);
      throw error;
    }
    if (!admission.allowed) {
      if (req.ai7PreparedForm?.claim) await formSubmissionStore.abandon(req.ai7PreparedForm.claim);
      const body = { status: 'Error', error: admission.reason };
      await captureRejectedAttempt(admission.statusCode, body, admission.casePolicy);
      json(res, admission.statusCode, body);
      return false;
    }
    if (process.env.CASE_MANAGER_ENABLED === 'true' && admission.casePolicy?.enabled) {
      const caseRoute = classifyCaseSubmission(req.method, url.pathname,
        url.pathname.startsWith('/service/')
          ? { id: route.moduleIds[0], publicPath: url.pathname, method: route.method, enabled: route.billable } : null);
      if (caseRoute) {
        if (!caseStore) {
          await usageStore.complete(workspaceId, admission.logKey, 503, 'case_manager_unavailable');
          if (req.ai7PreparedForm?.claim) await formSubmissionStore.abandon(req.ai7PreparedForm.claim);
          json(res, 503, { status: 'Error', error: 'Case Manager is temporarily unavailable.' });
          return false;
        }
        const acceptedAt = new Date().toISOString();
        const formHasOcr = caseRoute.service === 'forms' && route.moduleIds.some((id) =>
          [...DOCUMENT_OCR_BY_PATH.values()].some((definition) => definition.id === id));
        try {
          req.ai7Case = await caseStore.createIntent({ workspaceId, serviceId: caseRoute.service,
            transactionId, acceptedAt, expiresAt: caseExpiresAt(acceptedAt, admission.casePolicy.ttl_days,
              { ocr: Boolean(caseRoute.ocr), formHasOcr }), policyVersion: admission.casePolicy.version,
            logicalKey: (reconciledCaseServices.has(caseRoute.service) || caseRoute.service === 'forms')
              && req.headers['idempotency-key'] ? `${url.pathname}:${String(req.headers['idempotency-key'])}` : '' });
          if (req.ai7PreparedForm) req.ai7PreparedForm.job.case_id = req.ai7Case.id;
        } catch {
          console.warn('case_manager_intent_failed', JSON.stringify({ transaction_id: transactionId }));
          await usageStore.complete(workspaceId, admission.logKey, 503, 'case_manager_intent_failed');
          if (req.ai7PreparedForm?.claim) await formSubmissionStore.abandon(req.ai7PreparedForm.claim);
          json(res, 503, { status: 'Error', error: 'Case Manager is temporarily unavailable.' });
          return false;
        }
      }
    }
    req.ai7Usage = { workspaceId, logKey: admission.logKey };
    if (req.ai7PreparedForm) req.ai7PreparedForm.job.billing.log_key = admission.logKey;
    const capture = req.ai7Case ? async (response, args) => {
      const status = response.statusCode;
      if (req.ai7Case.reused && status < 500) return;
      const raw = Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0] ?? '');
      const contentType = String(response.getHeader('content-type') || '');
      let finalResponse = raw;
      if (contentType.toLowerCase().includes('json')) {
        try { finalResponse = JSON.parse(raw); } catch { /* preserve non-JSON bytes as text */ }
      }
      if (status === 202) {
        if (caseRouteIsReconciled(req.ai7Case.service_id)) {
          const sourceId = req.ai7Case.service_id === 'bank-statement-analysis'
            ? finalResponse?.analysisId : req.ai7Case.service_id === 'ejari-verification' ? finalResponse?.jobId : finalResponse?.id;
          try {
            await caseStore.linkAsync(workspaceId, req.ai7Case.id, { sourceId,
              originalOwner: req.ai7Case.service_id === 'bank-statement-analysis'
                ? req.ai7OriginalArtifactOwner : workspaceId });
          } catch {
            await caseStore.markIncomplete(workspaceId, req.ai7Case.id).catch(() => {});
            console.warn('case_manager_reconcile_link_failed', JSON.stringify({ case_id: req.ai7Case.id }));
          }
        }
        return;
      }
      const mapping = caseOutcome(route.moduleIds[0] === 'forms' ? 'forms' : route.moduleIds[0], finalResponse,
        { httpStatus: status });
      const reportId = finalResponse?.report?.report_id || String(response.getHeader('x-ai7-report-id') || '');
      const artifactRefs = (/^[0-9a-f-]{36}$/i.test(reportId) || /^AI7-[A-F0-9]{16}$/.test(reportId))
        ? [{ type: req.ai7Case.service_id, report_id: reportId }] : [];
      const originalArtifactOwner = req.ai7Case.service_id === 'entity-search'
        ? `workspace-${workspaceId}` : req.ai7OriginalArtifactOwner;
      try {
        await (caseStore.captureFinalDeferred || caseStore.captureFinal).call(caseStore, workspaceId, req.ai7Case.id,
          { response: finalResponse, contentType,
          httpStatus: status, outcome: mapping.outcome, reasonCodes: mapping.reasonCodes,
          originalArtifactOwner, artifactRefs }, req.ai7Case);
      } catch {
        console.warn('case_manager_capture_failed', JSON.stringify({ transaction_id: transactionId }));
        await caseStore.markIncomplete(workspaceId, req.ai7Case.id).catch(() =>
          console.warn('case_manager_incomplete_mark_failed', JSON.stringify({ transaction_id: transactionId })));
      }
    } : null;
    completeUsageBeforeResponse(res, usageStore, workspaceId, admission.logKey, transactionId, details, true, capture);
  } else {
    const profile = await usageStore.account(workspaceId, managed);
    const allowed = profile.allowed_modules;
    if (route.moduleIds.some((id) => !allowed.includes('*') && !allowed.includes(id))) {
      await usageStore.record(workspaceId, details, 403);
      json(res, 403, { status: 'Error', error: 'This module is not enabled for this customer.' });
      return false;
    }
    completeUsageBeforeResponse(res, usageStore, workspaceId, '', transactionId, details, false);
  }
  req.ai7CapacityLane = route.billable
    ? (DOCUMENT_OCR_BY_PATH.has(url.pathname) ? 'document-ocr' : route.moduleIds[0] || 'other') : '';
  return true;
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

async function createEntitySearchReport(req, res, store, reportStore) {
  if (!req.ai7Client && !(await store.isClientKey(bearerToken(req)))) {
    return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  }
  try {
    const body = await readJson(req, 16 * 1024);
    const reportId = String(body?.report_id || '');
    if (!/^AI7-[A-F0-9]{16}$/.test(reportId)) {
      return json(res, 400, { status: 'Error', error: 'A server-issued report_id is required.' });
    }
    const ownerId = req.ai7Client?.id ? `workspace-${req.ai7Client.id}` : reportOwnerId(bearerToken(req));
    const report = await reportStore.get({ ownerId, reportId });
    if (!report || report.metadata.report_type !== 'entity_search') {
      return json(res, 404, { status: 'Error', error: 'The report was not found for this workspace.' });
    }
    const filename = String(report.metadata.filename || `ai7-entity-search-${reportId}.pdf`).replace(/[^a-zA-Z0-9._-]/g, '-');
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': report.bytes.length,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'x-ai7-report-id': reportId,
      'x-content-sha256': report.metadata.sha256
    });
    res.end(report.bytes);
  } catch (error) {
    if (error.statusCode === 400) return json(res, 400, { status: 'Error', error: 'The report request is too large or invalid.' });
    return json(res, 503, { status: 'Error', error: 'The screening report service is temporarily unavailable.' });
  }
}

export async function finalizeAdverseMediaReport({ request, response, ownerId, origin, aiApiKey, fetchImpl, reportStore,
  jsonStore = createAdverseMediaJsonStore(), inputPayload = request, transactionId = null, reportId = null }) {
  try {
    if (reportId) {
      const existing = await reportStore.get({ ownerId, reportId });
      const publicReport = existing && await reportStore.getPublic({ reportId });
      if (publicReport?.metadata.transaction_id === response.screening_id) {
        const reportPath = `/service/adverse_media/reports/${reportId}.pdf`;
        const finalized = { ...response, report: { ...existing.metadata,
          download_url: process.env.API_PUBLIC_BASE_URL ? new URL(reportPath, process.env.API_PUBLIC_BASE_URL).href : reportPath } };
        try {
          await jsonStore.save({ ownerId, screeningId: response.screening_id, transactionId, input: inputPayload,
            response: finalized });
        } catch { throw new Error('adverse_json_retention_unavailable'); }
        return finalized;
      }
    }
    const logo = await fetchPublicLogo(request.customer_logo_url);
    const narrativeKey = reportId ? `report-narrative:${reportId}` : '';
    let narrative = narrativeKey && await reportStore.getDeepResearchComponent?.({
      ownerId, screeningId: response.screening_id, componentKey: narrativeKey
    });
    if (!narrative) {
      const reviewed = !response.coverage?.reason_codes?.includes('classification_incomplete');
      narrative = await createAdverseMediaNarrative({ response,
        apiKey: reviewed && response.results?.length ? aiApiKey : '', fetchImpl });
      if (narrativeKey) await reportStore.saveDeepResearchComponent?.({
        ownerId, screeningId: response.screening_id, componentKey: narrativeKey, value: narrative
      });
    }
    const report = await createAdverseMediaAuditPdf({ request, response, narrative, origin,
      ...(reportId ? { reportId } : {}), ...logo });
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
    const finalized = { ...response, report: metadata };
    const [pdfWrite, jsonWrite] = await Promise.allSettled([
      reportStore.save({ ownerId, reportId: report.reportId, bytes: report.bytes,
        metadata: { ...metadata, report_type: 'adverse_media' } }),
      jsonStore.save({ ownerId, screeningId: response.screening_id, transactionId, input: inputPayload,
        response: finalized })
    ]);
    if (pdfWrite.status === 'rejected') throw new Error('report_service_unavailable');
    if (jsonWrite.status === 'rejected') throw new Error('adverse_json_retention_unavailable');
    return finalized;
  } catch (cause) {
    if (cause.message === 'adverse_json_retention_unavailable') {
      const error = new Error('adverse_json_retention_unavailable');
      error.statusCode = 503;
      throw error;
    }
    const error = new Error('report_service_unavailable');
    error.statusCode = 503;
    throw error;
  }
}

async function createAdverseMediaScreening(req, res, store, fetchImpl, deepResearchQueue, reportStore, jsonStore) {
  const startedAt = Date.now();
  let screeningResult;
  let screeningFinishedAt;
  let costGuard;
  const logMetrics = (reportStatus) => {
    if (!screeningResult) return;
    const usage = screeningResult.usage || {};
    console.info('adverse_media_request_metrics', JSON.stringify({
      transaction_id: res.getHeader('x-ai7-transaction-id'),
      screening_id: screeningResult.screening_id,
      status: screeningResult.status,
      report_status: reportStatus,
      screening_ms: screeningFinishedAt - startedAt,
      report_ms: Date.now() - screeningFinishedAt,
      total_ms: Date.now() - startedAt,
      search_queries: usage.paid_search_queries || 0,
      search_attempts: usage.paid_search_attempts || 0,
      search_retries: Math.max(0, (usage.paid_search_attempts || 0) - (usage.paid_search_queries || 0)),
      failed_search_queries: usage.failed_search_queries || 0,
      free_search_queries: usage.free_search_queries || 0,
      failed_free_search_queries: usage.failed_free_search_queries || 0,
      hosted_archive_attempts: usage.hosted_archive_attempts || 0,
      hosted_archive_retries: usage.hosted_archive_retries || 0,
      provider_calls: costGuard?.providerCalls || { brave: 0, gemini: 0 },
      reserved_provider_cost_usd: costGuard?.reservedProviderCostUsd || 0,
      source_status: screeningResult.coverage?.source_status,
      classification_status: screeningResult.methodology?.ai_classification?.status,
      classification_candidates: screeningResult.methodology?.ai_classification?.candidates_reviewed || 0,
      estimated_variable_cost_usd: usage.estimated_total_variable_cost_usd || 0,
      cache_hit: usage.cache_hit === true
    }));
  };
  const token = bearerToken(req);
  if (!req.ai7Client && !(await store.isClientKey(token))) {
    return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  }
  if (jsonStore?.ready === false) {
    return json(res, 503, { status: 'Error', error: 'The screening record service is temporarily unavailable.' });
  }
  try {
    const input = await readJson(req);
    if (Buffer.byteLength(JSON.stringify(input)) > 32 * 1024) {
      return json(res, 413, { status: 'Error', error: 'Adverse-media input must be 32 KiB or smaller.' });
    }
    const request = validateAdverseMediaRequest(input);
    const callbackAccessKey = validateCallbackAccessKey(input.callback_access_key, request.callback_url);
    if (request.deep_research && request.callback_url) {
      if (!deepResearchQueue) return json(res, 503, { status: 'Error', error: 'Deep research callback processing is temporarily unavailable.' });
      await validatePublicCallbackUrl(request.callback_url);
      const { callback_access_key: _callbackAccessKey, ...safeInput } = input;
      const job = makeDeepResearchJob(request, { owner_id: reportOwnerId(token), request_origin: requestOrigin(req),
        callback_access_key: callbackAccessKey, input_payload: safeInput,
        transaction_id: res.getHeader('x-ai7-transaction-id') });
      if (req.ai7Case) {
        job.case_id = req.ai7Case.id;
        job.case_workspace_id = req.ai7Client.id;
      }
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
    costGuard = createScreeningCostGuard(fetchImpl);
    const result = await screenAdverseMedia({ request, apiKey: providerKey, aiApiKey, fetchImpl, costGuard });
    screeningResult = result;
    screeningFinishedAt = Date.now();
    const response = await finalizeAdverseMediaReport({
      request,
      response: presentAdverseMediaResponse(result),
      ownerId: reportOwnerId(token),
      origin: requestOrigin(req),
      aiApiKey,
      fetchImpl: costGuard.fetch,
      reportStore,
      jsonStore,
      inputPayload: input,
      transactionId: res.getHeader('x-ai7-transaction-id')
    });
    logMetrics('completed');
    return json(res, 200, response);
  } catch (error) {
    if (screeningResult) logMetrics('failed');
    else console.warn('adverse_media_request_failure', JSON.stringify({
      transaction_id: res.getHeader('x-ai7-transaction-id'),
      elapsed_ms: Date.now() - startedAt,
      failure_stage: error.message === 'search_provider_unavailable' ? 'search' : 'request_or_configuration',
      provider_status: error.message === 'search_provider_unavailable' ? error.statusCode || 502 : null,
      source_failures: error.message === 'search_provider_unavailable' ? error.sourceFailures || {} : undefined,
      provider_calls: costGuard?.providerCalls || { brave: 0, gemini: 0 },
      reserved_provider_cost_usd: costGuard?.reservedProviderCostUsd || 0
    }));
    if (error.message === 'search_provider_unavailable') {
      console.warn('adverse_media_search_unavailable', JSON.stringify({
        transaction_id: res.getHeader('x-ai7-transaction-id'),
        source_failures: error.sourceFailures || {}
      }));
    }
    if (error.message === 'invalid_callback_access_key') return json(res, 400, { status: 'Error',
      reasonCode: 'INVALID_CALLBACK_ACCESS_KEY',
      error: 'callback_access_key requires callback_url and must be a 1–512 character Bearer token without whitespace.' });
    if (error.statusCode === 400 || (!error.statusCode && error.message !== 'search_provider_unavailable')) {
      return json(res, 400, { status: 'Error', error: error.message || 'The request is invalid.' });
    }
    if (String(error.message || '').startsWith('report_') || error.message === 'adverse_json_retention_unavailable'
      || /Blob|Table|storage/i.test(String(error.message || ''))) {
      return json(res, 503, { status: 'Error', error: 'The screening record service is temporarily unavailable. Please try again shortly.' });
    }
    return json(res, 502, { status: 'Error', reason_code: 'SEARCH_SOURCES_UNAVAILABLE',
      error: 'The media search service is temporarily unavailable. Please try again shortly.' });
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
  if (!req.ai7Client && !(await store.isClientKey(token))) {
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

async function proxyIntegration(req, res, url, integration, store, fetchImpl, reportStore) {
  if (!req.ai7Client && !(await store.isClientKey(bearerToken(req)))) {
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
    let entityRequest;
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
        entityRequest = { country: '', gender: '', dob: '', ...parsedBody };
        body = Buffer.from(JSON.stringify(entityRequest));
        const submittedFuzziness = Number(parsedBody.fuzziness);
        if (parsedBody.fuzziness !== undefined && parsedBody.fuzziness !== null
          && String(parsedBody.fuzziness).trim() !== '' && Number.isFinite(submittedFuzziness)
          && submittedFuzziness >= 0 && submittedFuzziness <= 1) {
          res.setHeader('x-ai7-submitted-fuzziness', String(submittedFuzziness));
        }
      }
    }

    const target = new URL(integration.upstreamUrl);
    target.search = url.search;
    const headers = forwardHeaders(req);
    delete headers['x-ai7-generate-pdf'];
    delete headers['x-ai7-report-logo-url'];
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
    if (integration.id === 'entity-search' && req.headers['x-ai7-generate-pdf'] === 'true' && entityRequest) {
      try {
        const parsed = JSON.parse(responseBody.toString('utf8'));
        const logo = await fetchPublicLogo(String(req.headers['x-ai7-report-logo-url'] || '').slice(0, 2048));
        const transactionId = String(res.getHeader('x-ai7-transaction-id') || '');
        const report = await createEntitySearchAuditPdf({ request: entityRequest, response: parsed,
          httpStatus: upstream.status, completedAt: new Date().toISOString(), transactionId,
          requestSha256: createHash('sha256').update(body).digest('hex'),
          responseSha256: createHash('sha256').update(responseBody).digest('hex'), ...logo });
        const ownerId = req.ai7Client?.id ? `workspace-${req.ai7Client.id}` : reportOwnerId(bearerToken(req));
        const filename = reportFilename(entityRequest.name);
        const metadata = { report_id: report.reportId, transaction_id: transactionId,
          generated_at: report.generatedAt, filename, sha256: createHash('sha256').update(report.bytes).digest('hex'),
          report_type: 'entity_search', retention: 'permanent' };
        await reportStore.save({ ownerId, reportId: report.reportId, bytes: report.bytes, metadata, publicReport: false });
        res.setHeader('x-ai7-report-id', report.reportId);
        res.setHeader('x-ai7-report-status', 'ready');
      } catch {
        res.setHeader('x-ai7-report-status', 'unavailable');
        console.warn('entity_search_report_failed', JSON.stringify({ transaction_id: res.getHeader('x-ai7-transaction-id') }));
      }
    }
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

function safeReasonCodes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''))
    .filter(Boolean))];
}

export function evaluateFormServiceQualification({ httpStatus, response }) {
  const transportCompleted = Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus < 300;
  const serviceStatus = typeof response?.status === 'string' ? response.status.trim().toLowerCase() : '';
  const explicitCoverage = typeof response?.coverage?.complete === 'boolean' ? response.coverage.complete : undefined;
  const explicitEligibility = typeof response?.summary?.decision_eligible === 'boolean'
    ? response.summary.decision_eligible
    : undefined;
  const serviceReasonCodes = safeReasonCodes([
    ...(Array.isArray(response?.coverage?.reason_codes) ? response.coverage.reason_codes : []),
    ...(Array.isArray(response?.summary?.reason_codes) ? response.summary.reason_codes : [])
  ]);
  const serviceReportsIncomplete = ['partial', 'failed', 'error', 'incomplete'].includes(serviceStatus);
  const hasServiceCoverageContract = explicitCoverage !== undefined
    || explicitEligibility !== undefined
    || ['completed', 'partial', 'failed', 'error', 'incomplete'].includes(serviceStatus);
  const coverageComplete = transportCompleted && (explicitCoverage ?? (!serviceReportsIncomplete && explicitEligibility !== false));
  const decisionEligible = transportCompleted && coverageComplete && explicitEligibility !== false;
  const coverageReasonCodes = [...serviceReasonCodes];
  if (!transportCompleted) coverageReasonCodes.push('transport_failed');
  if (transportCompleted && !coverageComplete) coverageReasonCodes.push('incomplete_coverage');
  const eligibilityReasonCodes = [...coverageReasonCodes];
  if (transportCompleted && explicitEligibility === false) eligibilityReasonCodes.push('service_not_decision_eligible');
  const uniqueCoverageReasons = [...new Set(coverageReasonCodes)];
  const uniqueEligibilityReasons = [...new Set(eligibilityReasonCodes)];
  const basis = hasServiceCoverageContract ? 'service_response' : 'http_contract';
  return {
    transport: {
      status: transportCompleted ? 'completed' : 'failed',
      completed: transportCompleted,
      http_status: Number.isInteger(httpStatus) ? httpStatus : null
    },
    coverage: {
      status: coverageComplete ? 'complete' : 'incomplete',
      complete: coverageComplete,
      basis,
      reason_codes: uniqueCoverageReasons,
      reason: coverageComplete
        ? (basis === 'service_response' ? 'The service affirmatively reported sufficient coverage.' : 'The service contract treats a successful HTTP response as complete coverage.')
        : (!transportCompleted ? 'Coverage could not complete because the service transport failed.' : 'The service reported incomplete screening coverage.')
    },
    eligibility: {
      status: decisionEligible ? 'eligible' : 'ineligible',
      decision_eligible: decisionEligible,
      basis,
      reason_codes: uniqueEligibilityReasons,
      reason: decisionEligible
        ? (basis === 'service_response' ? 'The service affirmatively qualifies for use in the consolidated decision.' : 'The service contract affirmatively qualifies a successful HTTP response.')
        : (!transportCompleted ? 'The service did not complete successfully.' : 'The service did not affirmatively qualify for a consolidated decision.')
    }
  };
}

export function consolidateFormServiceResults(services) {
  const completed = services.filter((service) => service.transport?.completed === true).length;
  const failed = services.length - completed;
  const coverageComplete = services.filter((service) => service.coverage?.complete === true).length;
  const eligible = services.filter((service) => service.eligibility?.decision_eligible === true).length;
  const ineligibleServices = services
    .filter((service) => service.eligibility?.decision_eligible !== true)
    .map((service) => ({
      service_id: service.service_id,
      name: service.name,
      reason_codes: service.eligibility?.reason_codes || ['eligibility_not_confirmed'],
      reason: service.eligibility?.reason || 'The service did not affirmatively qualify for a consolidated decision.'
    }));
  const status = completed === services.length ? 'completed' : completed > 0 ? 'partial' : 'failed';
  const decisionEligible = services.length > 0 && eligible === services.length;
  return {
    status,
    summary: {
      total: services.length,
      completed,
      failed,
      transport_completed: completed,
      transport_failed: failed,
      coverage_complete: coverageComplete,
      coverage_incomplete: services.length - coverageComplete,
      eligible,
      ineligible: services.length - eligible,
      decision_eligible: decisionEligible,
      reason_codes: [...new Set(ineligibleServices.flatMap((service) => service.reason_codes))],
      reason: decisionEligible
        ? 'Every selected check completed with sufficient coverage and affirmatively qualified.'
        : 'One or more selected checks did not affirmatively qualify; the consolidated result requires review.',
      ineligible_services: ineligibleServices
    }
  };
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
    const qualification = evaluateFormServiceQualification({ httpStatus: null, response: null });
    return {
      service_id: service.service_id, name, status: 'failed', http_status: null,
      started_at: startedAt, completed_at: new Date().toISOString(), duration_ms: Date.now() - started,
      error: 'The configured API is disabled or unavailable.', response: null, ...qualification
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
    const qualification = evaluateFormServiceQualification({ httpStatus, response });
    return {
      service_id: integration.id,
      name,
      status: successful ? 'completed' : 'failed',
      http_status: httpStatus,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      ...(successful ? {} : { error: 'The API returned an unsuccessful status.' }),
      response,
      ...qualification
    };
  } catch {
    const qualification = evaluateFormServiceQualification({ httpStatus: null, response: null });
    return {
      service_id: integration.id, name, status: 'failed', http_status: null,
      started_at: startedAt, completed_at: new Date().toISOString(), duration_ms: Date.now() - started,
      error: 'The API could not complete this check.', response: null, ...qualification
    };
  }
}

export async function executeFormsJob({ job, store, fetchImpl, merchantScreener = configuredMerchantScreener,
  reportStore, requestCapacity = null }) {
  let saved = null;
  try {
    saved = await reportStore.getFormResult({ ownerId: job.owner_id, submissionId: job.submission_id });
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
  if (saved?.stage === 'final') return saved.result;
  if (saved?.submission_id === job.submission_id && saved.report) return saved;
  const startedAt = saved?.started_at || new Date().toISOString();
  const services = Array.isArray(saved?.services) ? [...saved.services] : [];
  for (let index = services.length; index < job.form.services.length; index += 1) {
    const service = job.form.services[index];
    let release;
    let serviceResult;
    try {
      if (requestCapacity) release = await requestCapacity.acquire(service.service_id);
      serviceResult = await executeSingleFormService({
        service, data: job.data, submissionId: job.submission_id, store, fetchImpl, merchantScreener
      });
    } catch (error) {
      if (!(error instanceof CapacityError) || Number(job.stage_attempts?.execution || 0) < 2) throw error;
      const qualification = evaluateFormServiceQualification({ httpStatus: null, response: null });
      serviceResult = {
        service_id: service.service_id, name: service.service_id, status: 'failed', http_status: null,
        started_at: new Date().toISOString(), completed_at: new Date().toISOString(), duration_ms: 0,
        error: 'API capacity remained unavailable after controlled retries.', response: null,
        ...qualification,
        coverage: { ...qualification.coverage, reason_codes: [...qualification.coverage.reason_codes, 'capacity_unavailable'] },
        eligibility: { ...qualification.eligibility, reason_codes: [...qualification.eligibility.reason_codes, 'capacity_unavailable'] }
      };
    } finally { release?.(); }
    services.push(serviceResult);
    await reportStore.saveFormResult({ ownerId: job.owner_id, submissionId: job.submission_id,
      result: { stage: 'services_partial', services, started_at: startedAt } });
  }
  if (saved?.stage !== 'services_complete') await reportStore.saveFormResult({ ownerId: job.owner_id, submissionId: job.submission_id,
    result: { stage: 'services_complete', services, started_at: startedAt } });
  const { status, summary } = consolidateFormServiceResults(services);
  const completedAt = new Date().toISOString();
  const processingLog = [
    { at: job.queued_at, stage: 'accepted', message: 'Authenticated submission accepted and queued.' },
    { at: startedAt, stage: 'orchestration_started', message: `${services.length} configured API checks started.` },
    ...services.map((service) => ({
      at: service.completed_at,
      stage: service.status === 'completed' ? 'api_completed' : 'api_failed',
      message: `${service.name} transport ${service.transport.status} with ${service.http_status || 'no'} HTTP status in ${service.duration_ms} ms; coverage ${service.coverage.status}; eligibility ${service.eligibility.status}. ${service.eligibility.reason}`
    })),
    { at: completedAt, stage: 'consolidated', message: `Consolidated transport status ${status}; decision eligible: ${summary.decision_eligible ? 'yes' : 'no'}. ${summary.reason}` }
  ];
  let result = {
    submission_id: job.submission_id,
    status,
    form: { id: job.form.id, name: job.form.name, version: job.form.version },
    summary,
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
  await reportStore.saveFormResult({ ownerId: job.owner_id, submissionId: job.submission_id,
    result: { stage: 'final', result } });
  return result;
}

async function prepareFormSubmission(req, formId, store, formsQueue, transactionId = '') {
  if (!formsQueue) return { status: 503, error: 'Forms processing is temporarily unavailable.' };
  const form = await store.getForm(formId);
  if (!form || !form.enabled) return { status: 404, error: 'Form was not found.' };
  try {
    const input = await readJson(req, 64 * 1024);
    const submission = validateFormSubmission(form, input);
    submission.callback_access_key = validateCallbackAccessKey(input.callback_access_key, submission.callback_url);
    await validateFormsCallbackUrl(submission.callback_url);
    if (submission.customer_logo_url) await validateFormsCallbackUrl(submission.customer_logo_url);
    const job = makeFormsJob({ form, submission, ownerId: reportOwnerId(bearerToken(req)), origin: requestOrigin(req),
      billing: { workspace_id: req.ai7Client?.id || '', log_key: '0'.repeat(80) } });
    if (transactionId) job.submission_id = transactionId;
    return { form, submission, job };
  } catch (error) {
    const reason = String(error.message || '');
    if (reason === 'callback_url_required') return { status: 400, error: 'A public HTTPS callback_url is required.' };
    if (reason === 'invalid_callback_access_key') return { status: 400, error: 'callback_access_key requires callback_url and must be a 1–512 character Bearer token without whitespace.' };
    if (reason.startsWith('callback_url_')) return { status: 400, error: 'callback_url and customer_logo_url must be public HTTPS URLs.' };
    if (reason === 'form_submission_too_large') return { status: 400, error: 'The mapped Form submission is too large for asynchronous processing.' };
    return { status: 400, error: reason || 'The Form submission is invalid.' };
  }
}

async function submitForm(req, res, formId, store, formsQueue, formSubmissionStore, transactionId = '') {
  const token = bearerToken(req);
  if (!req.ai7Client && !(await store.isClientKey(token))) return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  const prepared = req.ai7PreparedForm || await prepareFormSubmission(req, formId, store, formsQueue, transactionId);
  if (prepared.status) return json(res, prepared.status, { status: 'Error', error: prepared.error });
  const { job, claim } = prepared;
  try {
    await formsQueue.enqueue(job);
  } catch {
    res.ai7BillingReason = 'form_queue_failed';
    return json(res, 503, { status: 'Error', error: 'Forms processing is temporarily unavailable.' });
  }
  try { await formSubmissionStore.accept(claim); }
  catch { console.warn('forms_submission_accept_repair_needed', JSON.stringify({ submission_id: job.submission_id })); }
  return json(res, 202, publicFormQueueReceipt(claim, { initialSecret: job.callback_secret }));
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

function validEmail(value) {
  const email = normalizeAdminEmail(value);
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(email) ? email : '';
}

async function requestPasswordReset(req, res, { kind, store, throttle, mailer }) {
  if (!mailer.configured) return json(res, 503, { status: 'Error', error: 'Password recovery is temporarily unavailable.' });
  let body;
  try { body = await readJson(req); }
  catch { return json(res, 400, { status: 'Error', error: 'The recovery request is invalid.' }); }
  const email = validEmail(body.email);
  if (!email) return json(res, 400, { status: 'Error', error: 'Enter a valid email address.' });
  const key = `reset:${kind}:${loginThrottleKey(req, email)}`;
  if (!throttle.blocked(key)) {
    throttle.failed(key);
    const account = kind === 'admin' ? await store.getAdminAccount() : await store.getPortalUser(email);
    if (account?.email === email) {
      const signingKey = kind === 'admin' ? await store.getAdminSessionKey() : await store.getPortalSessionKey();
      if (signingKey) {
        const token = createPasswordResetToken({ kind, account, signingKey });
        const path = kind === 'admin' ? '/admin' : '/login';
        const url = `${process.env.APP_PUBLIC_BASE_URL || 'https://app.kycprobe.com'}${path}?reset=${encodeURIComponent(token)}`;
        try { await mailer.sendPasswordReset({ to: email, url, minutes: RESET_MINUTES }); }
        catch { console.warn('platform_password_reset_email_failed'); }
      }
    }
  }
  return json(res, 202, { message: 'If that account exists, a password reset link will be sent.' });
}

async function completePasswordReset(req, res, { kind, store, mailer }) {
  if (!sameOrigin(req)) return json(res, 403, { status: 'Error', error: 'The request origin is invalid.' });
  let body;
  try { body = await readJson(req); }
  catch { return json(res, 400, { status: 'Error', error: 'The reset request is invalid.' }); }
  const signingKey = kind === 'admin' ? await store.getAdminSessionKey() : await store.getPortalSessionKey();
  const reset = parsePasswordResetToken(body.token, { kind, signingKey });
  if (!reset) return json(res, 400, { status: 'Error', error: 'This reset link is invalid or expired.' });
  const account = kind === 'admin' ? await store.getAdminAccount({ fresh: true }) : await store.getPortalUser(reset.email, { fresh: true });
  if (!account || account.email !== reset.email || account.version !== reset.version) {
    return json(res, 400, { status: 'Error', error: 'This reset link is invalid or expired.' });
  }
  try {
    const updated = kind === 'admin'
      ? createAdminAccount(account.email, body.password, account)
      : createPortalAccount(account.email, body.password, { id: account.client_id, name: account.client_name }, account);
    if (kind === 'admin') await store.setAdminAccount(updated);
    else await store.setPortalUser(updated);
    try { await mailer.sendSecurityAlert({ to: account.email, event: 'reset' }); }
    catch { console.warn('platform_security_alert_failed'); }
    return json(res, 200, { message: 'Password updated. Sign in with your new password.' });
  } catch (error) {
    return json(res, 400, { status: 'Error', error: error.message });
  }
}

async function beginEmailLogin(res, { kind, account, signingKey, mailer, otpStore }) {
  if (!mailer.configured || !mailer.sendLoginCode || !otpStore || !signingKey) {
    return json(res, 503, { status: 'Error', error: 'Email sign-in is temporarily unavailable.' });
  }
  const { challengeId, code } = newLoginOtp();
  const codeHash = loginOtpHash({ kind, email: account.email, challengeId, code, signingKey });
  try {
    const issued = await otpStore.issue({ kind, email: account.email, challengeId, codeHash, version: account.version });
    if (!issued.issued) return json(res, 429, { status: 'Error', error: 'A code was recently sent. Try again shortly.' },
      { 'retry-after': String(issued.retryAfter) });
    try { await mailer.sendLoginCode({ to: account.email, code, minutes: LOGIN_OTP_SECONDS / 60, kind }); }
    catch {
      await otpStore.cancel({ kind, email: account.email, challengeId }).catch(() => {});
      console.warn('platform_login_code_email_failed');
      return json(res, 503, { status: 'Error', error: 'Email sign-in is temporarily unavailable.' });
    }
    return json(res, 202, { challenge_id: challengeId, expires_in: LOGIN_OTP_SECONDS,
      message: 'A sign-in code was sent to your account email.' });
  } catch {
    console.warn('platform_login_code_store_failed');
    return json(res, 503, { status: 'Error', error: 'Email sign-in is temporarily unavailable.' });
  }
}

async function consumeEmailLogin(req, { kind, body, account, signingKey, otpStore }) {
  if (!sameOrigin(req)) return false;
  if (!account || !signingKey || !otpStore || !/^[A-Za-z0-9_-]{32}$/.test(String(body.challenge_id || ''))
    || !/^\d{8}$/.test(String(body.code || ''))) return false;
  const codeHash = loginOtpHash({ kind, email: account.email, challengeId: body.challenge_id,
    code: body.code, signingKey });
  return otpStore.consume({ kind, email: account.email, challengeId: body.challenge_id,
    codeHash, version: account.version });
}

async function currentPortalSession(req, store) {
  const token = parseCookies(req.headers.cookie)[PORTAL_COOKIE];
  if (!token) return { account: null, session: null };
  try {
    const payload = String(token).split('.')[0];
    const unsigned = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const account = await store.getPortalUser(normalizeAdminEmail(unsigned.email), { fresh: true });
    const signingKey = await store.getPortalSessionKey();
    return { account, session: verifyPortalSession(token, account, signingKey) };
  } catch {
    return { account: null, session: null };
  }
}

async function handlePortalApi(req, res, url, store, loginThrottle, resetThrottle, mailer, otpStore, usageStore,
  caseStore = null, reportStore = null, documentOcrStore = null, ejariStore = null) {
  const ejariCertificate = /^\/portal\/api\/ejari\/jobs\/(ejari_[0-9a-f-]{36})\/certificate\.pdf$/.exec(url.pathname);
  if (req.method === 'GET' && ejariCertificate) {
    if (process.env.EJARI_PLATFORM_ENABLED !== '1' || !ejariStore) return json(res, 503, {
      status: 'Error', reasonCode: 'EJARI_PLATFORM_UNAVAILABLE' });
    let workspaceId;
    if (req.headers.authorization) workspaceId = (await store.getClientForKey(bearerToken(req)))?.id;
    else {
      const { account, session } = await currentPortalSession(req, store);
      if (session) workspaceId = account.client_id;
    }
    if (!workspaceId) return json(res, 401, { status: 'Error', error: 'Sign in or provide an active API key.' });
    return sendEjariCertificate(res, ejariStore, ejariCertificate[1], workspaceId);
  }
  if (req.method === 'GET' && url.pathname === '/portal/api/auth/status') {
    const { account, session } = await currentPortalSession(req, store);
    return json(res, 200, { authenticated: Boolean(session), account: session ? safePortalAccount(account) : null });
  }

  if (req.method === 'POST' && url.pathname === '/portal/api/auth/forgot-password') {
    return requestPasswordReset(req, res, { kind: 'portal', store, throttle: resetThrottle, mailer });
  }
  if (req.method === 'POST' && url.pathname === '/portal/api/auth/reset-password') {
    return completePasswordReset(req, res, { kind: 'portal', store, mailer });
  }

  if (req.method === 'POST' && (url.pathname === '/portal/api/invitations/preview' || url.pathname === '/portal/api/invitations/accept')) {
    try {
      if (!sameOrigin(req)) return json(res, 403, { status: 'Error', error: 'Request origin is invalid.' });
      const body = await readJson(req);
      const token = String(body.token || '');
      const throttleKey = loginThrottleKey(req, invitationCustomerId(token));
      if (loginThrottle.blocked(throttleKey)) return json(res, 429, { status: 'Error', error: 'Too many attempts. Try again later.' });
      const customer = invitationCustomerId(token) ? await store.getCustomer(invitationCustomerId(token)) : null;
      if (!validInvitation(customer, token)) {
        loginThrottle.failed(throttleKey);
        return json(res, 400, { status: 'Error', error: 'This setup link is invalid or has expired.' });
      }
      if (await store.getPortalUser(customer.adminEmail)) return json(res, 409, { status: 'Error', error: 'An account already exists for this email.' });
      if (url.pathname.endsWith('/preview')) return json(res, 200, { customer: { name: customer.name, admin_email: customer.adminEmail, expires_at: customer.invitationExpiresAt } });
      if (!mailer.configured || !mailer.sendLoginCode || !otpStore) return json(res, 503,
        { status: 'Error', error: 'Account setup is temporarily unavailable.' });
      const account = createPortalAccount(customer.adminEmail, body.password, { id: customer.id, name: customer.name });
      if (!(await store.claimInvitation(customer.invitationHash))) return json(res, 409, { status: 'Error', error: 'This setup link has already been used.' });
      let signingKey = await store.getPortalSessionKey();
      if (!signingKey) { signingKey = newSigningKey(); await store.setPortalSessionKey(signingKey); }
      await store.setPortalUser({ ...account, initial_key_pending: true });
      await store.setCustomer({ ...customer, status: 'active', invitationHash: '', invitationExpiresAt: '', updatedAt: new Date().toISOString() });
      loginThrottle.clear(throttleKey);
      return json(res, 201, { account: safePortalAccount(account), message: 'Account created. Sign in to receive an email code.' });
    } catch (error) {
      if (error.message === 'invitation_claim_store_unavailable') return json(res, 503, { status: 'Error', error: 'Account setup is temporarily unavailable. Try again later.' });
      return json(res, error.statusCode || 400, { status: 'Error', error: error.statusCode ? 'The setup request is invalid.' : error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/portal/api/auth/signup') {
    return json(res, 410, { status: 'Error', error: 'Account setup now requires a customer administrator invitation.' });
  }

  if (req.method === 'POST' && url.pathname === '/portal/api/auth/login') {
    try {
      const body = await readJson(req);
      const email = normalizeAdminEmail(body.email);
      const throttleKey = loginThrottleKey(req, email);
      if (loginThrottle.blocked(throttleKey)) return json(res, 429, { status: 'Error', error: 'Too many sign-in attempts. Try again later.' });
      const account = await store.getPortalUser(email);
      if (!verifyPortalPassword(account, email, body.password)) {
        loginThrottle.failed(throttleKey);
        return json(res, 401, { status: 'Error', error: 'Email or password is incorrect.' });
      }
      loginThrottle.clear(throttleKey);
      const signingKey = await store.getPortalSessionKey();
      return beginEmailLogin(res, { kind: 'portal', account, signingKey, mailer, otpStore });
    } catch (error) {
      return json(res, error.statusCode || 400, { status: 'Error', error: 'The sign-in request is invalid.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/portal/api/auth/verify-code') {
    try {
      const body = await readJson(req);
      const email = normalizeAdminEmail(body.email);
      const account = await store.getPortalUser(email, { fresh: true });
      const signingKey = await store.getPortalSessionKey();
      if (!(await consumeEmailLogin(req, { kind: 'portal', body, account, signingKey, otpStore }))) {
        return json(res, 401, { status: 'Error', error: 'The code is invalid or expired.' });
      }
      let issued = null;
      if (account.initial_key_pending) {
        issued = await store.createClientIdempotent(account.client_name, { workspaceId: account.client_id,
          label: 'Initial key', ownerEmail: account.email }, `initial-key:${account.email}`);
        await store.setPortalUser({ ...account, initial_key_pending: false });
      }
      const created = createPortalSession(account, signingKey);
      return json(res, 200, { account: safePortalAccount(account), csrf_token: created.csrfToken,
        expires_in: created.expiresIn, ...(issued ? { api_key: issued.apiKey, key: issued.client } : {}) }, {
        'set-cookie': portalCookie(created.token, { secure: secureRequest(req) })
      });
    } catch {
      return json(res, 503, { status: 'Error', error: 'Email sign-in is temporarily unavailable.' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/portal/api/auth/session') {
    const { account, session } = await currentPortalSession(req, store);
    if (!session) return json(res, 401, { status: 'Error', error: 'Sign in to continue.' });
    return json(res, 200, { account: safePortalAccount(account), csrf_token: session.csrf, expires_at: session.expires_at });
  }

  if (req.method === 'POST' && url.pathname === '/portal/api/auth/logout') {
    const { session } = await currentPortalSession(req, store);
    if (!session) return json(res, 401, { status: 'Error', error: 'Sign in to continue.' });
    if (!sameOrigin(req) || String(req.headers['x-ai7-csrf'] || '') !== session.csrf) {
      return json(res, 403, { status: 'Error', error: 'The security token is missing or invalid. Sign in again.' });
    }
    return json(res, 200, { signed_out: true }, { 'set-cookie': clearPortalCookie({ secure: secureRequest(req) }) });
  }

  if (url.pathname === '/portal/api/case-manager/settings') {
    const { account, session } = await currentPortalSession(req, store);
    if (!session) return json(res, 401, { status: 'Error', error: 'Sign in to continue.' }, { 'cache-control': 'no-store' });
    const globalEnabled = process.env.CASE_MANAGER_ENABLED === 'true';
    const managed = Boolean((await store.getCustomer?.(account.client_id))?.usagePolicyVersion);
    if (req.method === 'GET') {
      const policy = await usageStore.casePolicy(account.client_id, managed);
      return json(res, 200, { available: globalEnabled, policy }, { 'cache-control': 'no-store' });
    }
    if (req.method !== 'PUT') return json(res, 405, { status: 'Error', error: 'Method must be GET or PUT.' }, { allow: 'GET, PUT' });
    if (!sameOrigin(req) || String(req.headers['x-ai7-csrf'] || '') !== session.csrf) {
      return json(res, 403, { status: 'Error', error: 'The security token is missing or invalid.' });
    }
    if (!globalEnabled || !caseStore) return json(res, 503, { status: 'Error', error: 'Case Manager is not available.' });
    try {
      const policy = validateCasePolicy(await readJson(req));
      const before = await usageStore.casePolicy(account.client_id, managed);
      if (policy.version !== before.version) throw new Error('Case Manager policy changed; reload and try again.');
      const raisesFloor = !policy.enabled || !before.enabled
        || (policy.ttlDays != null && policy.ttlDays < Number(before.ttl_days || 0));
      if (raisesFloor) {
        try { await caseStore.prepareRetirement(account.client_id, policy.version + 1); }
        catch {
          console.warn('case_manager_retirement_task_failed');
          return json(res, 503, { status: 'Error', error: 'Case Manager settings are temporarily unavailable.' });
        }
      }
      const saved = await usageStore.updateCasePolicy(account.client_id, policy, managed);
      let retirementScheduled = true;
      if (saved.visible_from_version > before.visible_from_version) {
        try { await caseStore?.scheduleRetirement(account.client_id, saved.visible_from_version); }
        catch { retirementScheduled = false; console.warn('case_manager_retirement_schedule_failed'); }
      }
      return json(res, 200, { available: true, policy: saved, retirement_scheduled: retirementScheduled,
        retirement_recovery_pending: !retirementScheduled }, { 'cache-control': 'no-store' });
    } catch (error) {
      const stale = /policy changed/.test(error.message);
      return json(res, stale ? 409 : 400, { status: 'Error', error: stale ? 'Settings changed. Reload and try again.' : error.message });
    }
  }

  if (url.pathname === '/portal/api/cases' || url.pathname.startsWith('/portal/api/cases/')) {
    if (process.env.CASE_MANAGER_ENABLED !== 'true' || !caseStore) {
      return json(res, 404, { status: 'Error', error: 'Case Manager is not available.' }, { 'cache-control': 'no-store' });
    }
    const { account, session } = await currentPortalSession(req, store);
    if (!session) return json(res, 401, { status: 'Error', error: 'Sign in to continue.' }, { 'cache-control': 'no-store' });
    if (req.method !== 'GET') return json(res, 405, { status: 'Error', error: 'Method must be GET.' }, { allow: 'GET' });
    const workspaceId = account.client_id;
    const policy = await usageStore.casePolicy(workspaceId);
    if (!policy.enabled) return json(res, 404, { status: 'Error', error: 'Case Manager is not enabled.' }, { 'cache-control': 'no-store' });
    if (url.pathname === '/portal/api/cases') {
      const currentTime = Date.now();
      const from = url.searchParams.get('from') || new Date(currentTime - 45 * 86_400_000).toISOString();
      const to = url.searchParams.get('to') || new Date(currentTime).toISOString();
      const serviceId = url.searchParams.get('service') || '';
      const outcome = url.searchParams.get('outcome') || '';
      const requestStatus = url.searchParams.get('request_status') || '';
      const transactionIdFilter = url.searchParams.get('transaction_id') || '';
      const limit = Number(url.searchParams.get('limit') || 25);
      const rawCursor = url.searchParams.get('cursor') || '';
      let cursor = '';
      try { cursor = rawCursor ? Buffer.from(rawCursor, 'base64url').toString('utf8') : ''; }
      catch { return json(res, 400, { status: 'Error', error: 'Invalid cursor.' }); }
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(from)
        || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(to)
        || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(from) > Date.parse(to)
        || Date.parse(to) - Date.parse(from) > 45 * 86_400_000 || !Number.isInteger(limit) || limit < 1 || limit > 100
        || (serviceId && !/^[a-z0-9-]{1,80}$/.test(serviceId))
        || (outcome && !CASE_OUTCOMES.includes(outcome))
        || (requestStatus && !CASE_REQUEST_STATUSES.includes(requestStatus))
        || (transactionIdFilter && !/^[0-9a-f-]{36}$/i.test(transactionIdFilter))
        || (transactionIdFilter && cursor) || cursor.length > 256) {
        return json(res, 400, { status: 'Error', error: 'Invalid case filters.' });
      }
      if (transactionIdFilter) {
        const found = await caseStore.findByTransaction(workspaceId, transactionIdFilter,
          { activePolicyVersion: policy.visible_from_version });
        const matches = found && (!serviceId || found.service_id === serviceId)
          && (!outcome || found.outcome === outcome)
          && (!requestStatus || caseRequestStatus(found.final_http_status) === requestStatus)
          && found.accepted_at >= from && found.accepted_at <= to;
        return json(res, 200, { cases: matches ? [found] : [], next_cursor: null },
          { 'cache-control': 'no-store' });
      }
      const page = await caseStore.listCases(workspaceId, { from, to, serviceId, outcome, requestStatus, limit, cursor,
        activePolicyVersion: policy.visible_from_version });
      return json(res, 200, { cases: page.cases,
        next_cursor: page.next_cursor ? Buffer.from(page.next_cursor).toString('base64url') : null }, { 'cache-control': 'no-store' });
    }
    const match = /^\/portal\/api\/cases\/([0-9a-f-]{36})(?:\/(json|artifacts\/([0-9]{1,2})))?$/.exec(url.pathname);
    if (!match) return json(res, 404, { status: 'Error', error: 'Case was not found.' });
    const record = await caseStore.getCase(workspaceId, match[1], { activePolicyVersion: policy.visible_from_version });
    if (!record) return json(res, 404, { status: 'Error', error: 'Case was not found.' }, { 'cache-control': 'no-store' });
    if (match[2] === 'json') {
      if (!record.payload) return json(res, 202, { status: 'Pending', error: 'The final result is not yet available.' });
      const body = record.payload.final_response;
      if (typeof body === 'string') {
        const bytes = Buffer.from(body);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': bytes.length,
          'cache-control': 'private, no-store' });
        return res.end(bytes);
      }
      return json(res, 200, record.service_id.endsWith('-ocr') || record.service_id === 'moa-analysis'
        ? presentDocumentOcrResponse(body) : body, { 'cache-control': 'private, no-store' });
    }
    if (match[3] != null) {
      const item = record.payload?.artifact_refs?.[Number(match[3])];
      if (!item || !record.payload.original_artifact_owner) {
        return json(res, 404, { status: 'Error', error: 'Artifact was not found.' });
      }
      let bytes = null;
      let mime = 'application/octet-stream';
      if (item.report_id && (/^[0-9a-f-]{36}$/i.test(item.report_id) || /^AI7-[A-F0-9]{16}$/.test(item.report_id))) {
        bytes = (await reportStore.get({ ownerId: record.payload.original_artifact_owner, reportId: item.report_id }))?.bytes || null;
        mime = 'application/pdf';
      } else if (record.service_id === 'bank-statement-analysis' && record.payload.source_id
        && ['audit.pdf', 'analysis.xlsx'].includes(item.name)) {
        bytes = await getBsaArtifact(record.payload.source_id, record.payload.original_artifact_owner, item.name);
        mime = item.name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else if (record.service_id === 'ejari-verification' && item.name === 'certificate.pdf'
        && record.payload.source_id) {
        bytes = await ejariStore?.getCertificate(record.payload.source_id, workspaceId);
        mime = 'application/pdf';
      } else if (reconciledCaseServices.has(record.service_id) && record.payload.source_id
        && ['photo', 'signature'].includes(item.name)) {
        bytes = await documentOcrStore.getArtifact(workspaceId, record.payload.source_id, item.name);
        mime = 'image/png';
      }
      if (!bytes) return json(res, 404, { status: 'Error', error: 'Artifact was not found.' });
      res.writeHead(200, { 'content-type': mime, 'content-length': bytes.length,
        'content-disposition': `attachment; filename="case-artifact-${match[3]}${mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : '.xlsx'}"`,
        'cache-control': 'private, no-store' });
      return res.end(bytes);
    }
    const { payload, ...publicRecord } = record;
    return json(res, 200, { case: publicRecord,
      response: record.service_id.endsWith('-ocr') || record.service_id === 'moa-analysis'
        ? presentDocumentOcrResponse(payload?.final_response ?? null) : payload?.final_response ?? null,
      artifacts: payload?.artifact_refs?.map((item, index) => ({ index, type: item.type,
        name: item.name || (item.report_id ? 'PDF report' : 'Artifact') })) || [] }, { 'cache-control': 'private, no-store' });
  }

  if (url.pathname === '/portal/api/keys' || /^\/portal\/api\/keys\/[a-f0-9]{16}\/(rotate|revoke)$/.test(url.pathname)) {
    const { account, session } = await currentPortalSession(req, store);
    if (!session) return json(res, 401, { status: 'Error', error: 'Sign in to continue.' });
    if (req.method !== 'GET' && (!sameOrigin(req) || String(req.headers['x-ai7-csrf'] || '') !== session.csrf)) {
      return json(res, 403, { status: 'Error', error: 'The security token is missing or invalid.' });
    }
    const keys = (await store.listClients()).filter((item) => item.workspaceId === account.client_id);
    if (req.method === 'GET' && url.pathname === '/portal/api/keys') return json(res, 200, { keys });
    if (req.method === 'POST' && url.pathname === '/portal/api/keys') {
      try {
        const body = await readJson(req);
        const label = String(body.label || '').trim();
        if (!label || label.length > 60) return json(res, 400, { status: 'Error', error: 'Key label must be 1–60 characters.' });
        const idempotencyKey = String(req.headers['idempotency-key'] || '');
        if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) return json(res, 400, {
          status: 'Error', error: 'A unique Idempotency-Key header is required to create an API key.'
        });
        const issued = await store.createClientIdempotent(account.client_name,
          { workspaceId: account.client_id, label, ownerEmail: account.email }, idempotencyKey);
        return json(res, issued.reused ? 200 : 201, { key: issued.client, api_key: issued.apiKey,
          notice: issued.reused ? 'The existing key for this request is shown again. Copy it now.' : 'Copy this key now. It cannot be retrieved later.' });
      } catch (error) {
        if (error.message === 'idempotency_conflict') return json(res, 409, { status: 'Error', error: 'This request ID was already used for a changed or inactive key.' });
        if (error.message === 'workspace_key_limit_reached') return json(res, 409, { status: 'Error', error: 'This workspace has reached its active key limit.' });
        if (error.message === 'workspace_key_lock_busy') return json(res, 503, { status: 'Error', error: 'Key creation is busy. Retry with the same request ID.' }, { 'retry-after': '2' });
        return json(res, error.statusCode || 503, { status: 'Error', error: 'Key creation is temporarily unavailable. Retry with the same request ID.' });
      }
    }
    const keyId = url.pathname.split('/')[4];
    if (req.method === 'POST' && url.pathname.endsWith('/rotate')) {
      const rotated = await store.rotateClient(keyId, account.client_id);
      return rotated ? json(res, 200, { key: rotated.client, api_key: rotated.apiKey, notice: 'The previous key is invalid. Copy this replacement now.' })
        : json(res, 404, { status: 'Error', error: 'Active key was not found in this workspace.' });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/revoke')) {
      if (!keys.some((item) => item.id === keyId)) return json(res, 404, { status: 'Error', error: 'Key was not found in this workspace.' });
      const revoked = await store.revokeClient(keyId);
      return json(res, 200, { key: revoked });
    }
  }

  if (req.method === 'GET' && url.pathname === '/portal/api/health') {
    const { account, session } = await currentPortalSession(req, store);
    if (!session) return json(res, 401, { status: 'Error', error: 'Sign in to continue.' });
    return json(res, 200, await customerServiceHealth(store, usageStore, account.client_id));
  }

  if (req.method === 'GET' && (url.pathname === '/portal/api/usage' || url.pathname === '/portal/api/entitlements')) {
    const { account, session } = await currentPortalSession(req, store);
    if (!session) return json(res, 401, { status: 'Error', error: 'Sign in to continue.' });
    const managed = Boolean((await store.getCustomer?.(account.client_id))?.usagePolicyVersion);
    const usage = await usageStore.account(account.client_id, managed);
    return json(res, 200, url.pathname.endsWith('/entitlements')
      ? { allowed_modules: usage.allowed_modules,
          available_modules: moduleCatalog(await store.listIntegrations({ publicOnly: true })).filter((module) => module.available).map((module) => module.id),
          mode: usage.mode, balance: usage.balance, currency: usage.currency }
      : { account: usage, logs: await usageStore.logs(account.client_id, 100) });
  }

  return json(res, 404, { status: 'Error', error: 'Portal operation was not found.' });
}

function wantsHtml(req) {
  return String(req.headers.accept || '').toLowerCase().includes('text/html');
}

function portalPagePath(pathname) {
  return pathname === '/index.html' ? '/' : pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
}

function protectedPortalPath(pathname) {
  const page = portalPagePath(pathname);
  return ['/', '/iban', '/entity-search', '/adverse-media', '/merchant-screening', '/bank-statement-analysis', '/ejari-verification', '/forms', '/account', '/cases'].includes(page)
    || /^\/forms\/[a-z0-9-]+$/.test(page)
    || /^\/document-extraction\/[a-z0-9-]+$/.test(page);
}

async function serviceHealth(store) {
  const integrations = await store.listIntegrations({ publicOnly: true });
  const checks = integrations.map((item) => ({ id: item.id, name: item.name, path: item.publicPath, status: item.enabled ? 'enabled' : 'disabled' }));
  checks.push({ id: 'bank-statement-analysis', name: 'Bank Statement Analysis', path: '/service/bank_statement_analysis', status: bsaEnabled() ? 'enabled' : 'disabled' });
  return {
    status: 'api_reachable', checked_at: new Date().toISOString(),
    checks,
    upstream_probe: 'not_performed'
  };
}

async function customerServiceHealth(store, usageStore, workspaceId) {
  const managed = Boolean((await store.getCustomer?.(workspaceId))?.usagePolicyVersion);
  const usage = await usageStore.account(workspaceId, managed);
  const health = await serviceHealth(store);
  const allowed = new Set(usage.allowed_modules);
  return { ...health, checks: health.checks.filter((check) => allowed.has('*') || allowed.has(check.id)) };
}

function portalLoginRedirect(res, pathname, search = '') {
  const next = `${pathname}${search}`;
  res.writeHead(302, { location: `/login?next=${encodeURIComponent(next)}`, 'cache-control': 'no-store' });
  res.end();
}

async function currentAdminSession(req, store) {
  const account = await store.getAdminAccount({ fresh: true });
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

async function handleAdminApi(req, res, url, store, loginThrottle, resetThrottle, mailer, otpStore, usageStore, documentOcrStore) {
  if (req.method === 'GET' && url.pathname === '/admin/api/auth/status') {
    const account = await store.getAdminAccount();
    return json(res, 200, { configured: Boolean(account) });
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/auth/forgot-password') {
    return requestPasswordReset(req, res, { kind: 'admin', store, throttle: resetThrottle, mailer });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/auth/reset-password') {
    return completePasswordReset(req, res, { kind: 'admin', store, mailer });
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/auth/setup') {
    if (await store.getAdminAccount()) return json(res, 409, { status: 'Error', error: 'The administrator account is already configured.' });
    if (!(await store.isAdminKey(bearerToken(req)))) return json(res, 401, { status: 'Error', error: 'The one-time setup key is missing or incorrect.' });
    if (!mailer.configured || !mailer.sendLoginCode || !otpStore) return json(res, 503,
      { status: 'Error', error: 'Account setup is temporarily unavailable.' });
    try {
      const body = await readJson(req);
      const account = createAdminAccount(body.email, body.password);
      const signingKey = newSigningKey();
      await store.setAdminSessionKey(signingKey);
      await store.setAdminAccount(account);
      return json(res, 201, { account: safeAdminAccount(account), message: 'Administrator account created. Sign in to receive an email code.' });
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
      return beginEmailLogin(res, { kind: 'admin', account, signingKey, mailer, otpStore });
    } catch (error) {
      return json(res, error.statusCode || 400, { status: 'Error', error: 'The sign-in request is invalid.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/auth/verify-code') {
    try {
      const body = await readJson(req);
      const account = await store.getAdminAccount({ fresh: true });
      const signingKey = await store.getAdminSessionKey();
      if (normalizeAdminEmail(body.email) !== account?.email
        || !(await consumeEmailLogin(req, { kind: 'admin', body, account, signingKey, otpStore }))) {
        return json(res, 401, { status: 'Error', error: 'The code is invalid or expired.' });
      }
      const created = createAdminSession(account, signingKey);
      return json(res, 200, { account: safeAdminAccount(account), csrf_token: created.csrfToken,
        expires_in: created.expiresIn }, { 'set-cookie': adminCookie(created.token, { secure: secureRequest(req) }) });
    } catch {
      return json(res, 503, { status: 'Error', error: 'Email sign-in is temporarily unavailable.' });
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
      try { await mailer.sendSecurityAlert({ to: account.email, event: 'changed' }); }
      catch { console.warn('platform_security_alert_failed'); }
      const signingKey = await store.getAdminSessionKey();
      const created = createAdminSession(account, signingKey);
      return json(res, 200, { account: safeAdminAccount(account), csrf_token: created.csrfToken, expires_in: created.expiresIn }, { 'set-cookie': adminCookie(created.token, { secure: secureRequest(req) }) });
    } catch (error) {
      return json(res, 400, { status: 'Error', error: error.message });
    }
  }

  const access = await requireAdmin(req, res, store, { csrf: !['GET', 'HEAD'].includes(req.method || 'GET') });
  if (!access) return;

  if (req.method === 'GET' && url.pathname === '/admin/api/document-ocr/capability') {
    if (access.legacy) return json(res, 409, { status: 'Error', error: 'Complete account setup first.' });
    const capability = documentOcrStore?.getWorkerCapability
      ? await documentOcrStore.getWorkerCapability() : { azure: false, paddle: false, ollama: false,
        recent: false, checkedAt: null };
    capability.imageMatches = Boolean(process.env.DOCUMENT_OCR_WORKER_IMAGE
      && capability.imageDigest === process.env.DOCUMENT_OCR_WORKER_IMAGE);
    capability.forceOllama = process.env.DOCUMENT_OCR_FORCE_OLLAMA === '1';
    return json(res, 200, { capability });
  }
  const engineMatch = /^\/admin\/api\/document-ocr\/engines\/([a-z0-9-]+)$/.exec(url.pathname);
  if (req.method === 'PUT' && engineMatch) {
    if (access.legacy) return json(res, 409, { status: 'Error', error: 'Complete account setup first.' });
    if (!DOCUMENT_OCR_BY_ID.has(engineMatch[1])) return json(res, 404, { status: 'Error', error: 'OCR API not found.' });
    try {
      const body = await readJson(req);
      if (!['azure', 'paddle', 'ollama'].includes(body.engine)) return json(res, 400, { status: 'Error', error: 'Invalid extraction engine.' });
      if (process.env.DOCUMENT_OCR_FORCE_OLLAMA === '1' && body.engine !== 'ollama')
        return json(res, 409, { status: 'Error', error: 'Ollama is required for document extraction.' });
      if (body.engine === 'paddle' || body.engine === 'ollama') {
        const capability = documentOcrStore?.getWorkerCapability ? await documentOcrStore.getWorkerCapability() : null;
        const imageMatches = Boolean(process.env.DOCUMENT_OCR_WORKER_IMAGE
          && capability?.imageDigest === process.env.DOCUMENT_OCR_WORKER_IMAGE);
        if (!capability?.[body.engine] || !capability.recent
          || (process.env.DOCUMENT_OCR_WORKER_IMAGE && !imageMatches))
          return json(res, 409, { status: 'Error', error: 'Selected OCR worker capability is not currently verified.' });
      }
      return json(res, 200, await store.setDocumentOcrEngine(engineMatch[1], body.engine, access.account.email));
    } catch (error) {
      return json(res, 503, { status: 'Error', error: 'Extraction setting could not be saved.' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/modules') {
    return json(res, 200, { modules: moduleCatalog(await store.listIntegrations({ publicOnly: true })) });
  }
  const usageMatch = /^\/admin\/api\/customers\/([a-f0-9]{16})\/(usage|credit)$/.exec(url.pathname);
  if (usageMatch) {
    const workspaceId = usageMatch[1];
    const customer = await store.getCustomer(workspaceId);
    const legacy = !customer && (await store.listClients()).some((key) => key.workspaceId === workspaceId);
    if (!customer && !legacy) return json(res, 404, { status: 'Error', error: 'Customer workspace was not found.' });
    const managed = Boolean(customer?.usagePolicyVersion);
    try {
      if (req.method === 'GET' && usageMatch[2] === 'usage') {
        return json(res, 200, { account: await usageStore.account(workspaceId, managed), logs: await usageStore.logs(workspaceId, 100), credits: await usageStore.credits(workspaceId, 100) });
      }
      if (req.method === 'PUT' && usageMatch[2] === 'usage') {
        const policy = validateUsagePolicy(await readJson(req), new Set(moduleCatalog(await store.listIntegrations({ publicOnly: true })).map((item) => item.id)));
        return json(res, 200, { account: await usageStore.configure(workspaceId, policy, managed) });
      }
      if (req.method === 'POST' && usageMatch[2] === 'credit') {
        const amount = moneyMicros((await readJson(req)).amount);
        if (amount <= 0) return json(res, 400, { status: 'Error', error: 'Credit amount must be greater than zero.' });
        const idempotencyKey = String(req.headers['idempotency-key'] || '');
        if (idempotencyKey && !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
          return json(res, 400, { status: 'Error', error: 'Invalid Idempotency-Key header.' });
        }
        return json(res, 200, { account: await usageStore.addCredit(workspaceId, amount, managed, { idempotencyKey, actor: access.account?.email || 'legacy-admin' }) });
      }
    } catch (error) {
      return json(res, error.statusCode || 400, { status: 'Error', error: error.message === 'usage_meter_unavailable' ? 'Usage meter is unavailable.' : error.message });
    }
    return json(res, 405, { status: 'Error', error: 'Method is not supported.' });
  }

  if (url.pathname === '/admin/api/bsa' || url.pathname.startsWith('/admin/api/bsa/')) {
    if (access.legacy) return json(res, 409, { status: 'Error', error: 'Complete account setup first.' });
    return handleBsa(req, res, url, store, access.account);
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/integrations') {
    return json(res, 200, { integrations: await store.listIntegrations() });
  }

  if (url.pathname === '/admin/api/ejari/config') {
    if (access.legacy) return json(res, 409, { status: 'Error', error: 'Complete account setup first.' });
    if (req.method === 'GET') return json(res, 200, { platformAvailable: process.env.EJARI_PLATFORM_ENABLED === '1',
      config: await store.getEjariConfig() });
    if (req.method === 'PUT') {
      try {
        const input = await readJson(req, 4096);
        const current = await store.getEjariConfig();
        const ocr_model = String(input.ocr_model || 'gpt-6-luna').trim();
        const ocr_detail = String(input.ocr_detail || 'high').trim();
        const openai_key = String(input.openai_key || '');
        const capsolver_key = String(input.capsolver_key || '');
        const enabled = input.enabled === true;
        if (!/^[a-z0-9][a-z0-9.-]{2,79}$/.test(ocr_model) || !['low', 'high', 'auto', 'original'].includes(ocr_detail)
          || [openai_key, capsolver_key].some((key) => key && (key.length > 512 || /[\r\n\0]/.test(key)))) {
          return json(res, 400, { status: 'Error', error: 'Invalid Ejari model, detail, or credential value.' });
        }
        if (enabled && (!((current.openaiKeyConfigured || openai_key) && (current.capsolverKeyConfigured || capsolver_key)))) {
          return json(res, 400, { status: 'Error', error: 'Set both the OpenAI and CapSolver keys before enabling Ejari.' });
        }
        if (enabled && process.env.EJARI_PLATFORM_ENABLED !== '1') return json(res, 409, { status: 'Error',
          error: 'Deploy the private Ejari worker and storage before enabling this API.' });
        return json(res, 200, { config: await store.saveEjariConfig({ enabled, ocr_model, ocr_detail, openai_key, capsolver_key }) });
      } catch { return json(res, 503, { status: 'Error', error: 'Ejari configuration could not be saved.' }); }
    }
    return json(res, 405, { status: 'Error', error: 'Method not allowed.' });
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

  if (req.method === 'GET' && url.pathname === '/admin/api/customers') {
    const [customers, keys] = await Promise.all([store.listCustomers(), store.listClients()]);
    const known = new Set(customers.map((item) => item.id));
    const legacy = [...new Map(keys.filter((item) => !known.has(item.workspaceId)).map((item) => [item.workspaceId, {
      id: item.workspaceId, name: item.name, adminEmail: '', status: 'legacy', createdAt: item.createdAt
    }])).values()];
    return json(res, 200, { customers: [...customers.map(publicCustomer), ...legacy], keys });
  }

  if (req.method === 'POST' && /^\/admin\/api\/customers\/[a-f0-9]{16}\/invite$/.test(url.pathname)) {
    try {
      const id = url.pathname.split('/')[4];
      const legacy = await store.getClient(id);
      if (!legacy || legacy.workspaceId !== id || legacy.status !== 'active' || await store.getCustomer(id)) {
        return json(res, 404, { status: 'Error', error: 'Existing customer workspace was not found.' });
      }
      const body = await readJson(req);
      const adminEmail = validEmail(body.admin_email);
      if (!adminEmail) return json(res, 400, { status: 'Error', error: 'Enter a valid administrator email.' });
      if (!mailer.configured) return json(res, 503, { status: 'Error', error: 'Invitation email is temporarily unavailable.' });
      if (await store.getPortalUser(adminEmail) || (await store.listCustomers()).some((item) => item.adminEmail === adminEmail)) {
        return json(res, 409, { status: 'Error', error: 'This email already has a workspace invitation or account.' });
      }
      const invitation = createInvitation(id);
      const timestamp = new Date().toISOString();
      const customer = { id, name: legacy.name, adminEmail, status: 'pending', invitationHash: invitation.tokenHash,
        invitationExpiresAt: invitation.expiresAt, createdAt: timestamp, updatedAt: timestamp };
      await store.setCustomer(customer);
      let delivery = 'sent';
      try {
        await mailer.sendInvitation({ to: adminEmail, customerName: legacy.name,
          url: `${process.env.APP_PUBLIC_BASE_URL || 'https://app.kycprobe.com'}/login#invite=${encodeURIComponent(invitation.token)}`,
          hours: INVITATION_HOURS });
      } catch { delivery = 'failed'; console.warn('platform_invitation_email_failed'); }
      return json(res, 201, { customer: publicCustomer(customer), delivery });
    } catch (error) {
      return json(res, error.statusCode || 500, { status: 'Error', error: error.statusCode ? 'The request is invalid.' : 'The invitation could not be created.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/customers') {
    try {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      const adminEmail = validEmail(body.admin_email);
      if (name.length < 2 || name.length > 100 || !adminEmail) return json(res, 400, { status: 'Error', error: 'Enter a customer name and valid administrator email.' });
      if (!mailer.configured) return json(res, 503, { status: 'Error', error: 'Invitation email is temporarily unavailable.' });
      if (await store.getPortalUser(adminEmail) || (await store.listCustomers()).some((item) => item.adminEmail === adminEmail)) {
        return json(res, 409, { status: 'Error', error: 'This email already has a workspace invitation or account.' });
      }
      const id = randomBytes(8).toString('hex');
      const invitation = createInvitation(id);
      const timestamp = new Date().toISOString();
      const customer = { id, name, adminEmail, status: 'pending', usagePolicyVersion: 1, invitationHash: invitation.tokenHash,
        invitationExpiresAt: invitation.expiresAt, createdAt: timestamp, updatedAt: timestamp };
      await store.setCustomer(customer);
      let delivery = 'sent';
      try {
        await mailer.sendInvitation({ to: adminEmail, customerName: name,
          url: `${process.env.APP_PUBLIC_BASE_URL || 'https://app.kycprobe.com'}/login#invite=${encodeURIComponent(invitation.token)}`,
          hours: INVITATION_HOURS });
      } catch { delivery = 'failed'; console.warn('platform_invitation_email_failed'); }
      return json(res, 201, { customer: publicCustomer(customer), delivery });
    } catch (error) {
      return json(res, error.statusCode || 500, { status: 'Error', error: error.statusCode ? 'The request is invalid.' : 'The invitation could not be created.' });
    }
  }

  if (req.method === 'POST' && /^\/admin\/api\/customers\/[a-f0-9]{16}\/resend$/.test(url.pathname)) {
    const id = url.pathname.split('/')[4];
    const customer = await store.getCustomer(id);
    if (!customer || customer.status !== 'pending') return json(res, 404, { status: 'Error', error: 'Pending invitation was not found.' });
    if (!mailer.configured) return json(res, 503, { status: 'Error', error: 'Invitation email is temporarily unavailable.' });
    const invitation = createInvitation(id);
    const updated = { ...customer, invitationHash: invitation.tokenHash, invitationExpiresAt: invitation.expiresAt, updatedAt: new Date().toISOString() };
    await store.setCustomer(updated);
    try {
      await mailer.sendInvitation({ to: customer.adminEmail, customerName: customer.name,
        url: `${process.env.APP_PUBLIC_BASE_URL || 'https://app.kycprobe.com'}/login#invite=${encodeURIComponent(invitation.token)}`,
        hours: INVITATION_HOURS });
      return json(res, 200, { customer: publicCustomer(updated), delivery: 'sent' });
    } catch { console.warn('platform_invitation_email_failed'); return json(res, 503, { customer: publicCustomer(updated), delivery: 'failed', error: 'Invitation email could not be sent.' }); }
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/clients') {
    try {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      if (name.length < 2 || name.length > 100) return json(res, 400, { status: 'Error', error: 'Client name must be between 2 and 100 characters.' });
      if (body.recipient_email) return json(res, 400, { status: 'Error', error: 'API keys cannot be emailed. Invite the customer administrator instead.' });
      const created = await store.createClient(name);
      return json(res, 201, { ...created, delivery: 'not_requested', notice: 'Copy this API key now. It will not be shown again.' });
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

async function sendEjariCertificate(res, ejariStore, jobId, workspaceId) {
  const bytes = await ejariStore.getCertificate(jobId, workspaceId);
  if (!bytes) return json(res, 404, { status: 'Error', error: 'Certificate was not found.' });
  res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.length,
    'content-disposition': `attachment; filename="${jobId}.pdf"`, 'cache-control': 'private, no-store' });
  return res.end(bytes);
}

async function handleEjari(req, res, url, store, ejariStore, usageStore) {
  const rootPath = '/service/dubai_ejari_verification';
  const token = bearerToken(req);
  if (!req.ai7Client && !(await store.isClientKey(token))) return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  if (process.env.EJARI_PLATFORM_ENABLED !== '1' || !ejariStore) return json(res, 503, {
    status: 'Error', reasonCode: 'EJARI_PLATFORM_UNAVAILABLE' });
  const workspaceId = req.ai7Client?.id || reportOwnerId(token);
  const artifact = /^\/service\/dubai_ejari_verification\/jobs\/(ejari_[0-9a-f-]{36})\/certificate\.pdf$/.exec(url.pathname);
  if (req.method === 'GET' && artifact) {
    return sendEjariCertificate(res, ejariStore, artifact[1], workspaceId);
  }
  const match = /^\/service\/dubai_ejari_verification\/jobs\/(ejari_[0-9a-f-]{36})(\/result)?$/.exec(url.pathname);
  if (req.method === 'GET' && match) {
    if (match[2]) {
      const record = await ejariStore.getResult(match[1], workspaceId);
      if (!record) return json(res, 404, { status: 'Error', error: 'Job was not found.' });
      if (!record.result) return json(res, 202, { jobId: match[1], status: record.job.status });
      return json(res, 200, { ...record.result,
        certificateUrl: record.result.certificateAvailable
          ? `https://app.kycprobe.com/portal/api/ejari/jobs/${match[1]}/certificate.pdf` : null });
    }
    const job = await ejariStore.getJob(match[1], workspaceId);
    return job ? json(res, 200, { jobId: job.id, status: job.status, receivedAt: job.receivedAt,
      completedAt: job.completedAt, expiresAt: job.expiresAt, reasonCode: job.reasonCode })
      : json(res, 404, { status: 'Error', error: 'Job was not found.' });
  }
  if (req.method !== 'POST' || url.pathname !== rootPath) return json(res, 404, { status: 'Error', error: 'Service was not found.' });
  const config = await store.getEjariConfig();
  if (!config.enabled || !config.openaiKeyConfigured || !config.capsolverKeyConfigured) return json(res, 503, {
    status: 'Error', reasonCode: 'EJARI_NOT_CONFIGURED' });
  const idempotencyKey = String(req.headers['idempotency-key'] || '');
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) return json(res, 400, {
    status: 'Error', reasonCode: 'INVALID_IDEMPOTENCY_KEY' });
  try {
    let fields;
    let pdfBytes = null;
    const contentType = String(req.headers['content-type'] || '');
    if (contentType.startsWith('application/json')) {
      fields = await readJson(req, 4096);
    } else if (contentType.startsWith('multipart/form-data;')) {
      const raw = await readBody(req, 10 * 1024 * 1024 + 262144);
      const form = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': contentType }, body: raw }).formData();
      const file = form.get('ejari_file');
      if (!(file instanceof File) || form.getAll('ejari_file').length !== 1) return json(res, 400, {
        status: 'Error', reasonCode: 'EJARI_PDF_REQUIRED' });
      if ([...form.keys()].some((key) => !['ejari_file', 'contract_number', 'dewa_number'].includes(key))
        || form.getAll('contract_number').length > 1 || form.getAll('dewa_number').length > 1) {
        return json(res, 400, { status: 'Error', reasonCode: 'INVALID_REQUEST_FIELDS' });
      }
      pdfBytes = Buffer.from(await file.arrayBuffer());
      if (!pdfBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return json(res, 415, {
        status: 'Error', reasonCode: 'PDF_REQUIRED' });
      if (pdfBytes.length > 10 * 1024 * 1024) return json(res, 413, {
        status: 'Error', reasonCode: 'PDF_TOO_LARGE' });
      fields = { contract_number: form.get('contract_number'), dewa_number: form.get('dewa_number') };
    } else return json(res, 415, { status: 'Error', reasonCode: 'UNSUPPORTED_CONTENT_TYPE' });
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('invalid_request');
    const contract = fields.contract_number == null ? '' : String(fields.contract_number).trim();
    const dewa = fields.dewa_number == null ? '' : String(fields.dewa_number).trim();
    if ((contract && !/^0\d{13,16}$/.test(contract)) || (dewa && !/^\d{8,11}$/.test(dewa))
      || (!pdfBytes && (!contract || !dewa)) || Object.keys(fields).some((key) => !['contract_number', 'dewa_number'].includes(key))) {
      throw new Error('invalid_request');
    }
    const created = await ejariStore.createJob({ workspaceId, idempotencyKey,
      fields: { contract_number: contract || null, dewa_number: dewa || null, input_pdf: Boolean(pdfBytes) }, pdfBytes });
    if (created.reused && req.ai7Usage) await usageStore.settleAsyncResult(req.ai7Usage.workspaceId,
      req.ai7Usage.logKey, { successful: false, reason: 'idempotency_replay' });
    const path = `${rootPath}/jobs/${created.job.id}`;
    return json(res, 202, { jobId: created.job.id, status: created.job.status,
      statusUrl: path, resultUrl: `${path}/result`, reused: created.reused });
  } catch (error) {
    if (error.message === 'idempotency_conflict') return json(res, 409, { status: 'Error', reasonCode: 'IDEMPOTENCY_CONFLICT' });
    if (error.message === 'idempotency_expired') return json(res, 409, { status: 'Error', reasonCode: 'IDEMPOTENCY_KEY_EXPIRED' });
    if (error.message === 'invalid_request' || error instanceof TypeError || error instanceof SyntaxError) return json(res, 400, {
      status: 'Error', reasonCode: 'INVALID_REQUEST_FIELDS' });
    if (error.message === 'request_too_large') return json(res, 413, { status: 'Error', reasonCode: 'PDF_TOO_LARGE' });
    return json(res, 503, { status: 'Error', reasonCode: 'EJARI_UNAVAILABLE' });
  }
}

async function handleBsa(req, res, url, store, adminAccount = null) {
  if (!bsaEnabled()) return json(res, 503, { status: 'Error', reasonCode: 'BSA_UNAVAILABLE', error: 'Bank statement analysis is not configured.' });
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.BSA_DATA_KEY_HEX || '')) return json(res, 503, { status: 'Error', reasonCode: 'BSA_ENCRYPTION_UNAVAILABLE' });
  const admin = Boolean(adminAccount);
  const token = admin ? null : bearerToken(req);
  if (!admin && !req.ai7Client && !(await store.isClientKey(token))) return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  const ownerId = reportOwnerId(admin ? `admin:${adminAccount.email}` : token);
  const rootPath = admin ? '/admin/api/bsa' : '/service/bank_statement_analysis';
  if (admin && req.method === 'GET' && url.pathname === `${rootPath}/config`) {
    const managed = bsaCapabilities();
    if (managed) return json(res, 200, managed);
    let engines = {};
    let workerOnline = false;
    try {
      const path = join(process.env.BSA_DATA_DIR || join(process.cwd(), '.local-bsa'), 'worker-capabilities.json');
      workerOnline = Date.now() - statSync(path).mtimeMs < 15 * 1000;
      if (workerOnline) engines = JSON.parse(readFileSync(path, 'utf8'));
    } catch { /* Worker has not published readiness. */ }
    return json(res, 200, { enabled: workerOnline, mode: bsaMode(), engines });
  }
  const artifactMatch = new RegExp(`^${rootPath}/(bsa_[0-9a-f-]{36})/artifacts/(ledger\\.json|transactions\\.parquet|audit\\.pdf|analysis\\.xlsx)$`).exec(url.pathname);
  if (req.method === 'GET' && artifactMatch) {
    const bytes = await getBsaArtifact(artifactMatch[1], ownerId, artifactMatch[2]);
    if (!bytes) return json(res, 404, { status: 'Error', error: 'Artifact was not found.' });
    const contentType = artifactMatch[2].endsWith('.pdf') ? 'application/pdf' :
      artifactMatch[2].endsWith('.parquet') ? 'application/vnd.apache.parquet' :
        artifactMatch[2].endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/json';
    res.writeHead(200, { 'content-type': contentType, 'content-length': bytes.length,
      'content-disposition': `attachment; filename="${artifactMatch[2]}"`, 'cache-control': 'no-store' });
    return res.end(bytes);
  }
  const match = new RegExp(`^${rootPath}/(bsa_[0-9a-f-]{36})(/result)?$`).exec(url.pathname);
  if (req.method === 'GET' && match) {
    const record = match[2] ? await getBsaResult(match[1], ownerId) : { job: await getBsaJob(match[1], ownerId) };
    if (!record?.job) return json(res, 404, { status: 'Error', error: 'Analysis was not found.' });
    if (match[2]) {
      if (!record.result) return json(res, 202, { analysisId: match[1], status: record.job.status });
      return json(res, 200, presentBsaResult(record, match[1], rootPath));
    }
    return json(res, 200, { analysisId: match[1], status: record.job.status, receivedAt: record.job.receivedAt,
      completedAt: record.job.completedAt || null, reasonCodes: record.job.reasonCodes || [],
      callback: record.job.callback || { requested: false, status: 'not_requested' } });
  }
  if (req.method !== 'POST' || url.pathname !== rootPath) return json(res, 404, { status: 'Error', error: 'Service was not found.' });
  const idempotencyKey = String(req.headers['idempotency-key'] || '');
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return json(res, 400, { status: 'Error', reasonCode: 'INVALID_IDEMPOTENCY_KEY' });
  if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data;')) return json(res, 400, { status: 'Error', reasonCode: 'MULTIPART_REQUIRED' });
  try {
    const raw = await readBody(req, Number(process.env.BSA_MAX_UPLOAD_BYTES || 25 * 1024 * 1024) + 262144);
    const form = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
    const uploads = form.getAll('statement_file');
    if (!uploads.length || uploads.some((item) => !(item instanceof File))) return json(res, 400, { status: 'Error', reasonCode: 'STATEMENT_FILE_REQUIRED' });
    if (uploads.length > 100) return json(res, 400, { status: 'Error', reasonCode: 'FILE_COUNT_EXCEEDED' });
    const files = [];
    let totalBytes = 0;
    for (const upload of uploads) {
      const bytes = Buffer.from(await upload.arrayBuffer());
      totalBytes += bytes.length;
      if (totalBytes > Number(process.env.BSA_MAX_UPLOAD_BYTES || 25 * 1024 * 1024)) return json(res, 413, { status: 'Error', reasonCode: 'FILE_TOO_LARGE' });
      const mediaType = bytes.subarray(0, 5).toString('ascii') === '%PDF-' ? 'application/pdf'
        : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
          : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
            : (bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))) ? 'image/tiff' : null;
      if (!mediaType) return json(res, 415, { status: 'Error', reasonCode: 'UNSUPPORTED_FILE_TYPE' });
      if (upload.type && upload.type !== mediaType && !(mediaType === 'image/jpeg' && upload.type === 'image/jpg')) {
        return json(res, 415, { status: 'Error', reasonCode: 'MIME_SIGNATURE_MISMATCH' });
      }
      files.push({ bytes, mediaType });
    }
    if (files.length > 1 && files.some((item) => item.mediaType === 'application/pdf')) return json(res, 400, { status: 'Error', reasonCode: 'INVALID_FILE_BUNDLE' });
    const countryCode = String(form.get('country_code') || '').toUpperCase();
    const entityType = String(form.get('entity_type') || '');
    if (countryCode !== 'AE' || !['individual', 'sole_proprietor', 'company'].includes(entityType)) return json(res, 400, { status: 'Error', reasonCode: 'INVALID_REQUEST_FIELDS' });
    const fields = { countryCode, entityType };
    const declaredNames = form.get('declared_names');
    if (declaredNames) {
      const names = JSON.parse(String(declaredNames));
      if (!Array.isArray(names) || names.length > 10 || names.some((name) => typeof name !== 'string' || name.length > 150)) throw new Error('invalid_fields');
      fields.declaredNames = names;
    }
    const declaredEmployer = form.get('declared_employer');
    if (declaredEmployer !== null) {
      if (typeof declaredEmployer !== 'string' || declaredEmployer.length > 150) throw new Error('invalid_fields');
      fields.declaredEmployer = declaredEmployer;
    }
    const declaredIncome = form.get('declared_monthly_income');
    const declaredIncomeCurrency = form.get('declared_income_currency');
    if (declaredIncome !== null) {
      if (typeof declaredIncome !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,3})?$/.test(declaredIncome)
        || typeof declaredIncomeCurrency !== 'string' || !/^[A-Z]{3}$/.test(declaredIncomeCurrency)) throw new Error('invalid_fields');
      fields.declaredMonthlyIncome = declaredIncome;
      fields.declaredIncomeCurrency = declaredIncomeCurrency;
    } else if (declaredIncomeCurrency !== null) throw new Error('invalid_fields');
    const customerReference = form.get('customer_reference');
    if (customerReference !== null) {
      if (typeof customerReference !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(customerReference)) throw new Error('invalid_fields');
      fields.customerReference = customerReference;
    }
    const callbackUrl = form.get('callback_url');
    const callbackAccessKey = validateCallbackAccessKey(
      form.has('callback_access_key') ? form.get('callback_access_key') : undefined, callbackUrl);
    if (callbackUrl !== null) {
      if (typeof callbackUrl !== 'string' || !callbackUrl || callbackUrl.length > 2048) throw new Error('invalid_callback_url');
      let normalizedCallbackUrl;
      try {
        const parsedCallbackUrl = new URL(callbackUrl);
        if (parsedCallbackUrl.hash) throw new Error('callback_fragment_not_allowed');
        normalizedCallbackUrl = parsedCallbackUrl.toString();
        await validatePublicCallbackUrl(normalizedCallbackUrl);
      }
      catch { throw new Error('invalid_callback_url'); }
      fields.callback = {
        url: normalizedCallbackUrl,
        ...(callbackAccessKey ? { accessKey: callbackAccessKey } : {}),
        signingSecret: randomBytes(32).toString('base64url'),
        deliveryId: randomUUID(),
        apiRoot: rootPath
      };
    }
    if (form.has('reporting_currency')) return json(res, 400, { status: 'Error', reasonCode: 'FX_REPORTING_NOT_ENABLED' });
    const getPdf = form.get('get_pdf');
    if (getPdf !== null && getPdf !== 'true' && getPdf !== 'false') throw new Error('invalid_fields');
    fields.getPdf = getPdf === 'true';
    const getXlsx = form.get('get_xlsx');
    if (getXlsx !== null && getXlsx !== 'true' && getXlsx !== 'false') throw new Error('invalid_fields');
    fields.getXlsx = getXlsx === 'true';
    const creditModels = form.get('credit_models');
    if (creditModels !== null) {
      const models = JSON.parse(String(creditModels));
      const allowed = ['observed_repayment_ratio', 'residual_cash_flow', 'income_variability',
        'liquidity_runway', 'uae_dbr', 'business_dscr'];
      if (!Array.isArray(models) || models.length > allowed.length ||
          models.some((model) => typeof model !== 'string' || !allowed.includes(model)) ||
          new Set(models).size !== models.length) throw new Error('invalid_fields');
      fields.creditModels = models;
    } else fields.creditModels = [];
    const created = await createBsaJob({ ownerId, idempotencyKey, files, fields });
    const path = `${rootPath}/${created.job.id}`;
    const callback = created.job.callback?.requested ? {
      configured: true,
      event: 'bank_statement_analysis.completed',
      delivery_id: created.job.callback.deliveryId,
      signature_header: 'x-ai7-signature',
      signing_secret: created.reused ? undefined : fields.callback.signingSecret,
      signing_secret_returned: !created.reused
    } : { configured: false };
    return json(res, 202, { analysisId: created.job.id, status: created.job.status, receivedAt: created.job.receivedAt,
      statusUrl: path, resultUrl: `${path}/result`, callback, reused: created.reused,
      message: created.job.callback?.requested
        ? (created.reused
          ? 'The existing analysis will use its original callback signing secret; the secret is not shown again.'
          : 'The terminal result will be posted to the callback URL. Store the signing secret now; it is not shown again.')
        : undefined });
  } catch (error) {
    if (error.message === 'idempotency_conflict') return json(res, 409, { status: 'Error', reasonCode: 'IDEMPOTENCY_CONFLICT' });
    if (error.message === 'request_too_large') return json(res, 413, { status: 'Error', reasonCode: 'FILE_TOO_LARGE' });
    if (error.message === 'invalid_callback_access_key') return json(res, 400, { status: 'Error', reasonCode: 'INVALID_CALLBACK_ACCESS_KEY',
      error: 'callback_access_key requires callback_url and must be a 1–512 character Bearer token without whitespace.' });
    if (error.message === 'invalid_callback_url') return json(res, 400, { status: 'Error', reasonCode: 'INVALID_CALLBACK_URL',
      error: 'callback_url must be a public HTTPS URL without embedded credentials.' });
    if (error.message === 'invalid_fields' || error instanceof SyntaxError || error instanceof TypeError) return json(res, 400, { status: 'Error', reasonCode: 'INVALID_REQUEST_FIELDS' });
    return json(res, 503, { status: 'Error', reasonCode: 'ANALYSIS_UNAVAILABLE' });
  }
}

async function handleDocumentOcr(req, res, url, documentStore, usageStore, store) {
  const definition = DOCUMENT_OCR_BY_PATH.get(url.pathname);
  const jobMatch = /^\/service\/([a-z_]+)\/jobs\/(ocr_[0-9a-f-]{36})(?:\/(result|artifacts\/(photo|signature)))?$/.exec(url.pathname);
  const jobDefinition = jobMatch && DOCUMENT_OCR_BY_PATH.get(`/service/${jobMatch[1]}`);
  if (!definition && !jobDefinition) return false;
  if ((jobDefinition && req.method !== 'GET') || (definition && req.method !== 'POST')) {
    json(res, 405, { status: 'Error', error: `Method must be ${jobDefinition ? 'GET' : 'POST'}.` },
      { allow: jobDefinition ? 'GET' : 'POST' });
    return true;
  }
  if ((definition && !req.ai7Client) || (jobDefinition && !req.ai7Client && !url.searchParams.has('signature'))) {
    json(res, 401, { status: 'Error', error: 'An active customer API key or signed artifact URL is required.' });
    return true;
  }
  if ((process.env.NODE_ENV !== 'test' && process.env.DOCUMENT_OCR_PRODUCTION_ENABLED !== '1')
    || !documentStore || !/^[a-f0-9]{64}$/i.test(process.env.DOCUMENT_OCR_DATA_KEY_HEX || '')) {
    json(res, 503, { status: 'Error', reasonCode: 'DOCUMENT_OCR_UNAVAILABLE' });
    return true;
  }
  if (jobDefinition) {
    const artifactName = jobMatch[4];
    const workspaceId = req.ai7Client?.id || (artifactName ? documentOcrSignedAccess(url, jobMatch[2], artifactName) : null);
    if (!workspaceId) { json(res, 401, { status: 'Error', error: 'An active API key or signed artifact URL is required.' }); return true; }
    const job = await documentStore.getJob(workspaceId, jobMatch[2]);
    if (!job || job.service_id !== jobDefinition.id) { json(res, 404, { status: 'Error', error: 'Extraction was not found.' }); return true; }
    if (artifactName) {
      const bytes = await documentStore.getArtifact(workspaceId, jobMatch[2], artifactName);
      if (!bytes) { json(res, 404, { status: 'Error', error: 'Artifact was not found.' }); return true; }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length,
        'content-disposition': `attachment; filename="${artifactName}.png"`, 'cache-control': 'private, no-store' });
      res.end(bytes);
      return true;
    }
    if (jobMatch[3] === 'result') {
      const record = await documentStore.getResult(workspaceId, jobMatch[2]);
      if (!record.result) { json(res, record.job.status === 'failed' ? 422 : 202,
        { job: presentDocumentOcrResponse(record.job) }); return true; }
      const result = { ...record.result };
      if (Array.isArray(result.artifacts)) result.artifacts = result.artifacts.map((item) => ({
        ...item, download_url: documentOcrArtifactUrl(jobDefinition, workspaceId, jobMatch[2], item.name)
      }));
      json(res, 200, presentDocumentOcrResponse(result));
      return true;
    }
    json(res, 200, { job: presentDocumentOcrResponse(job) });
    return true;
  }
  if (!req.ai7Client) { json(res, 401, { status: 'Error', error: 'An active customer API key is required.' }); return true; }
  const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
    json(res, 400, { status: 'Error', reasonCode: 'INVALID_IDEMPOTENCY_KEY' }); return true;
  }
  if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data;')) {
    json(res, 400, { status: 'Error', reasonCode: 'MULTIPART_REQUIRED' }); return true;
  }
  try {
    const maxBytes = 25 * 1024 * 1024;
    const raw = await readBody(req, maxBytes + 262144);
    const form = await new Request('http://localhost/', { method: 'POST',
      headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
    const primary = form.getAll('file');
    const secondary = form.getAll('additional_file');
    if (primary.length !== 1 || !(primary[0] instanceof File) || secondary.length > definition.maxFiles - 1
      || secondary.some((item) => !(item instanceof File))) {
      json(res, 400, { status: 'Error', reasonCode: 'INVALID_DOCUMENT_FILES' }); return true;
    }
    const files = [];
    let totalBytes = 0;
    for (const upload of [...primary, ...secondary]) {
      const bytes = Buffer.from(await upload.arrayBuffer());
      totalBytes += bytes.length;
      if (!bytes.length || totalBytes > maxBytes) { json(res, 413, { status: 'Error', reasonCode: 'FILE_TOO_LARGE' }); return true; }
      const mediaType = bytes.subarray(0, 5).toString('ascii') === '%PDF-' ? 'application/pdf'
        : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
          : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null;
      if (!mediaType || (upload.type && upload.type !== mediaType && !(mediaType === 'image/jpeg' && upload.type === 'image/jpg'))) {
        json(res, 415, { status: 'Error', reasonCode: 'UNSUPPORTED_FILE_TYPE' }); return true;
      }
      files.push({ bytes, mediaType });
    }
    const extractionEngine = store.getDocumentOcrEngine ? await store.getDocumentOcrEngine(definition.id) : 'ollama';
    if (extractionEngine === 'ollama' && process.env.NODE_ENV !== 'test') {
      const capability = documentStore.getWorkerCapability ? await documentStore.getWorkerCapability() : null;
      if (!capability?.ollama || !process.env.DOCUMENT_OCR_WORKER_IMAGE
        || capability.imageDigest !== process.env.DOCUMENT_OCR_WORKER_IMAGE) {
        json(res, 503, { status: 'Error', reasonCode: 'DOCUMENT_OCR_WORKER_NOT_READY' }); return true;
      }
    }
    const created = await documentStore.createJob({ ownerId: req.ai7Client.id, serviceId: definition.id,
      extractionEngine,
      files, idempotencyKey, transactionId: res.getHeader('x-ai7-transaction-id'),
      billingLogKey: req.ai7Usage?.logKey || '' });
    if (created.reused && req.ai7Usage) {
      await usageStore.settleAsyncResult(req.ai7Usage.workspaceId, req.ai7Usage.logKey, {
        successful: false, reason: 'idempotency_replay'
      });
    }
    const path = `${definition.publicPath}/jobs/${created.job.id}`;
    json(res, 202, presentDocumentOcrResponse({ ...created.job, reused: created.reused,
      status_url: path, result_url: `${path}/result` }));
    return true;
  } catch (error) {
    if (error.message === 'document_ocr_idempotency_conflict') json(res, 409, { status: 'Error', reasonCode: 'IDEMPOTENCY_CONFLICT' });
    else if (error.message === 'request_too_large') json(res, 413, { status: 'Error', reasonCode: 'FILE_TOO_LARGE' });
    else json(res, 503, { status: 'Error', reasonCode: 'DOCUMENT_OCR_SUBMISSION_UNAVAILABLE' });
    return true;
  }
}

export function createAppServer({ store = createStore(), mailer = createPlatformMailer(), fetchImpl = fetch,
  otpStore = createLoginOtpStore(),
  deepResearchQueue = process.env.ADVERSE_MEDIA_WORKER_ENABLED === 'false' ? null : createDeepResearchQueue(),
  formsQueue = createFormsQueue(), formSubmissionStore = createFormsSubmissionStore(),
  reportStore = createAdverseMediaReportStore(), jsonStore = createAdverseMediaJsonStore(),
  documentOcrStore = createDocumentOcrStore(),
  ejariStore = createEjariStore(),
  usageStore = createCustomerUsageStore(),
  caseStore = createCaseManagerStore(),
  merchantScreener = configuredMerchantScreener, requestCapacity = createRequestCapacity(),
  startWorker = process.env.NODE_ENV !== 'test' } = {}) {
  const loginThrottle = createLoginThrottle();
  const portalLoginThrottle = createLoginThrottle();
  const resetThrottle = createLoginThrottle();
  if (startWorker && deepResearchQueue && process.env.ADVERSE_MEDIA_WORKER_ENABLED !== 'false') {
    startDeepResearchWorker({
      queue: deepResearchQueue,
      store,
      resultStore: reportStore,
      screen: screenAdverseMedia,
      present: presentAdverseMediaResponse,
      finalize: async ({ job, response, aiApiKey, costGuard }) => finalizeAdverseMediaReport({
        request: job.request, response, ownerId: job.owner_id, origin: job.request_origin,
        aiApiKey, fetchImpl: costGuard.fetch, reportStore, jsonStore, reportId: job.report_id,
        inputPayload: job.input_payload || job.request, transactionId: job.transaction_id || null
      }),
      fetchImpl,
      onFinal: async (job, response) => {
        if (process.env.CASE_MANAGER_ENABLED !== 'true' || !caseStore || !job.case_id || !job.case_workspace_id) return;
        const mapping = caseOutcome('adverse-media', response, { httpStatus: 200 });
        try {
          await caseStore.captureFinal(job.case_workspace_id, job.case_id, { response, contentType: 'application/json',
            httpStatus: 200, outcome: mapping.outcome, reasonCodes: mapping.reasonCodes,
            originalArtifactOwner: job.owner_id,
            artifactRefs: response.report?.report_id ? [{ type: 'adverse_media', report_id: response.report.report_id }] : [] });
        } catch {
          await caseStore.markIncomplete(job.case_workspace_id, job.case_id).catch(() => {});
          console.warn('case_manager_capture_failed', JSON.stringify({ case_id: job.case_id }));
        }
      }
    });
  }
  if (startWorker && formsQueue) {
    startFormsWorker({
      queue: formsQueue,
      execute: (job) => executeFormsJob({ job, store, fetchImpl, merchantScreener, reportStore, requestCapacity }),
      onResult: async (job, result) => {
        if (job.idempotency) await formSubmissionStore.accept(job.idempotency);
        if (job.billing?.workspace_id && job.billing?.log_key)
          await usageStore.settleFormResult(job.billing.workspace_id, job.billing.log_key, result.services);
        if (process.env.CASE_MANAGER_ENABLED === 'true' && caseStore && job.case_id && job.billing?.workspace_id) {
          const mapping = caseOutcome('forms', result, { httpStatus: 200 });
          try {
            await caseStore.captureFinal(job.billing.workspace_id, job.case_id, { response: result,
              contentType: 'application/json', httpStatus: 200, outcome: mapping.outcome, reasonCodes: mapping.reasonCodes,
              originalArtifactOwner: job.owner_id,
              artifactRefs: result.report?.report_id ? [{ type: 'forms', report_id: result.report.report_id }] : [] });
          } catch {
            await caseStore.markIncomplete(job.billing.workspace_id, job.case_id).catch(() => {});
            console.warn('case_manager_capture_failed', JSON.stringify({ case_id: job.case_id }));
          }
        }
      },
      resultStore: reportStore
    });
  }
  return createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url || '/', 'http://localhost');
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    const customerApiPath = url.pathname.startsWith('/service/') || url.pathname === '/reports/entity-search.pdf' || /^\/forms\/[a-z0-9-]+\/submissions$/.test(url.pathname);
    const transactionId = customerApiPath ? randomUUID() : '';
    if (transactionId) res.setHeader('x-ai7-transaction-id', transactionId);

    try {
      if (customerApiPath && !(await gateCustomerApi(req, res, url, store, usageStore, formsQueue, formSubmissionStore, caseStore, transactionId))) return;
      if (req.ai7CapacityLane) {
        const queuedAt = Date.now();
        const cancelled = new AbortController();
        const onClose = () => cancelled.abort();
        res.once('close', onClose);
        let release;
        try {
          release = await requestCapacity.acquire(req.ai7CapacityLane, { signal: cancelled.signal });
        } catch (error) {
          res.off('close', onClose);
          if (error instanceof CapacityError) {
            if (req.ai7PreparedForm?.claim) await formSubmissionStore.abandon(req.ai7PreparedForm.claim);
            console.warn('api_capacity_rejected', JSON.stringify({ transaction_id: transactionId,
              lane: req.ai7CapacityLane, reason: error.reason,
              waiting_ms: Date.now() - queuedAt, capacity: requestCapacity.snapshot?.() || null }));
            if (res.destroyed && req.ai7Usage) {
              await usageStore.complete(req.ai7Usage.workspaceId, req.ai7Usage.logKey, 499, 'request_cancelled');
              return;
            }
            if (!res.destroyed) return json(res, 503, {
              status: 'Error', reasonCode: 'CAPACITY_BUSY',
              error: 'Request capacity is temporarily full. Retry with the same input.'
            }, { 'retry-after': '5' });
          }
          throw error;
        }
        res.off('close', onClose);
        res.setHeader('x-ai7-queue-wait-ms', String(Date.now() - queuedAt));
        req.ai7CapacityRelease = release;
      }
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('ok\n');
      }
      if (req.method === 'GET' && url.pathname === '/service/health') {
        const client = req.ai7Client || await store.getClientForKey?.(bearerToken(req));
        if (!client && !(await store.isClientKey(bearerToken(req)))) return json(res, 401, { status: 'Error', error: 'An active API key is required.' });
        const health = client ? await customerServiceHealth(store, usageStore, client.id) : await serviceHealth(store);
        return json(res, 200, { ...health, request_capacity: {
          scope: 'current_replica', ...requestCapacity.snapshot?.()
        } });
      }
      if (req.method === 'POST' && url.pathname === '/service/keys/self/rotate') {
        const client = req.ai7Client || await store.getClientForKey(bearerToken(req));
        if (!client?.key_id) return json(res, 401, { status: 'Error', error: 'An active managed API key is required.' });
        const rotated = await store.rotateClient(client.key_id, client.id);
        return rotated ? json(res, 200, { key: rotated.client, api_key: rotated.apiKey, notice: 'The previous key is invalid. Copy this replacement now.' })
          : json(res, 409, { status: 'Error', error: 'The key could not be rotated.' });
      }
      if (req.method === 'POST' && url.pathname === '/reports/entity-search.pdf') return await createEntitySearchReport(req, res, store, reportStore);
      if (req.method === 'POST' && url.pathname === '/service/adverse_media')
        return await createAdverseMediaScreening(req, res, store, fetchImpl, deepResearchQueue, reportStore, jsonStore);
      if (req.method === 'POST' && url.pathname === '/service/merchant_screening') return await createMerchantScreening(req, res, store, merchantScreener, reportStore);
      if (url.pathname === '/service/dubai_ejari_verification' || url.pathname.startsWith('/service/dubai_ejari_verification/'))
        return await handleEjari(req, res, url, store, ejariStore, usageStore);
      if (url.pathname === '/service/bank_statement_analysis' || url.pathname.startsWith('/service/bank_statement_analysis/')) return await handleBsa(req, res, url, store);
      if (await handleDocumentOcr(req, res, url, documentOcrStore, usageStore, store)) return;
      const formSubmissionMatch = /^\/forms\/([a-z0-9-]+)\/submissions$/.exec(url.pathname);
      if (req.method === 'POST' && formSubmissionMatch) return await submitForm(req, res, formSubmissionMatch[1], store, formsQueue, formSubmissionStore, transactionId);
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
      if (url.pathname.startsWith('/portal/api/')) return handlePortalApi(req, res, url, store, portalLoginThrottle, resetThrottle,
        mailer, otpStore, usageStore, caseStore, reportStore, documentOcrStore, ejariStore);
      if (url.pathname.startsWith('/admin/api/')) return handleAdminApi(req, res, url, store, loginThrottle, resetThrottle,
        mailer, otpStore, usageStore, documentOcrStore);
      if (url.pathname === '/admin/bsa-synthetic-combined.pdf') {
        return json(res, 404, { status: 'Error', error: 'Page was not found.' });
      }
      if (url.pathname === '/admin' || url.pathname === '/admin/') return serveStatic(res, join(root, 'admin-site'), '/');
      if (url.pathname.startsWith('/admin/')) return serveStatic(res, join(root, 'admin-site'), url.pathname.replace(/^\/admin/, '') || '/');
      if (url.pathname === '/catalog.json') {
        const { account, session } = await currentPortalSession(req, store);
        const usage = session ? await usageStore.account(account.client_id, Boolean((await store.getCustomer?.(account.client_id))?.usagePolicyVersion)) : null;
        const integrations = (await store.listIntegrations({ publicOnly: true })).filter((item) => item.enabled !== false
          && (!usage || usage.allowed_modules.includes('*') || usage.allowed_modules.includes(item.id)));
        return json(res, 200, { integrations }, { 'cache-control': 'no-store' });
      }
      if (url.pathname === '/forms.json') {
        const integrations = await store.listIntegrations({ publicOnly: true });
        const availableIntegrations = new Set(integrations.filter((item) => item.enabled !== false).map((item) => item.id));
        const { account, session } = await currentPortalSession(req, store);
        const usage = session ? await usageStore.account(account.client_id, Boolean((await store.getCustomer?.(account.client_id))?.usagePolicyVersion)) : null;
        const allowed = usage?.allowed_modules || [];
        const forms = (await store.listForms()).filter((form) => form.enabled
          && form.services.every((service) => availableIntegrations.has(service.service_id))
          && (!session || ['forms', ...form.services.map((item) => item.service_id)].every((id) => allowed.includes('*') || allowed.includes(id))))
          .map((form) => publicFormDefinition(form, integrations));
        return json(res, 200, { forms }, { 'cache-control': 'public, max-age=60' });
      }
      if (url.pathname === '/openapi.json') {
        const spec = readFileSync(join(root, 'api', 'openapi.json'));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': spec.length, 'cache-control': 'public, max-age=300' });
        return res.end(spec);
      }
      if (url.pathname === '/document-extraction/openapi.json') {
        const spec = readFileSync(join(root, 'api', 'document-ocr-openapi.json'));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': spec.length, 'cache-control': 'public, max-age=300' });
        return res.end(spec);
      }
      if (url.pathname === '/bank-statement-analysis/openapi.json' && bsaEnabled()) {
        const spec = readFileSync(join(root, 'bank-statement-analysis', 'openapi.local.json'));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': spec.length, 'cache-control': 'no-store' });
        return res.end(spec);
      }
      if (url.pathname === '/ejari-verification/openapi.json') {
        const spec = readFileSync(join(root, 'api', 'ejari-openapi.json'));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': spec.length, 'cache-control': 'public, max-age=300' });
        return res.end(spec);
      }

      const integration = await store.getIntegration(url.pathname, req.method || 'GET');
      if (integration) return await proxyIntegration(req, res, url, integration, store, fetchImpl, reportStore);
      if (url.pathname.startsWith('/service/')) return json(res, 404, { status: 'Error', error: 'Service was not found.' });

      const directory = apiHosts.has(host) || url.pathname.startsWith('/docs') ? join(root, 'api-site') : join(root, 'site');
      if (directory.endsWith('api-site') && (url.pathname === '/login' || url.pathname === '/login/')) return serveStatic(res, directory, '/login.html');
      if (directory.endsWith('api-site') && wantsHtml(req) && protectedPortalPath(url.pathname)) {
        const { account, session } = await currentPortalSession(req, store);
        if (!session) return portalLoginRedirect(res, url.pathname, url.search);
        const page = portalPagePath(url.pathname);
        const pageModule = { '/': 'uae-trade-licence', '/iban': 'iban-verification', '/entity-search': 'entity-search', '/adverse-media': 'adverse-media', '/merchant-screening': 'merchant-screening', '/bank-statement-analysis': 'bank-statement-analysis', '/ejari-verification': 'ejari-verification', '/forms': 'forms' }[page]
          || (/^\/forms\/[a-z0-9-]+$/.test(page) ? 'forms' : '')
          || (/^\/document-extraction\/[a-z0-9-]+$/.test(page) ? page.split('/').at(-1) : '');
        if (pageModule) {
          const usage = await usageStore.account(account.client_id, Boolean((await store.getCustomer?.(account.client_id))?.usagePolicyVersion));
          if (!usage.allowed_modules.includes('*') && !usage.allowed_modules.includes(pageModule)) {
            res.writeHead(302, { location: '/account', 'cache-control': 'no-store' });
            return res.end();
          }
        }
      }
      if ((!bsaEnabled() && (url.pathname === '/bank-statement-analysis' || url.pathname === '/bank-statement-analysis/'))
        || /^\/bsa-demo\.(?:html|css|js)$/.test(url.pathname)
        || url.pathname === '/bsa-synthetic-combined.pdf') {
        return json(res, 404, { status: 'Error', error: 'Page was not found.' });
      }
      if (!bsaEnabled() && url.pathname === '/bank-statement-analysis/openapi.json') {
        return json(res, 404, { status: 'Error', error: 'Page was not found.' });
      }
      if (directory.endsWith('api-site') && (url.pathname === '/iban' || url.pathname === '/iban/')) return serveStatic(res, directory, '/iban.html');
      if (directory.endsWith('api-site') && (url.pathname === '/account' || url.pathname === '/account/')) return serveStatic(res, directory, '/account.html');
      if (directory.endsWith('api-site') && (url.pathname === '/cases' || url.pathname === '/cases/')) {
        if (process.env.CASE_MANAGER_ENABLED !== 'true') return json(res, 404, { status: 'Error', error: 'Page was not found.' });
        return serveStatic(res, directory, '/cases.html');
      }
      if (directory.endsWith('api-site') && (url.pathname === '/entity-search' || url.pathname === '/entity-search/')) return serveStatic(res, directory, '/entity-search.html');
      if (directory.endsWith('api-site') && (url.pathname === '/adverse-media' || url.pathname === '/adverse-media/')) return serveStatic(res, directory, '/adverse-media.html');
      if (directory.endsWith('api-site') && (url.pathname === '/merchant-screening' || url.pathname === '/merchant-screening/')) return serveStatic(res, directory, '/merchant-screening.html');
      if (directory.endsWith('api-site') && (url.pathname === '/bank-statement-analysis' || url.pathname === '/bank-statement-analysis/')) return serveStatic(res, directory, '/bank-statement-analysis.html');
      if (directory.endsWith('api-site') && (url.pathname === '/ejari-verification' || url.pathname === '/ejari-verification/')) return serveStatic(res, directory, '/ejari-verification.html');
      if (directory.endsWith('api-site') && (url.pathname === '/forms' || url.pathname === '/forms/' || /^\/forms\/[a-z0-9-]+\/?$/.test(url.pathname))) return serveStatic(res, directory, '/forms.html');
      if (directory.endsWith('api-site') && /^\/document-extraction\/[a-z0-9-]+\/?$/.test(url.pathname)) {
        const id = portalPagePath(url.pathname).split('/').at(-1);
        if (![...DOCUMENT_OCR_BY_PATH.values()].some((item) => item.id === id)) return json(res, 404, { status: 'Error', error: 'Page was not found.' });
        return serveStatic(res, directory, '/document-extraction.html');
      }
      return serveStatic(res, directory, url.pathname.replace(/^\/docs/, '') || '/');
    } catch (error) {
      if (res.headersSent) return;
      return json(res, error.message === 'usage_meter_unavailable' ? 503 : 500, { status: 'Error', error: 'The service is temporarily unavailable. Please try again shortly.' });
    } finally {
      req.ai7CapacityRelease?.();
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  createAppServer().listen(port, process.env.BIND_HOST || '0.0.0.0', () => console.log(`AI7 UAE service listening on port ${port}`));
}
