import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { scanDocumentBytes } from '../document-ocr-malware.mjs';
import { canTransition, caseBucket, validateFloConfig, validateLinkInput, validateRestart } from './contract.mjs';
import { sha256 } from './crypto.mjs';
import { latestTemplate, listTemplates, resolveTemplate, resolveCaseTemplate, validFlowId } from './registry.mjs';
import { WorkflowService } from './workflow-service.mjs';
import { schemaPresentation } from './template-schema.mjs';
import { defaultFloEmailTemplates, renderFloEmail, validateEmailTemplates } from './email-templates.mjs';
import { emailEvent, reconcileFloNotifications, sendFloTest, validateFloSmtp, verifyFloSenderDns } from './notifications.mjs';
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
  if (!['in_progress', 'restarted'].includes(item.status)) throw new Error('application_not_editable');
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
    if (!['in_progress', 'restarted'].includes(current.status)) throw new Error('application_not_editable');
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
  getAdmin, getPortal, customerKey, hasEntitlement, hasFloPrice, charge, sendLink, sendConfirmation,
  enqueue, enqueueCallback, enqueueEmail, mailer, createReport, scan = scanDocumentBytes,
  workflowPlatformEnabled = true }) {
  const path = url.pathname;
  const supplierHost = process.env.FLO_HOST || 'flo.ai7uae.com';
  const apiHost = process.env.FLO_API_HOST || 'api.ai7uae.com';
  const portalHost = process.env.FLO_PORTAL_HOST || 'app.kycprobe.com';
  const floPath = path.startsWith('/flo/api/') || path.startsWith('/flo/assets/') || path.startsWith('/f/') || (path === '/flo' && host === supplierHost) || path.startsWith('/flows/')
    || path === '/admin/api/flows' || path.startsWith('/admin/api/flows/')
    || /^\/admin\/api\/customers\/[^/]+\/flo(?:\/[^/]+)?$/.test(path)
    || path.startsWith('/portal/api/flo/');
  if (!floPath) return false;
  if (!floStore) { reply(res, 404, { error: 'Flo is unavailable.' }); return true; }
  if (!workflowPlatformEnabled && (path.startsWith('/portal/api/flo/workflows')
    || ['/admin/api/flows/validate', '/admin/api/flows/catalog'].includes(path)
    || path === '/admin/api/flows' && req.method === 'POST'
    || /^\/admin\/api\/flows\/[a-z][a-z0-9-]{2,63}\/(draft|preview|publish|lifecycle|assignments|copy)$/.test(path))) {
    reply(res, 404, { error: 'Workflow platform is unavailable.' }); return true;
  }
  const workflows = new WorkflowService(floStore, { hasEntitlement, hasFloPrice });
  async function selectableWorkflow(workspaceId, flowId) {
    const effective = await workflows.effective(flowId, workspaceId);
    if (!effective) return null;
    const config = await floStore.getConfig(workspaceId, flowId);
    return config?.enabled === false ? null : effective;
  }
  async function issueLink(workspaceId, flowId, actor, channel) {
    if (!validFlowId(flowId)) return { status: 404, body: { error: 'Unknown flow.' } };
    const published = await floStore.getTemplate(flowId);
    const effective = published || !workflowPlatformEnabled ? null : await workflows.effective(flowId, workspaceId);
    const template = published ? resolveTemplate(flowId, published.version) : effective?.template;
    const config = await floStore.getConfig(workspaceId, flowId)
      || (effective ? { enabled: true, brand_name: 'KYCProbe', callback_url: null } : null);
    if (!template) return { status: 404, body: { error: 'Unknown or unsupported flow version.' } };
    if (published && !published.enabled || !config?.enabled)
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
    if (!result.reused && effective) {
      const updated = await floStore.updateCase(workspaceId, item.application_id, (current) => {
        const event = emailEvent(current, 'link');
        current.notification_links ||= {};
        current.notification_links[event.event_id] = `https://${supplierHost}/f/${secret}`;
        current.events.push(event); return current;
      });
      try { if (!enqueueEmail) throw new Error('email_queue_unavailable');
        await enqueueEmail({ workspace_id: workspaceId, application_id: item.application_id,
        job_type: 'email', attempt: 0, event_id: updated.events.at(-1).event_id }); }
      catch { await floStore.updateCase(workspaceId, item.application_id, (current) => {
        current.link_delivery = 'failed'; return current;
      }); }
    } else if (!result.reused && sendLink) {
      try { await sendLink({ to: input.supplier_email,
        url: `https://${supplierHost}/f/${secret}`, brandName: config.brand_name });
        await floStore.updateCase(workspaceId, item.application_id, (current) => {
          current.link_delivery = 'sent'; return current;
        });
      } catch { await floStore.updateCase(workspaceId, item.application_id, (current) => {
        current.link_delivery = 'failed'; return current;
      }); }
    }
    return { status: result.reused ? 200 : 201, body: {
      application_id: item.application_id, flow_id: item.flow_id, template_version: item.template_version,
      status: item.status, supplier_url: result.reused ? null : `https://${supplierHost}/f/${secret}`,
      status_url: `/flows/applications/${item.application_id}`,
      expires_at: item.link_expires_at, reused: result.reused
    } };
  }
  try {
    if (path === '/admin/api/flows/catalog' && req.method === 'GET') {
      if (!allowedHost(host, portalHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      if (!await getAdmin(req, res, false)) return true;
      reply(res, 200, { checks: await workflows.catalog() }); return true;
    }
    if (path === '/admin/api/flows/validate' && req.method === 'POST') {
      if (!allowedHost(host, portalHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      if (!await getAdmin(req, res, true)) return true;
      reply(res, 200, await workflows.validateUnsaved((await body(req, 80 * 1024)).schema)); return true;
    }
    if (path === '/admin/api/flows' && req.method === 'POST') {
      if (!allowedHost(host, portalHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      if (!await getAdmin(req, res, true)) return true;
      const input = await body(req);
      const created = await workflows.create({ name: input.name, schema: input.schema });
      reply(res, 201, { workflow: created }); return true;
    }
    const adminWorkflow = /^\/admin\/api\/flows\/([a-z][a-z0-9-]{2,63})\/(draft|preview|publish|lifecycle|assignments|copy)$/.exec(path);
    if (adminWorkflow) {
      if (!allowedHost(host, portalHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      if (!await getAdmin(req, res, req.method !== 'GET')) return true;
      const [, flowId, action] = adminWorkflow;
      const record = await workflows.get(flowId);
      if (!record) { reply(res, 404, { error: 'Workflow not found.' }); return true; }
      if (action === 'draft' && req.method === 'GET') reply(res, 200, { workflow: record });
      else if (action === 'draft' && req.method === 'PATCH') {
        const input = await body(req);
        reply(res, 200, { workflow: await workflows.saveDraft(flowId, null, input.schema, input.expected_revision) });
      } else if (action === 'preview' && req.method === 'GET') reply(res, 200,
        { presentation: schemaPresentation(record.draft), draft_revision: record.draft_revision });
      else if (action === 'publish' && req.method === 'POST') {
        const input = await body(req);
        reply(res, 200, { workflow: await workflows.publish(flowId, null, input.expected_revision) });
      } else if (action === 'lifecycle' && req.method === 'POST') {
        const input = await body(req);
        reply(res, 200, { workflow: await workflows.lifecycle(flowId, null, input.state, input.expected_revision) });
      } else if (action === 'copy' && req.method === 'POST') {
        reply(res, 201, { workflow: await workflows.copy(flowId) });
      } else if (action === 'assignments' && req.method === 'GET') {
        reply(res, 200, { assignments: (await floStore.listAssignments()).filter((entry) => entry.flow_id === flowId) });
      } else if (action === 'assignments' && req.method === 'PUT') {
        const input = await body(req);
        if (!await platformStore.getCustomer(input.workspace_id)) throw new Error('workspace_not_found');
        reply(res, 200, { assignment: await workflows.assign(flowId, input.workspace_id, input.state) });
      } else reply(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    if (path === '/admin/api/flows' && req.method === 'GET') {
      if (!allowedHost(host, portalHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      const access = await getAdmin(req, res, false);
      if (!access) return true;
      const templates = await Promise.all(listTemplates().map(async (entry) => ({ ...entry,
        published: await floStore.getTemplate(entry.flow_id) })));
      const stored = workflowPlatformEnabled ? await workflows.list() : [];
      const assignments = workflowPlatformEnabled ? await floStore.listAssignments() : [];
      const withCount = await Promise.all(stored.map(async (entry) => {
        const workspaceIds = entry.owner_workspace_id ? [entry.owner_workspace_id]
          : assignments.filter((assignment) => assignment.flow_id === entry.flow_id
            && assignment.state === 'active').map((assignment) => assignment.workspace_id);
        const effective = await Promise.all(workspaceIds.map((id) => selectableWorkflow(id, entry.flow_id)));
        return { ...entry, active_organisation_count: effective.filter(Boolean).length };
      }));
      reply(res, 200, { templates, workflow_platform_enabled: workflowPlatformEnabled,
        workflows: withCount }); return true;
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
      if (!latestTemplate(flowId) && !await floStore.getWorkflow(flowId)) { reply(res, 404, { error: 'Unknown flow.' }); return true; }
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
    if (path.startsWith('/flo/api/') || path.startsWith('/flo/assets/') || path.startsWith('/f/') || path === '/flo') {
      if (!allowedHost(host, supplierHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      const logoPath = /^\/flo\/assets\/([a-z][a-z0-9-]{2,63})\/([0-9a-f-]{36})$/.exec(path);
      if (logoPath && req.method === 'GET') {
        const session = cookieValue(req); const [workspaceId, applicationId] = session.split('.');
        const item = validUuid(applicationId) ? await floStore.getCase(workspaceId, applicationId) : null;
        if (!item || !sameHash(item.session_hash, hashSecret(session)) || Date.parse(item.session_expires_at) < Date.now()
          || item.flow_id !== logoPath[1] || item.configuration?.logo_asset_id !== logoPath[2]) {
          reply(res, 404, { error: 'Asset not found.' }); return true;
        }
        const bytes = await floStore.getWorkflowAsset(workspaceId, item.flow_id, logoPath[2]);
        if (!bytes) { reply(res, 404, { error: 'Asset not found.' }); return true; }
        res.writeHead(200, { 'content-type': item.configuration.logo_mime_type,
          'content-length': bytes.length, 'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store' }); res.end(bytes); return true;
      }
      if (path === '/flo/api/session' && req.method === 'POST') {
        const input = await body(req);
        const token = String(input.token || '');
        if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) { reply(res, 400, { error: 'Invalid link.' }); return true; }
        const linkHash = hashSecret(token);
        const reference = await floStore.findLink(linkHash);
        if (!reference) { reply(res, 404, { error: 'Link not found.' }); return true; }
        const linkedCase = await floStore.getCase(reference.workspaceId, reference.applicationId);
        if (!linkedCase || !await resolveCaseTemplate(linkedCase, floStore)) {
          reply(res, 409, { error: 'This flow version is unavailable.' }); return true;
        }
        const sessionToken = `${reference.workspaceId}.${reference.applicationId}.${newSecret()}`;
        const csrfToken = newSecret();
        let failure = '';
        const item = await floStore.updateCase(reference.workspaceId, reference.applicationId, (current) => {
          if (!sameHash(current.link_hash, linkHash) || current.link_redeemed_at) { failure = 'Link already used.'; return null; }
          if (Date.parse(current.link_expires_at) < Date.now()) { current.status = 'link_expired'; failure = 'Link expired.'; return current; }
          if (current.status !== 'restarted' && !canTransition(current.status, 'in_progress')) { failure = 'Application unavailable.'; return null; }
          if (current.status !== 'restarted') current.status = 'in_progress';
          current.link_redeemed_at = new Date().toISOString(); current.link_hash = null;
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
      const template = await resolveCaseTemplate(item, floStore);
      if (!template) { reply(res, 409, { error: 'This flow version is unavailable.' }); return true; }
      if (req.method === 'GET' && path === '/flo/api/application') {
        reply(res, 200, { application: supplierCase(item) }); return true;
      }
      if (req.method !== 'POST' || !csrf(req, host)
        || !sameHash(item.session_csrf_hash, hashSecret(req.headers['x-flo-csrf']))) {
        reply(res, 403, { error: 'Security token invalid.' }); return true;
      }
      if (path === '/flo/api/declarations') {
        if (!item.workflow_schema || !['in_progress', 'restarted'].includes(item.status)) throw new Error('application_not_editable');
        const input = await body(req);
        const allowed = new Set(item.workflow_schema.stages.flatMap((stage) => stage.declarations.map((entry) => entry.id)));
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some((key) => !allowed.has(key) || input[key] !== true)) throw new Error('invalid_declarations');
        const updated = await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
          current.declarations = { ...current.declarations, ...input }; return current;
        });
        reply(res, 200, { declarations: updated.declarations }); return true;
      }
      if (path === '/flo/api/draft') {
        if (item.diagnostic && ['queued', 'running', 'complete'].includes(item.diagnostic.state)) throw new Error('diagnostic_locked');
        const draft = template.validateDraft(await body(req));
        const updated = await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
          if (!['in_progress', 'restarted'].includes(current.status)) throw new Error('application_not_editable');
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
        if (item.flow_id === 'supplier-onboarding-v1') {
          reply(res, 404, { error: 'Route not found.' }); return true;
        }
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
        if ((item.flow_id === 'supplier-onboarding-v1' || item.workflow_schema)
          && ['submitted', 'processing', 'pending_review'].includes(item.status)) {
          if (item.status === 'submitted' && item.process_enqueue_state === 'failed') {
            if (!enqueue) { reply(res, 503, { error: 'Submission is temporarily unavailable. Please try again.' }); return true; }
            try {
              await enqueue({ workspace_id: item.workspace_id, application_id: item.application_id, job_type: 'process', attempt: 0 });
              await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
                if (current.status === 'submitted') current.process_enqueue_state = 'queued';
                return current;
              });
            } catch {
              reply(res, 503, { error: 'Submission is temporarily unavailable. Please try again.' }); return true;
            }
            if (enqueueCallback && item.configuration?.callback_url) {
              const submitted = item.events.findLast((event) => event.type === 'submitted');
              if (submitted) {
                try {
                  await enqueueCallback({ workspace_id: item.workspace_id, application_id: item.application_id,
                    job_type: 'callback', attempt: 0, event_id: submitted.event_id });
                } catch { /* The submitted event remains available for buyer-side callback retry. */ }
              }
            }
          }
          reply(res, 202, { application_id: item.application_id, status: 'submitted' }); return true;
        }
        const gaps = template.submissionGaps(item);
        if (gaps.length) { reply(res, 400, { error: 'Required information missing.', gaps }); return true; }
        if (!enqueue) { reply(res, 503, { error: 'Submission is temporarily unavailable. Please try again.' }); return true; }
        if (item.flow_id !== 'supplier-onboarding-v1' && !item.workflow_schema
          && (!item.preview_ready_at || item.documents.some((document) => document.extraction_state === 'queued'))) {
          reply(res, 409, { error: 'Review extracted values before submitting.' }); return true;
        }
        await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
          if (!canTransition(current.status, 'submitted') && current.status !== 'restarted') throw new Error('application_not_editable');
          current.status = 'submitted'; current.submitted_at = new Date().toISOString();
          current.restart = null;
          current.events.push(callbackEvent(current, (current.application_revision || 1) > 1 ? 'resubmitted' : 'submitted', 'supplier'));
          return current;
        });
        try {
          await enqueue({ workspace_id: item.workspace_id, application_id: item.application_id, job_type: 'process', attempt: 0 });
        } catch {
          if (item.flow_id === 'supplier-onboarding-v1' || item.workflow_schema) {
            await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
              if (current.status === 'submitted') current.process_enqueue_state = 'failed';
              return current;
            });
          }
          reply(res, 503, { error: 'Submission is temporarily unavailable. Please try again.' }); return true;
        }
        if (enqueueCallback && item.configuration?.callback_url) {
          const latest = await floStore.getCase(item.workspace_id, item.application_id);
          try {
            await enqueueCallback({ workspace_id: item.workspace_id, application_id: item.application_id,
              job_type: 'callback', attempt: 0, event_id: latest.events.at(-1).event_id });
          } catch { /* A notification failure must not turn a durable supplier submission into a form error. */ }
        }
        if (item.workflow_schema) {
          const next = await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
            current.events.push(emailEvent(current, 'receipt')); return current;
          });
          try { if (!enqueueEmail) throw new Error('email_queue_unavailable');
            await enqueueEmail({ workspace_id: item.workspace_id, application_id: item.application_id,
              job_type: 'email', attempt: 0, event_id: next.events.at(-1).event_id }); }
          catch { /* Submission is durable; email is retryable. */ }
        } else if (sendConfirmation) {
          try { await sendConfirmation({ to: item.supplier_email, brandName: item.configuration?.brand_name,
            reference: item.customer_reference }); } catch { /* Submission is already durable. */ }
        }
        reply(res, 202, { application_id: item.application_id, status: 'submitted',
          ...(item.flow_id === 'supplier-onboarding-v1' ? {} : { success_url: item.configuration?.success_url }) }); return true;
      }
      reply(res, 404, { error: 'Route not found.' }); return true;
    }
    if (path.startsWith('/portal/api/flo/')) {
      if (!allowedHost(host, portalHost)) { reply(res, 404, { error: 'Not found.' }); return true; }
      const access = await getPortal(req, res, req.method !== 'GET');
      if (!access) return true;
      if (path === '/portal/api/flo/status' && req.method === 'GET') {
        const enabled = (await hasEntitlement?.(access.account.client_id)) === true;
        const has_active_flow = enabled
          && ((workflowPlatformEnabled && (await Promise.all((await workflows.list(access.account.client_id))
            .map((entry) => selectableWorkflow(access.account.client_id, entry.flow_id)))).some(Boolean))
            || (await Promise.all(listTemplates().map(async (entry) => {
              const [published, config] = await Promise.all([
                floStore.getTemplate(entry.flow_id), floStore.getConfig(access.account.client_id, entry.flow_id)]);
              return published?.enabled === true && config?.enabled === true
                && Boolean(resolveTemplate(entry.flow_id, published.version));
            }))).some(Boolean));
        reply(res, 200, { enabled, has_active_flow, workflow_platform_enabled: workflowPlatformEnabled }); return true;
      }
      if ((access.account.role || 'org_admin') !== 'org_admin') { reply(res, 403, { error: 'Organization administrator required.' }); return true; }
      const workspaceId = access.account.client_id;
      if (!(await hasEntitlement?.(workspaceId))) {
        reply(res, 404, { error: 'Flo is not enabled.' }); return true;
      }
      if (path === '/portal/api/flo/workflows/catalog' && req.method === 'GET') {
        reply(res, 200, { checks: await workflows.catalog(workspaceId) }); return true;
      }
      if (path === '/portal/api/flo/workflows/validate' && req.method === 'POST') {
        reply(res, 200, await workflows.validateUnsaved((await body(req, 80 * 1024)).schema, workspaceId)); return true;
      }
      if (path === '/portal/api/flo/workflows' && req.method === 'GET') {
        reply(res, 200, { workflows: await workflows.list(workspaceId) }); return true;
      }
      const orgWorkflow = /^\/portal\/api\/flo\/workflows\/([a-z][a-z0-9-]{2,63})\/(copy|draft|definition|preview|publish|lifecycle|settings|logo|email-templates|email-preview|smtp|test-email)$/.exec(path);
      if (orgWorkflow) {
        const [, flowId, action] = orgWorkflow;
        const record = await workflows.get(flowId, workspaceId);
        if (!record) { reply(res, 404, { error: 'Workflow not found.' }); return true; }
        if (action === 'copy' && req.method === 'POST') {
          reply(res, 201, { workflow: await workflows.copy(flowId, workspaceId) });
        } else if (action === 'definition' && req.method === 'GET') {
          const schema = record.published_version && await floStore.getWorkflowVersion(flowId, record.published_version);
          if (!schema) reply(res, 404, { error: 'Published definition unavailable.' });
          else reply(res, 200, { schema, version: record.published_version, definition_hash: record.definition_hash });
        } else if (action === 'draft' && req.method === 'GET') {
          if (record.owner_workspace_id !== workspaceId) { reply(res, 404, { error: 'Workflow not found.' }); return true; }
          reply(res, 200, { workflow: record });
        } else if (action === 'draft' && req.method === 'PATCH') {
          const input = await body(req);
          reply(res, 200, { workflow: await workflows.saveDraft(flowId, workspaceId, input.schema, input.expected_revision) });
        } else if (action === 'preview' && req.method === 'GET') {
          reply(res, 200, { presentation: schemaPresentation(record.draft || await floStore.getWorkflowVersion(flowId, record.published_version)),
            draft_revision: record.draft_revision });
        } else if (action === 'publish' && req.method === 'POST') {
          const input = await body(req);
          reply(res, 200, { workflow: await workflows.publish(flowId, workspaceId, input.expected_revision) });
        } else if (action === 'lifecycle' && req.method === 'POST') {
          const input = await body(req);
          reply(res, 200, { workflow: await workflows.lifecycle(flowId, workspaceId, input.state, input.expected_revision) });
        } else if (action === 'settings' && req.method === 'GET') {
          reply(res, 200, { settings: await floStore.getConfig(workspaceId, flowId) || { enabled: true, brand_name: 'KYCProbe' } });
        } else if (action === 'settings' && req.method === 'PUT') {
          const input = validateFloConfig(await body(req));
          const previous = await floStore.getConfig(workspaceId, flowId) || {};
          const settings = await floStore.putConfig(workspaceId, { ...previous, ...input }, flowId);
          reply(res, 200, { settings,
            ...(input.callback_url && input.callback_url !== previous.callback_url
              ? { callback_signing_secret: callbackSigningSecret(workspaceId, flowId), signature_key_id: `${flowId}:v1` } : {}) });
        } else if (action === 'logo' && req.method === 'POST') {
          const input = await body(req, 2 * 1024 * 1024);
          const bytes = Buffer.from(String(input.content_base64 || ''), 'base64');
          const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
          const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
          if (!bytes.length || bytes.length > 1024 * 1024 || bytes.toString('base64') !== input.content_base64
            || !(png && input.mime_type === 'image/png' || jpg && input.mime_type === 'image/jpeg'))
            throw new Error('invalid_logo');
          const image = await sharp(bytes, { limitInputPixels: 4_000_000 }).metadata().catch(() => null);
          if (!image || image.format !== (png ? 'png' : 'jpeg') || !image.width || !image.height
            || image.width > 2000 || image.height > 2000) throw new Error('invalid_logo');
          await scan(bytes, { host: process.env.FLO_CLAMD_HOST || process.env.DOCUMENT_OCR_CLAMD_HOST });
          const assetId = randomUUID();
          await floStore.putWorkflowAsset(workspaceId, flowId, assetId, bytes);
          const settings = await floStore.getConfig(workspaceId, flowId) || { enabled: true, brand_name: 'KYCProbe' };
          await floStore.putConfig(workspaceId, { ...settings, logo_asset_id: assetId,
            logo_mime_type: input.mime_type }, flowId);
          reply(res, 201, { logo_asset_id: assetId });
        } else if (action === 'email-templates' && req.method === 'GET') {
          const settings = await floStore.getConfig(workspaceId, flowId) || {};
          reply(res, 200, { templates: settings.email_templates || defaultFloEmailTemplates(),
            version: settings.email_template_version || 0 });
        } else if (action === 'email-templates' && req.method === 'PUT') {
          const input = await body(req);
          const templates = validateEmailTemplates(input.templates);
          const settings = await floStore.getConfig(workspaceId, flowId) || { enabled: true, brand_name: 'KYCProbe' };
          if (input.expected_version !== (settings.email_template_version || 0)) throw new Error('email_template_conflict');
          const version = (settings.email_template_version || 0) + 1;
          await floStore.putConfig(workspaceId, { ...settings, email_templates: templates,
            email_template_version: version }, flowId);
          reply(res, 200, { templates, version });
        } else if (action === 'email-preview' && req.method === 'POST') {
          const input = await body(req);
          const templates = validateEmailTemplates(input.templates || {});
          reply(res, 200, { preview: renderFloEmail(input.kind, {
            brand_name: 'Your Organisation', customer_reference: 'REF-1001', status: 'pending_review',
            application_id: '00000000-0000-0000-0000-000000000000', application_revision: 1,
            secure_link: `https://${supplierHost}/f/${'a'.repeat(48)}` }, templates) });
        } else if (action === 'smtp' && req.method === 'GET') {
          const settings = await floStore.getConfig(workspaceId, flowId) || {};
          let sender_domain_verified = false;
          if (settings.smtp?.enabled) {
            try { sender_domain_verified = await verifyFloSenderDns(settings.smtp); } catch { /* DNS readiness is reflected below. */ }
          }
          reply(res, 200, { smtp: settings.smtp || { enabled: false, configured: false }, sender_domain_verified });
        } else if (action === 'smtp' && req.method === 'PUT') {
          const parsed = validateFloSmtp(await body(req));
          const settings = await floStore.getConfig(workspaceId, flowId) || { enabled: true, brand_name: 'KYCProbe' };
          if (parsed.enabled) await platformStore.setFloSmtp(workspaceId, flowId, parsed.password);
          const { password, ...metadata } = parsed;
          await floStore.putConfig(workspaceId, { ...settings, smtp: metadata }, flowId);
          reply(res, 200, { smtp: metadata });
        } else if (action === 'test-email' && req.method === 'POST') {
          const settings = await floStore.getConfig(workspaceId, flowId) || { brand_name: 'KYCProbe' };
          await sendFloTest({ workspaceId, flowId, to: access.account.email, config: settings, platformStore, mailer });
          reply(res, 200, { status: 'sent', recipient: access.account.email });
        } else reply(res, 405, { error: 'Method not allowed.' });
        return true;
      }
      if (path === '/portal/api/flo/flows' && req.method === 'GET') {
        const legacy = (await Promise.all(listTemplates().map(async (entry) => {
          const published = await floStore.getTemplate(entry.flow_id);
          const config = await floStore.getConfig(workspaceId, entry.flow_id);
          return published?.enabled && config?.enabled
            && resolveTemplate(entry.flow_id, published.version)
            ? { flow_id: entry.flow_id, version: published.version, brand_name: config.brand_name } : null;
        }))).filter(Boolean);
        const stored = workflowPlatformEnabled
          ? (await Promise.all((await workflows.list(workspaceId))
            .map((item) => selectableWorkflow(workspaceId, item.flow_id)))).filter(Boolean) : [];
        const flows = [...legacy, ...stored.map(({ workflow }) => ({ flow_id: workflow.flow_id,
          version: workflow.published_version, brand_name: workflow.name }))];
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
        const bucket = url.searchParams.get('bucket');
        if (bucket && !['open', 'in_progress', 'processing_review', 'restarted', 'accepted', 'rejected', 'expired_failed'].includes(bucket))
          throw new Error('invalid_bucket');
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
        if (!Number.isInteger(limit)) throw new Error('invalid_limit');
        const cursor = url.searchParams.get('cursor') || '';
        const search = (url.searchParams.get('q') || '').trim().toLowerCase();
        if (search.length > 100) throw new Error('invalid_search');
        const all = (await floStore.listCases(workspaceId)).map((item) => ({ ...item, bucket: caseBucket(item) }));
        const counts = Object.fromEntries(['open', 'in_progress', 'processing_review', 'restarted', 'accepted', 'rejected', 'expired_failed']
          .map((name) => [name, all.filter((item) => (!requestedFlow || item.flow_id === requestedFlow) && item.bucket === name).length]));
        const filtered = all.filter((item) => (!requestedFlow || item.flow_id === requestedFlow) && (!bucket || item.bucket === bucket)
          && (!search || [item.customer_reference, item.application_id, item.flow_id].some((value) => String(value || '').toLowerCase().includes(search))));
        const offset = cursor ? filtered.findIndex((item) => item.application_id === cursor) + 1 : 0;
        if (cursor && !offset) throw new Error('invalid_cursor');
        const cases = filtered.slice(offset, offset + limit);
        reply(res, 200, { cases, counts, next_cursor: filtered.length > offset + limit ? cases.at(-1)?.application_id : null });
        void reconcileFloNotifications(workspaceId, { floStore, enqueueEmail, enqueueCallback, caseRows: all })
          .catch(() => {});
        return true;
      }
      const revisionMatch = /^\/portal\/api\/flo\/cases\/([0-9a-f-]{36})\/revisions$/.exec(path);
      if (revisionMatch && req.method === 'GET') {
        const item = await floStore.getCase(workspaceId, revisionMatch[1]);
        if (!item) { reply(res, 404, { error: 'Case not found.' }); return true; }
        reply(res, 200, { application_id: item.application_id, application_revision: item.application_revision || 1,
          revisions: item.revisions || [] }); return true;
      }
      const retryMatch = /^\/portal\/api\/flo\/cases\/([0-9a-f-]{36})\/notifications\/([0-9a-f-]{36})\/retry$/.exec(path);
      if (retryMatch && req.method === 'POST') {
        const item = await floStore.getCase(workspaceId, retryMatch[1]);
        const event = item?.events.find((entry) => entry.event_id === retryMatch[2]);
        if (!event || event.type !== 'email_requested' && (!event.payload || !item.configuration?.callback_url)) {
          reply(res, 404, { error: 'Notification not found.' }); return true;
        }
        const email = event.type === 'email_requested';
        if (email && item.events.some((entry) => entry.type === 'email_skipped' && entry.source_event_id === event.event_id)) {
          reply(res, 409, { error: 'Email link was superseded.' }); return true;
        }
        if (item.events.some((entry) => entry.type === (email ? 'email_delivered' : 'callback_delivered') && entry.source_event_id === event.event_id)) {
          reply(res, 200, { status: 'delivered' }); return true;
        }
        const queue = email ? enqueueEmail : enqueueCallback;
        if (!queue) throw new Error('notification_unavailable');
        await queue({ workspace_id: workspaceId, application_id: item.application_id,
          job_type: email ? 'email' : 'callback', attempt: 0, event_id: event.event_id });
        reply(res, 202, { status: 'queued' }); return true;
      }
      const reissueMatch = /^\/portal\/api\/flo\/cases\/([0-9a-f-]{36})\/reissue-link$/.exec(path);
      if (reissueMatch && req.method === 'POST') {
        const item = await floStore.getCase(workspaceId, reissueMatch[1]);
        if (!item) { reply(res, 404, { error: 'Case not found.' }); return true; }
        if (!item.workflow_schema || item.status !== 'restarted')
          throw new Error('invalid_transition');
        const secret = newSecret();
        const linkHash = hashSecret(secret);
        const supplierUrl = `https://${supplierHost}/f/${secret}`;
        await floStore.putLink(workspaceId, item.application_id, linkHash);
        const updated = await floStore.updateCase(workspaceId, item.application_id, (current) => {
          if (current.status !== 'restarted' || current.link_hash !== item.link_hash
            || current.link_redeemed_at !== item.link_redeemed_at)
            throw new Error('link_reissue_conflict');
          current.link_hash = linkHash;
          current.link_redeemed_at = null;
          current.link_expires_at = new Date(Date.now() + 7 * 86400_000).toISOString();
          current.session_hash = null; current.session_csrf_hash = null; current.session_expires_at = null;
          current.link_delivery = 'not_attempted';
          current.events.push({ event_id: randomUUID(), type: 'link_reissued',
            at: new Date().toISOString(), actor: access.account.email,
            application_revision: current.application_revision || 1 });
          const event = emailEvent(current, 'restart');
          current.notification_links ||= {};
          current.notification_links[event.event_id] = supplierUrl;
          current.events.push(event);
          return current;
        });
        let emailStatus = 'queued';
        try {
          if (!enqueueEmail) throw new Error('email_queue_unavailable');
          await enqueueEmail({ workspace_id: workspaceId, application_id: item.application_id,
            job_type: 'email', attempt: 0, event_id: updated.events.at(-1).event_id });
        } catch {
          emailStatus = 'failed';
          await floStore.updateCase(workspaceId, item.application_id, (current) => {
            current.link_delivery = 'failed'; return current;
          });
        }
        reply(res, 200, { application_id: item.application_id,
          application_revision: updated.application_revision, supplier_url: supplierUrl,
          expires_at: updated.link_expires_at, email_status: emailStatus }); return true;
      }
      const match = /^\/portal\/api\/flo\/cases\/([0-9a-f-]{36})(?:\/(decision|report|report\.html|report\.json|reports|reports\/[1-9][0-9]*(?:\.html|\.json)?|documents\/([0-9a-f-]{36})|diagnostic\/(documents|run|decision|retry-callbacks)))?$/.exec(path);
      if (!match) { reply(res, 404, { error: 'Route not found.' }); return true; }
      const item = await floStore.getCase(workspaceId, match[1]);
      if (!item) { reply(res, 404, { error: 'Case not found.' }); return true; }
      if (!match[2] && req.method === 'GET') { reply(res, 200, { application: buyerCase(item), diagnostic_enabled: diagnosticCaseAllowed(item) }); return true; }
      if (match[2] === 'reports' && req.method === 'POST') {
        if (!item.reports?.length) { reply(res, 409, { error: 'No existing report to reissue.' }); return true; }
        const branded = item.reports.findLast((report) => report.branding === 'AI7EDD');
        if (branded) { reply(res, 200, { version: branded.version, reused: true }); return true; }
        if (!createReport) { reply(res, 503, { error: 'Report generator unavailable.' }); return true; }
        const report = await createReport(item);
        const htmlId = randomUUID(); const modelId = randomUUID();
        await floStore.putEvidence(workspaceId, item.application_id, report.report_id, report.pdf);
        await floStore.putEvidence(workspaceId, item.application_id, htmlId, Buffer.from(report.html));
        await floStore.putEvidence(workspaceId, item.application_id, modelId, Buffer.from(JSON.stringify(report.model)));
        const updated = await floStore.updateCase(workspaceId, item.application_id, (current) => {
          if (current.reports.some((entry) => entry.branding === 'AI7EDD')) return null;
          if (current.reports.length + 1 !== report.version) throw new Error('flo_case_concurrent_update');
          current.reports.push({ report_id: report.report_id, html_id: htmlId, model_id: modelId,
            version: report.version, sha256: report.sha256, generated_at: report.generated_at,
            application_revision: current.application_revision || 1,
            status: 'complete', branding: 'AI7EDD' });
          current.events.push({ event_id: randomUUID(), type: 'report_rebranded', at: new Date().toISOString(),
            actor: access.account.email, report_version: report.version });
          return current;
        });
        const latest = updated.reports.findLast((entry) => entry.branding === 'AI7EDD');
        reply(res, latest?.report_id === report.report_id ? 201 : 200,
          { version: latest.version, reused: latest.report_id !== report.report_id }); return true;
      }
      if (match[2]?.startsWith('diagnostic/')) {
        if (!diagnosticCaseAllowed(item)) { reply(res, 404, { error: 'Route not found.' }); return true; }
        if (req.method !== 'POST') { reply(res, 405, { error: 'Method not allowed.' }); return true; }
        if (match[4] === 'retry-callbacks') {
          if (!enqueueCallback || !item.configuration?.callback_url) { reply(res, 503, { error: 'Callback is unavailable.' }); return true; }
          const updated = await floStore.updateCase(workspaceId, item.application_id, (current) => {
            if (current.diagnostic?.state !== 'complete' || !current.diagnostic.outcome
              || current.diagnostic.callback_retry_requested_at) throw new Error('invalid_transition');
            current.diagnostic.callback_retry_requested_at = new Date().toISOString(); return current;
          });
          const pending = updated.events.filter((event) => ['diagnostic_review_ready', 'diagnostic_decision'].includes(event.type)
            && !updated.events.some((entry) => entry.type === 'callback_delivered' && entry.source_event_id === event.event_id));
          for (const event of pending) await enqueueCallback({ workspace_id: workspaceId,
            application_id: item.application_id, job_type: 'callback', attempt: 0, event_id: event.event_id });
          reply(res, 202, { queued: pending.length }); return true;
        }
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
        const inline = url.searchParams.get('view') === 'inline';
        res.writeHead(200, { 'content-type': document.mime_type, 'content-length': bytes.length,
          'x-content-type-options': 'nosniff',
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${document.document_id}"`,
          'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'self'",
          'x-frame-options': inline ? 'SAMEORIGIN' : 'DENY', 'cache-control': 'no-store' });
        res.end(bytes); return true;
      }
      if (match[2] === 'decision' && req.method === 'POST') {
        const input = await body(req);
        if (!['accepted', 'rejected', 'needs_correction', 'restart'].includes(input.decision)) throw new Error('invalid_decision');
        const restart = input.decision === 'restart' ? validateRestart(input) : null;
        const rationale = String(input.rationale || '').trim();
        if (rationale.length > 2000) throw new Error('invalid_rationale');
        const correctionSecret = ['needs_correction', 'restart'].includes(input.decision) ? newSecret() : null;
        const updated = await floStore.updateCase(workspaceId, item.application_id, (current) => {
          if (restart && !['pending_review', 'needs_correction'].includes(current.status)) throw new Error('invalid_transition');
          if (!restart && !canTransition(current.status, input.decision)
            && !(current.status === 'needs_correction' && input.decision === 'needs_correction' && !current.link_hash))
            throw new Error('invalid_transition');
          const previous_status = current.status;
          if (restart) {
            current.revisions ||= [];
            current.revisions.push({ application_revision: current.application_revision || 1,
              submitted_at: current.submitted_at, draft: structuredClone(current.draft),
              documents: structuredClone(current.documents), checks: structuredClone(current.checks),
              reports: structuredClone(current.reports), events_through: current.events.length });
            current.application_revision = (current.application_revision || 1) + 1;
            current.restart = { ...restart, requested_at: new Date().toISOString(), requested_by: access.account.email };
            current.status = 'restarted';
          } else current.status = input.decision;
          if (correctionSecret) {
            current.link_hash = hashSecret(correctionSecret);
            current.link_redeemed_at = null;
            current.link_expires_at = new Date(Date.now() + 7 * 86400_000).toISOString();
            current.session_hash = null; current.session_csrf_hash = null; current.session_expires_at = null;
            current.link_delivery = 'not_attempted';
          }
          const event = callbackEvent(current, restart ? 'restart_requested' : input.decision, access.account.email);
          event.payload.decision = { outcome: input.decision, rationale: restart?.comments || rationale,
            fields: restart?.fields || [], documents: restart?.documents || [] };
          current.events.push({ ...event, previous_status, rationale,
            report_version: current.reports.at(-1)?.version || null });
          return current;
        });
        if (correctionSecret) {
          await floStore.putLink(workspaceId, item.application_id, hashSecret(correctionSecret));
          if (sendLink && !item.workflow_schema) {
            try { await sendLink({ to: item.supplier_email, url: `https://${supplierHost}/f/${correctionSecret}`,
              brandName: item.configuration?.brand_name });
              await floStore.updateCase(workspaceId, item.application_id, (current) => {
                current.link_delivery = 'sent'; return current;
              });
            } catch { await floStore.updateCase(workspaceId, item.application_id, (current) => {
              current.link_delivery = 'failed'; return current;
            }); }
          }
        }
        if (enqueueCallback && item.configuration?.callback_url)
          try { await enqueueCallback({ workspace_id: workspaceId, application_id: item.application_id,
            job_type: 'callback', attempt: 0, event_id: updated.events.at(-1).event_id }); }
          catch { /* Buyer decision is already durable and event can be retried. */ }
        if (item.workflow_schema) {
          const emailType = restart ? 'restart' : input.decision === 'accepted' || input.decision === 'rejected' ? input.decision : null;
          if (emailType) {
            const next = await floStore.updateCase(workspaceId, item.application_id, (current) => {
              const event = emailEvent(current, emailType);
              if (correctionSecret) {
                current.notification_links ||= {};
                current.notification_links[event.event_id] = `https://${supplierHost}/f/${correctionSecret}`;
              }
              current.events.push(event); return current;
            });
            try { if (!enqueueEmail) throw new Error('email_queue_unavailable');
              await enqueueEmail({ workspace_id: workspaceId, application_id: item.application_id,
                job_type: 'email', attempt: 0, event_id: next.events.at(-1).event_id }); }
            catch { /* Durable email event can be retried without changing the decision. */ }
          }
        }
        reply(res, 200, { application_id: updated.application_id, status: updated.status,
          supplier_url: correctionSecret ? `https://${supplierHost}/f/${correctionSecret}` : null }); return true;
      }
      reply(res, 405, { error: 'Method not allowed.' }); return true;
    }
  } catch (error) {
    const code = /workflow_not_found|workspace_not_found/.test(error.message) ? 404
      : /flo_not_entitled|flo_price_missing|workflow_not_assigned/.test(error.message) ? 403
      : /conflict|transition|not_editable|diagnostic_in_progress|diagnostic_locked/.test(error.message) ? 409
      : /size_limit|request_too_large/.test(error.message) ? 413 : /MALWARE|unavailable|incomplete/.test(error.message) ? 503 : 400;
    reply(res, code, { error: code === 503 ? 'Flo is temporarily unavailable.' : error.message });
    return true;
  }
  return false;
}
