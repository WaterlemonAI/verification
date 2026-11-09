import { randomUUID } from 'node:crypto';
import { scanDocumentBytes } from '../document-ocr-malware.mjs';
import { canTransition, validateFloConfig, validateLinkInput } from './contract.mjs';
import { sha256 } from './crypto.mjs';
import { latestTemplate, listTemplates, resolveTemplate, validFlowId } from './registry.mjs';
import { clearFloSessionCookie, cookieValue, floSessionCookie, hashSecret, newSecret, sameHash } from './session.mjs';
import { callbackEvent, callbackSigningSecret } from './callback.mjs';
import { diagnosticCaseAllowed } from './diagnostic.mjs';
import { buyerCase, customerCase, supplierCase } from './projections.mjs';

function reply(res, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length,
    'cache-control': 'no-store', ...headers });
  res.end(bytes);
}

async function body(req, limit = 1024 * 1024) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('json_required');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('request_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('invalid_json'); }
}

const validUuid = (value) => /^[0-9a-f-]{36}$/i.test(value || '');
function allowedHost(host, expected) { return host === expected || (process.env.NODE_ENV === 'test' && host === 'localhost'); }
function csrf(req, host) { return String(req.headers.origin || '') === `https://${host}`; }

async function saveEvidence(item, input, { floStore, template, scan, diagnosticLabel = null }) {
  if (item.status !== 'in_progress') throw new Error('application_not_editable');
  if (['queued', 'running', 'complete'].includes(item.diagnostic?.state)) throw new Error('diagnostic_locked');
  if (!template.allowedDocumentTypes.includes(input.type)) throw new Error('invalid_document_type');
  const bytes = Buffer.from(String(input.content_base64 || ''), 'base64');
  if (!bytes.length || bytes.length > 6 * 1024 * 1024 || bytes.toString('base64') !== input.content_base64)
    throw new Error('invalid_document_bytes');
  const pdf = bytes.subarray(0, 5).toString() === '%PDF-';
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!((pdf && input.mime_type === 'application/pdf') || (png && input.mime_type === 'image/png')
    || (jpg && input.mime_type === 'image/jpeg'))) throw new Error('invalid_document_mime');
  if (item.documents.reduce((n, doc) => n + doc.size, 0) + bytes.length > 50 * 1024 * 1024)
    throw new Error('case_size_limit');
  await scan(bytes, { host: process.env.FLO_CLAMD_HOST || process.env.DOCUMENT_OCR_CLAMD_HOST });
  const documentId = randomUUID();
  await floStore.putEvidence(item.workspace_id, item.application_id, documentId, bytes);
  const document = { document_id: documentId, type: input.type, mime_type: input.mime_type,
    size: bytes.length, sha256: sha256(bytes), scan_result: 'passed',
    uploaded_at: new Date().toISOString(), extraction_state: 'not_run',
    ...(diagnosticLabel ? { diagnostic_label: diagnosticLabel } : {}) };
  await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
    if (current.status !== 'in_progress') throw new Error('application_not_editable');
    if (['queued', 'running', 'complete'].includes(current.diagnostic?.state)) throw new Error('diagnostic_locked');
    if (current.flow_id === 'supplier-onboarding-v1' && current.checks.length) {
      current.check_history ||= [];
      current.check_history.push({ at: new Date().toISOString(), checks: current.checks,
        reason: 'supplier_document_changed' });
      current.checks = []; current.subjects = [];
    }
    current.documents.push(document); current.preview_ready_at = null; current.preview_issues = [];
    return current;
  });
  return document;
}

export async function handleFloRequest(req, res, url, { host, floStore, platformStore,
  getAdmin, getPortal, customerKey, hasEntitlement, charge, sendLink, sendConfirmation,
  enqueue, enqueueCallback, scan = scanDocumentBytes }) {
  const path = url.pathname;
  const supplierHost = process.env.FLO_HOST || 'flo.ai7uae.com';
  const apiHost = process.env.FLO_API_HOST || 'api.ai7uae.com';
  const portalHost = process.env.FLO_PORTAL_HOST || 'app.kycprobe.com';
  const floPath = path.startsWith('/flo/api/') || path.startsWith('/f/') || (path === '/flo' && host === supplierHost) || path.startsWith('/flows/')
    || path === '/admin/api/flows' || path.startsWith('/admin/api/flows/')
    || /^\/admin\/api\/customers\/[^/]+\/flo(?:\/[^/]+)?$/.test(path)
    || path.startsWith('/portal/api/flo/');
  if (!floPath) return false;
  if (!floStore) { reply(res, 404, { error: 'Flo is unavailable.' }); return true; }
  async function issueLink(workspaceId, flowId, actor, channel) {
    if (!validFlowId(flowId)) return { status: 404, body: { error: 'Unknown flow.' } };
    const published = await floStore.getTemplate(flowId);
    const template = published && resolveTemplate(flowId, published.version);
    const config = await floStore.getConfig(workspaceId, flowId);
    if (!template) return { status: 404, body: { error: 'Unknown or unsupported flow version.' } };
    if (!published.enabled || !config?.enabled)
      return { status: 403, body: { error: 'Flow is not enabled for this workspace.' } };
    const idem = String(req.headers['idempotency-key'] || '');
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idem))
      return { status: 400, body: { error: 'Valid Idempotency-Key required.' } };
    const input = validateLinkInput(await body(req));
    const billing = charge ? await charge(req, workspaceId, flowId, channel)
      : { allowed: true, settle: async () => {} };
    if (!billing.allowed) return { status: billing.statusCode || 403,
      body: { error: billing.reason || 'Flo is not assigned.' } };
    const secret = newSecret();
    let result;
    try { result = await floStore.createCase(workspaceId, input, idem, hashSecret(secret), config, template, actor); }
    catch (error) { await billing.settle(503); throw error; }
    await billing.settle(result.reused ? 409 : 201);
    const item = result.case;
    if (!result.reused && sendLink) {
      try { await sendLink({ to: input.supplier_email,
        url: `https://${supplierHost}/f/${secret}`, brandName: config.brand_name }); }
      catch { /* Case remains available through the returned URL. */ }
    }
    return { status: result.reused ? 200 : 201, body: {
      application_id: item.application_id, flow_id: item.flow_id, template_version: item.template_version,
      status: item.status, supplier_url: result.reused ? null : `https://${supplierHost}/f/${secret}`,
      status_url: `/flows/applications/${item.application_id}`,
      expires_at: item.link_expires_at, reused: result.reused
    } };
  }
  try {
    if (path === '/admin/api/flows' && req.method === 'GET') {
      if (!allowedHost(host, portalHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      const access = await getAdmin(req, res, false);
      if (!access) return true;
      const templates = await Promise.all(listTemplates().map(async (entry) => ({ ...entry,
        published: await floStore.getTemplate(entry.flow_id) })));
      reply(res, 200, { templates }); return true;
    }
    const adminFlow = /^\/admin\/api\/flows\/([a-z][a-z0-9-]{2,63})$/.exec(path)?.[1];
    if (adminFlow) {
      if (!allowedHost(host, portalHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      const access = await getAdmin(req, res, req.method !== 'GET');
      if (!access) return true;
      const template = latestTemplate(adminFlow);
      if (!template) { reply(res, 404, { error: 'Unknown flow.' }); return true; }
      if (req.method === 'GET') reply(res, 200, { template: await floStore.getTemplate(adminFlow), definition: template.definition });
      else if (req.method === 'PUT') reply(res, 200, { template: await floStore.putTemplate({ enabled: (await body(req)).enabled === true }, adminFlow) });
      else reply(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    const configMatch = /^\/admin\/api\/customers\/([a-f0-9]{16})\/flo(?:\/([a-z][a-z0-9-]{2,63}))?$/.exec(path);
    if (configMatch) {
      if (!allowedHost(host, portalHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      const access = await getAdmin(req, res, req.method !== 'GET');
      if (!access) return true;
      const workspaceId = configMatch[1];
      const flowId = configMatch[2] || 'kys-v1';
      if (!latestTemplate(flowId)) { reply(res, 404, { error: 'Unknown flow.' }); return true; }
      if (!await platformStore.getCustomer(workspaceId)) { reply(res, 404, { error: 'Customer not found.' }); return true; }
      if (req.method === 'GET') reply(res, 200, { configuration: await floStore.getConfig(workspaceId, flowId) });
      else if (req.method === 'PUT') {
        const parsed = validateFloConfig(await body(req));
        const signingSecret = parsed.callback_url ? callbackSigningSecret(workspaceId) : null;
        const configuration = await floStore.putConfig(workspaceId, parsed, flowId);
        reply(res, 200, { configuration, callback_signing_secret: signingSecret });
      }
      else reply(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    if (path.startsWith('/flows/')) {
      if (!allowedHost(host, apiHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      const client = await customerKey(req);
      if (!client?.id) { reply(res, 401, { error: 'Active customer API key required.' }); return true; }
      const workspaceId = client.id;
      if (!(await hasEntitlement?.(workspaceId))) { reply(res, 403, { error: 'Flo is not assigned.' }); return true; }
      const linkFlow = /^\/flows\/([a-z][a-z0-9-]{2,63})\/links$/.exec(path)?.[1];
      if (linkFlow && req.method === 'POST') {
        const created = await issueLink(workspaceId, linkFlow, 'customer_api', 'api');
        reply(res, created.status, created.body);
        return true;
      }
      const match = /^\/flows\/applications\/([0-9a-f-]{36})(\/report)?$/.exec(path);
      if (match && req.method === 'GET') {
        const item = await floStore.getCase(workspaceId, match[1]);
        if (!item) reply(res, 404, { error: 'Application not found.' });
        else if (match[2]) {
          const report = item.reports.at(-1);
          if (!report) reply(res, 202, { status: item.status, reports: [] });
          else {
            const bytes = await floStore.getEvidence(workspaceId, item.application_id, report.report_id);
            if (!bytes) reply(res, 503, { error: 'Report unavailable.' });
            else { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.length,
              'content-disposition': `attachment; filename="flo-${item.application_id}.pdf"`, 'cache-control': 'no-store' }); res.end(bytes); }
          }
        }
        else reply(res, ['submitted', 'processing'].includes(item.status) ? 202 : 200, { application: customerCase(item) });
        return true;
      }
      reply(res, 404, { error: 'Route not found.' }); return true;
    }
    if (path.startsWith('/flo/api/') || path.startsWith('/f/') || path === '/flo') {
      if (!allowedHost(host, supplierHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      if (path === '/flo/api/session' && req.method === 'POST') {
        const input = await body(req);
        const token = String(input.token || '');
        if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) { reply(res, 400, { error: 'Invalid link.' }); return true; }
        const linkHash = hashSecret(token);
        const reference = await floStore.findLink(linkHash);
        if (!reference) { reply(res, 404, { error: 'Link not found.' }); return true; }
        const linkedCase = await floStore.getCase(reference.workspaceId, reference.applicationId);
        if (!linkedCase || !resolveTemplate(linkedCase.flow_id, linkedCase.template_version)) {
          reply(res, 409, { error: 'This flow version is unavailable.' }); return true;
        }
        const sessionToken = `${reference.workspaceId}.${reference.applicationId}.${newSecret()}`;
        const csrfToken = newSecret();
        let failure = '';
        const item = await floStore.updateCase(reference.workspaceId, reference.applicationId, (current) => {
          if (!sameHash(current.link_hash, linkHash) || current.link_redeemed_at) { failure = 'Link already used.'; return null; }
          if (Date.parse(current.link_expires_at) < Date.now()) { current.status = 'link_expired'; failure = 'Link expired.'; return current; }
          if (!canTransition(current.status, 'in_progress')) { failure = 'Application unavailable.'; return null; }
          current.status = 'in_progress'; current.link_redeemed_at = new Date().toISOString(); current.link_hash = null;
          current.session_hash = hashSecret(sessionToken); current.session_csrf_hash = hashSecret(csrfToken);
          current.session_expires_at = new Date(Date.now() + 3600_000).toISOString();
          if (current.reports.length) {
            current.check_history ||= [];
            current.check_history.push({ at: new Date().toISOString(), checks: current.checks });
            current.checks = []; current.facts = []; current.comparisons = []; current.gemini_review = null;
            current.preview_ready_at = null;
          }
          return current;
        });
        if (failure || !item) reply(res, 410, { error: failure || 'Link unavailable.',
          failure_url: failure === 'Link expired.' ? item?.configuration?.failure_url || null : null });
        else reply(res, 200, { ...supplierCase(item), csrf_token: csrfToken },
        { 'set-cookie': floSessionCookie(sessionToken) });
        return true;
      }
      if (path === '/flo/api/logout' && req.method === 'POST') {
        reply(res, 200, { signed_out: true }, { 'set-cookie': clearFloSessionCookie() }); return true;
      }
      if (!path.startsWith('/flo/api/')) return false;
      const session = cookieValue(req);
      let item = null;
      const [workspaceId, applicationId] = session.split('.');
      if (validUuid(applicationId) && /^[a-f0-9]{16}$/.test(workspaceId || '')
        && String(req.headers['x-flo-application-id'] || '') === applicationId)
        item = await floStore.getCase(workspaceId, applicationId);
      if (!item || !sameHash(item.session_hash, hashSecret(session)) || Date.parse(item.session_expires_at) < Date.now()) {
        reply(res, 401, { error: 'Session expired.' }); return true;
      }
      const template = resolveTemplate(item.flow_id, item.template_version);
      if (!template) { reply(res, 409, { error: 'This flow version is unavailable.' }); return true; }
      if (req.method === 'GET' && path === '/flo/api/application') {
        reply(res, 200, { application: supplierCase(item) }); return true;
      }
      if (req.method !== 'POST' || !csrf(req, host)
        || !sameHash(item.session_csrf_hash, hashSecret(req.headers['x-flo-csrf']))) {
        reply(res, 403, { error: 'Security token invalid.' }); return true;
      }
      if (path === '/flo/api/draft') {
        if (item.diagnostic && ['queued', 'running', 'complete'].includes(item.diagnostic.state)) throw new Error('diagnostic_locked');
        const draft = template.validateDraft(await body(req));
        const updated = await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
          if (current.status !== 'in_progress') throw new Error('application_not_editable');
          if (current.diagnostic && ['queued', 'running', 'complete'].includes(current.diagnostic.state)) throw new Error('diagnostic_locked');
          const merged = { ...current.draft, ...draft };
          if (JSON.stringify(merged) === JSON.stringify(current.draft)) return null;
          if (current.flow_id === 'supplier-onboarding-v1' && current.checks.length) {
            current.check_history ||= [];
            current.check_history.push({ at: new Date().toISOString(), checks: current.checks, reason: 'supplier_draft_changed' });
            current.checks = []; current.subjects = [];
          }
          current.draft = merged; current.preview_ready_at = null;
          current.preview_issues = []; return current;
        });
        reply(res, 200, { draft: updated.draft }); return true;
      }
      if (path === '/flo/api/review') {
        if (item.diagnostic && ['queued', 'running', 'complete'].includes(item.diagnostic.state)) throw new Error('diagnostic_locked');
        const gaps = template.submissionGaps(item);
        if (gaps.length) { reply(res, 400, { error: 'Required information missing.', gaps }); return true; }
        if (!enqueue) { reply(res, 503, { error: 'Review is unavailable.' }); return true; }
        await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
          current.preview_ready_at = null; return current;
        });
        await enqueue({ workspace_id: item.workspace_id, application_id: item.application_id,
          job_type: 'preview', attempt: 0 });
        reply(res, 202, { status: 'review_processing' }); return true;
      }
      if (path === '/flo/api/documents') {
        const input = await body(req, 9 * 1024 * 1024);
        const document = await saveEvidence(item, input, { floStore, template, scan });
        reply(res, 201, { document }); return true;
      }
      if (path === '/flo/api/submit') {
        if (item.diagnostic && ['queued', 'running', 'complete'].includes(item.diagnostic.state)) throw new Error('diagnostic_locked');
        const gaps = template.submissionGaps(item);
        if (gaps.length) { reply(res, 400, { error: 'Required information missing.', gaps }); return true; }
        if (!item.preview_ready_at || item.documents.some((document) => document.extraction_state === 'queued')) {
          reply(res, 409, { error: 'Review extracted values before submitting.' }); return true;
        }
        await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
          if (!canTransition(current.status, 'submitted')) throw new Error('application_not_editable');
          current.status = 'submitted'; current.submitted_at = new Date().toISOString();
          current.events.push(callbackEvent(current, 'submitted', 'supplier'));
          return current;
        });
        if (enqueue) await enqueue({ workspace_id: item.workspace_id, application_id: item.application_id, job_type: 'process', attempt: 0 });
        if (enqueueCallback && item.configuration?.callback_url) {
          const latest = await floStore.getCase(item.workspace_id, item.application_id);
          await enqueueCallback({ workspace_id: item.workspace_id, application_id: item.application_id,
            job_type: 'callback', attempt: 0, event_id: latest.events.at(-1).event_id });
        }
        if (sendConfirmation) {
          try { await sendConfirmation({ to: item.supplier_email, brandName: item.configuration?.brand_name,
            reference: item.customer_reference }); } catch { /* Submission is already durable. */ }
        }
        reply(res, 202, { application_id: item.application_id, status: 'submitted', success_url: item.configuration?.success_url }); return true;
      }
      reply(res, 404, { error: 'Route not found.' }); return true;
    }
    if (path.startsWith('/portal/api/flo/')) {
      if (!allowedHost(host, portalHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      const access = await getPortal(req, res, req.method !== 'GET');
      if (!access) return true;
      if (path === '/portal/api/flo/status' && req.method === 'GET') {
        const enabled = (await hasEntitlement?.(access.account.client_id)) === true
          && (await Promise.all(listTemplates().map(async (entry) =>
            (await floStore.getConfig(access.account.client_id, entry.flow_id))?.enabled === true))).some(Boolean);
        reply(res, 200, { enabled }); return true;
      }
      if ((access.account.role || 'org_admin') !== 'org_admin') { reply(res, 403, { error: 'Organization administrator required.' }); return true; }
      const workspaceId = access.account.client_id;
      if (!(await hasEntitlement?.(workspaceId))) {
        reply(res, 404, { error: 'Flo is not enabled.' }); return true;
      }
      if (path === '/portal/api/flo/flows' && req.method === 'GET') {
        const flows = (await Promise.all(listTemplates().map(async (entry) => {
          const published = await floStore.getTemplate(entry.flow_id);
          const config = await floStore.getConfig(workspaceId, entry.flow_id);
          return published?.enabled && config?.enabled
            && resolveTemplate(entry.flow_id, published.version)
            ? { flow_id: entry.flow_id, version: published.version, brand_name: config.brand_name } : null;
        }))).filter(Boolean);
        reply(res, 200, { flows }); return true;
      }
      const portalLinkFlow = /^\/portal\/api\/flo\/flows\/([a-z][a-z0-9-]{2,63})\/links$/.exec(path)?.[1];
      if (portalLinkFlow && req.method === 'POST') {
        const created = await issueLink(workspaceId, portalLinkFlow, access.account.email, 'portal');
        reply(res, created.status, created.body); return true;
      }
      if (path === '/portal/api/flo/cases' && req.method === 'GET') {
        const requestedFlow = url.searchParams.get('flow_id');
        if (requestedFlow && !validFlowId(requestedFlow)) { reply(res, 400, { error: 'Invalid flow ID.' }); return true; }
        const cases = await floStore.listCases(workspaceId);
        reply(res, 200, { cases: requestedFlow ? cases.filter((item) => item.flow_id === requestedFlow) : cases }); return true;
      }
      const match = /^\/portal\/api\/flo\/cases\/([0-9a-f-]{36})(?:\/(decision|report|report\.html|report\.json|reports\/[1-9][0-9]*(?:\.html|\.json)?|documents\/([0-9a-f-]{36})|diagnostic\/(documents|run|decision)))?$/.exec(path);
      if (!match) { reply(res, 404, { error: 'Route not found.' }); return true; }
      const item = await floStore.getCase(workspaceId, match[1]);
      if (!item) { reply(res, 404, { error: 'Case not found.' }); return true; }
      if (!match[2] && req.method === 'GET') { reply(res, 200, { application: buyerCase(item), diagnostic_enabled: diagnosticCaseAllowed(item) }); return true; }
      if (match[2]?.startsWith('diagnostic/')) {
        if (!diagnosticCaseAllowed(item)) { reply(res, 404, { error: 'Route not found.' }); return true; }
        if (req.method !== 'POST') { reply(res, 405, { error: 'Method not allowed.' }); return true; }
        if (match[4] === 'documents') {
          if (item.diagnostic?.state === 'running' || item.diagnostic?.state === 'queued') throw new Error('diagnostic_in_progress');
          const input = await body(req, 9 * 1024 * 1024);
          const labels = { tradeLicenceFile: ['substitute'], moaFile: ['unexecuted_draft'],
            aoaFile: ['unexecuted_draft'], identityFile: ['unverified'], bankConfirmationFile: ['test_sample'],
            vatFile: ['unverified'], incorporationFile: ['unverified'] };
          if (!labels[input.type]?.includes(input.diagnostic_label)) throw new Error('invalid_diagnostic_label');
          const template = resolveTemplate(item.flow_id, item.template_version);
          const document = await saveEvidence(item, input, { floStore, template, scan, diagnosticLabel: input.diagnostic_label });
          reply(res, 201, { document }); return true;
        }
        if (match[4] === 'run') {
          if (!enqueue) { reply(res, 503, { error: 'Diagnostic is unavailable.' }); return true; }
          const input = await body(req);
          const inferred = input.inferred_draft || {};
          if (!inferred || typeof inferred !== 'object' || Array.isArray(inferred)
            || Object.keys(inferred).some((key) => !['supplierType', 'tradingName', 'identityType'].includes(key)))
            throw new Error('invalid_diagnostic_draft');
          const parsed = resolveTemplate(item.flow_id, item.template_version).validateDraft(inferred);
          if (parsed.supplierType !== 'legal_entity' || parsed.identityType !== 'passport'
            || !parsed.tradingName) throw new Error('invalid_diagnostic_draft');
          const updated = await floStore.updateCase(workspaceId, item.application_id, (current) => {
            if (current.status !== 'in_progress' || ['queued', 'running', 'complete'].includes(current.diagnostic?.state))
              throw new Error('diagnostic_in_progress');
            current.diagnostic = { state: 'queued', type: 'controlled_pilot',
              limitations: ['certificate_of_formation_substituted_for_trade_licence', 'premises_evidence_missing',
                'bank_confirmation_is_test_sample', 'memorandum_and_articles_are_unexecuted_drafts',
                'buyer_inferred_entity_name_and_passport_type_without_supplier_attestation'],
              requested_at: new Date().toISOString(), requested_by: access.account.email };
            current.draft = { ...current.draft, ...parsed };
            const certificate = current.documents.findLast((doc) => doc.type === 'tradeLicenceFile');
            if (certificate) certificate.diagnostic_label = 'substitute';
            current.checks = []; current.subjects = []; current.facts = []; current.comparisons = [];
            current.preview_issues = []; current.gemini_review = null;
            return current;
          });
          try { await enqueue({ workspace_id: workspaceId, application_id: item.application_id, job_type: 'diagnostic', attempt: 0 }); }
          catch (error) { await floStore.updateCase(workspaceId, item.application_id, (current) => {
            if (current.diagnostic?.state === 'queued') current.diagnostic.state = 'enqueue_failed'; return current;
          }); throw error; }
          reply(res, 202, { application_id: updated.application_id, diagnostic: updated.diagnostic }); return true;
        }
        if (match[4] === 'decision') {
          const input = await body(req);
          if (!['needs_more_evidence', 'checks_failed', 'inconclusive'].includes(input.outcome)) throw new Error('invalid_diagnostic_outcome');
          const rationale = String(input.rationale || '').trim();
          if (!rationale || rationale.length > 2000) throw new Error('invalid_rationale');
          const updated = await floStore.updateCase(workspaceId, item.application_id, (current) => {
            if (current.diagnostic?.state !== 'complete' || current.diagnostic.outcome) throw new Error('invalid_transition');
            current.diagnostic.outcome = input.outcome; current.diagnostic.rationale = rationale;
            current.diagnostic.decided_at = new Date().toISOString(); current.diagnostic.decided_by = access.account.email;
            current.events.push(callbackEvent(current, 'diagnostic_decision', access.account.email)); return current;
          });
          if (enqueueCallback && updated.configuration?.callback_url)
            await enqueueCallback({ workspace_id: workspaceId, application_id: item.application_id,
              job_type: 'callback', attempt: 0, event_id: updated.events.at(-1).event_id });
          reply(res, 200, { application_id: item.application_id, diagnostic: updated.diagnostic }); return true;
        }
      }
      if (['report', 'report.html', 'report.json'].includes(match[2]) || match[2]?.startsWith('reports/')) {
        if (req.method !== 'GET') { reply(res, 405, { error: 'Method not allowed.' }); return true; }
        const version = match[2].startsWith('reports/') ? Number(/^reports\/([1-9][0-9]*)/.exec(match[2])?.[1]) : null;
        const format = match[2].endsWith('.html') ? 'html' : match[2].endsWith('.json') ? 'json' : 'pdf';
        const report = version ? item.reports.find((candidate) => candidate.version === version) : item.reports.at(-1);
        if (!report) { reply(res, version ? 404 : 202, { status: version ? 'not_found' : 'processing' }); return true; }
        const reference = format === 'pdf' ? report.report_id : format === 'html' ? report.html_id : report.model_id;
        const bytes = await floStore.getEvidence(workspaceId, item.application_id, reference);
        if (!bytes) { reply(res, 503, { error: 'Report unavailable.' }); return true; }
        res.writeHead(200, { 'content-type': format === 'pdf' ? 'application/pdf' : format === 'html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
          'content-length': bytes.length,
          'content-disposition': `${format === 'html' ? 'inline' : 'attachment'}; filename="flo-${item.application_id}-v${report.version}.${format}"`,
          'x-content-type-options': 'nosniff',
          ...(format === 'html' ? { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" } : {}),
          'cache-control': 'no-store' });
        res.end(bytes); return true;
      }
      if (match[2]?.startsWith('documents/') && req.method === 'GET') {
        const document = item.documents.find((candidate) => candidate.document_id === match[3]);
        if (!document) { reply(res, 404, { error: 'Document not found.' }); return true; }
        const bytes = await floStore.getEvidence(workspaceId, item.application_id, document.document_id);
        if (!bytes) { reply(res, 404, { error: 'Document not found.' }); return true; }
        res.writeHead(200, { 'content-type': document.mime_type, 'content-length': bytes.length,
          'x-content-type-options': 'nosniff',
          'content-disposition': `attachment; filename="${document.document_id}"`, 'cache-control': 'no-store' });
        res.end(bytes); return true;
      }
      if (match[2] === 'decision' && req.method === 'POST') {
        const input = await body(req);
        if (!['accepted', 'rejected', 'needs_correction'].includes(input.decision)) throw new Error('invalid_decision');
        const rationale = String(input.rationale || '').trim();
        if (rationale.length > 2000) throw new Error('invalid_rationale');
        const correctionSecret = input.decision === 'needs_correction' ? newSecret() : null;
        const updated = await floStore.updateCase(workspaceId, item.application_id, (current) => {
          if (!canTransition(current.status, input.decision)
            && !(current.status === 'needs_correction' && input.decision === 'needs_correction' && !current.link_hash))
            throw new Error('invalid_transition');
          const previous_status = current.status;
          current.status = input.decision;
          if (correctionSecret) {
            current.link_hash = hashSecret(correctionSecret);
            current.link_redeemed_at = null;
            current.link_expires_at = new Date(Date.now() + 7 * 86400_000).toISOString();
            current.session_hash = null; current.session_csrf_hash = null; current.session_expires_at = null;
          }
          current.events.push({ ...callbackEvent(current, input.decision, access.account.email), previous_status,
            rationale, report_version: current.reports.at(-1)?.version || null });
          return current;
        });
        if (correctionSecret) {
          await floStore.putLink(workspaceId, item.application_id, hashSecret(correctionSecret));
          if (sendLink) {
            try { await sendLink({ to: item.supplier_email, url: `https://${supplierHost}/f/${correctionSecret}`,
              brandName: item.configuration?.brand_name }); } catch { /* Buyer can share the returned URL. */ }
          }
        }
        if (enqueueCallback && item.configuration?.callback_url)
          await enqueueCallback({ workspace_id: workspaceId, application_id: item.application_id,
            job_type: 'callback', attempt: 0, event_id: updated.events.at(-1).event_id });
        reply(res, 200, { application_id: updated.application_id, status: updated.status,
          supplier_url: correctionSecret ? `https://${supplierHost}/f/${correctionSecret}` : null }); return true;
      }
      reply(res, 405, { error: 'Method not allowed.' }); return true;
    }
  } catch (error) {
    const code = /conflict|transition|not_editable|diagnostic_in_progress|diagnostic_locked/.test(error.message) ? 409
      : /size_limit|request_too_large/.test(error.message) ? 413 : /MALWARE|unavailable|incomplete/.test(error.message) ? 503 : 400;
    reply(res, code, { error: code === 503 ? 'Flo is temporarily unavailable.' : error.message });
    return true;
  }
  return false;
}
