import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { genericTemplate, schemaSubmissionGaps } from '../lib/flows/template-schema.mjs';
import { handleFloRequest } from '../lib/flows/routes.mjs';
import { hashSecret } from '../lib/flows/session.mjs';
import { callProcurementMeeting, KYS_CALENDAR_EMAIL } from '../lib/flows/meeting-client.mjs';
import { readFileSync } from 'node:fs';
import { validateWorkflowSchema } from '../lib/flows/template-schema.mjs';
import { buildFloReportModel } from '../lib/flows/report-model.mjs';
import { createFloReport } from '../lib/flows/report-pdf.mjs';
import { PDFDocument, PDFName } from 'pdf-lib';

test('downloadable report embeds the source document as well as the populated questionnaire', async () => {
  const item = { application_id: '00000000-0000-4000-8000-000000000001', workspace_id: '1234567890abcdef',
    flow_id: 'al-naboodah-digital', template_version: '1.0.0', status: 'pending_review', draft: {},
    documents: [{ document_id: '00000000-0000-4000-8000-000000000009', type: 'natural_identity',
      mime_type: 'image/png', sha256: 'synthetic', scan_result: 'passed', extraction_state: 'completed' }],
    checks: [], comparisons: [], reports: [] };
  const report = await createFloReport(item, { loadEvidence: async () => Buffer.from('synthetic-image') });
  const pdf = await PDFDocument.load(report.pdf);
  const attachments = pdf.catalog.lookup(PDFName.of('Names')).lookup(PDFName.of('EmbeddedFiles')).lookup(PDFName.of('Names'));
  assert.equal(attachments.size(), 4); // questionnaire JSON and original identity document
});

test('Al Naboodah draft validates with meeting, document-first identity and home-country bank evidence', () => {
  const draft = JSON.parse(readFileSync(new URL('../docs/flo/al-naboodah/decision13-workflow.json', import.meta.url)));
  const schema = validateWorkflowSchema(draft, draft.checks);
  assert.equal(schema.meeting.procurement_email, 'arbaz@ai7lab.net');
  assert.equal(schema.stages[0].documents.find((entry) => entry.id === 'natural_identity').required, true);
  assert.match(schema.stages[0].documents.find((entry) => entry.id === 'bank_letter').label, /home-country/);
  const item = { application_id: 'test', workspace_id: 'test', flow_id: 'al-naboodah', template_version: '1.0.0',
    workflow_schema: schema, draft: { supplier_type: 'Natural person' }, documents: [], checks: [], comparisons: [],
    meeting: { status: 'booked', starts_at: '2026-11-25T09:00:00+04:00', completed_at: '2026-11-25T10:00:00Z',
      completed_by: 'buyer@example.com', note: 'ID and premises reviewed' } };
  const report = buildFloReportModel(item);
  assert.ok(report.sections.some((entry) => entry.title === 'Supplier meeting record'
    && entry.lines.some((line) => line.includes('ID and premises reviewed'))));
});

test('meeting client uses the configured private credential and never a supplier key', async () => {
  const calls = [];
  const platformStore = {
    getIntegrationById: async (id) => ({ enabled: true, upstreamUrl: `https://work.ai7uae.com/api/integrations/procurement-meetings${id === 'meeting-availability' ? '/availability' : ''}` }),
    getMasterKey: async (id) => { assert.equal(id, 'meeting-availability'); return 'private-test-token'; }
  };
  const result = await callProcurementMeeting('availability', { calendarEmail: KYS_CALENDAR_EMAIL, dates: ['2026-11-25'] },
    { platformStore, fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ dates: [] }), { status: 200 }); } });
  assert.equal(result.status, 200);
  assert.equal(calls[0].options.headers.authorization, 'Bearer private-test-token');
  assert.equal(calls[0].options.headers['idempotency-key'], undefined);
});

test('natural person booking and buyer confirmation are distinct guarded steps', async (t) => {
  process.env.FLO_DATA_KEY_V1_HEX = '55'.repeat(32);
  const schema = { schema_version: '1.0.0', name: 'Digital supplier onboarding', stages: [{ id: 'documents_first', title: 'Documents first',
    fields: [{ id: 'supplier_type', label: 'Supplier type', type: 'select', required: true,
      options: ['Company or other Legal person', 'Natural person'] }], documents: [], declarations: [] }], checks: [],
    meeting: { required_for: { field: 'supplier_type', equals: 'Natural person' }, procurement_email: 'arbaz@ai7lab.net' } };
  const template = genericTemplate('al-naboodah-digital', '1.0.0', schema);
  const store = new MemoryFloStore(); const workspaceId = '1234567890abcdef';
  const { case: item } = await store.createCase(workspaceId,
    { customer_reference: 'TEST-MEETING', supplier_email: 'supplier@example.com' }, 'meeting-test', hashSecret('link'),
    { brand_name: 'Al Naboodah' }, template);
  const session = `${workspaceId}.${item.application_id}.synthetic-session`;
  await store.updateCase(workspaceId, item.application_id, (current) => { current.status = 'in_progress';
    current.draft = { supplier_type: 'Natural person' }; current.session_hash = hashSecret(session);
    current.session_csrf_hash = hashSecret('csrf'); current.session_expires_at = new Date(Date.now() + 3600_000).toISOString();
    return current; });
  const providerCalls = [];
  const meetingApi = async (kind, payload, key) => { providerCalls.push({ kind, payload, key });
    if (kind === 'availability') { const date = payload.dates[0]; return { status: 200, data: { dates: [{ date,
      slots: [{ startsAt: `${date}T09:00:00+04:00`, endsAt: `${date}T09:30:00+04:00`, startTime: '09:00', endTime: '09:30' }] }] } }; }
    return { status: 201, data: { eventUid: 'event-123', meetingUrl: 'https://work.ai7uae.com/meeting/event-123', status: 'sent' } };
  };
  const server = createServer(async (req, res) => {
    const handled = await handleFloRequest(req, res, new URL(req.url, 'http://localhost'), {
      host: req.headers['x-test-host'], floStore: store, meetingApi,
      getPortal: async () => ({ account: { client_id: workspaceId, email: 'buyer@example.com', role: 'org_admin' } }),
      hasEntitlement: async () => true,
      createReport: async (record) => ({ report_id: '00000000-0000-4000-8000-000000000002',
        version: record.reports.length + 1, generated_at: new Date().toISOString(), sha256: 'synthetic',
        pdf: Buffer.from('%PDF-1.4\nsynthetic'), html: '<p>meeting</p>', model: { meeting: record.meeting } }) });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (path, host, data, headers = {}) => { const response = await fetch(base + path, { method: 'POST',
    headers: { 'x-test-host': host, 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() }; };
  const supplierHeaders = { cookie: `__Host-flo_session=${session}`, origin: 'https://flo.ai7uae.com',
    'x-flo-application-id': item.application_id, 'x-flo-csrf': 'csrf' };
  const available = await send('/flo/api/meeting/availability', 'flo.ai7uae.com', {}, supplierHeaders);
  assert.equal(available.status, 200, JSON.stringify(available.data)); assert.equal(providerCalls[0].payload.calendarEmail, KYS_CALENDAR_EMAIL);
  const startsAt = available.data.slots[0].starts_at;
  const booked = await send('/flo/api/meeting/book', 'flo.ai7uae.com', { starts_at: startsAt }, supplierHeaders);
  assert.equal(booked.status, 200);
  assert.equal(providerCalls[1].payload.procurementEmail, 'arbaz@ai7lab.net');
  assert.equal(providerCalls[1].payload.supplierEmail, 'supplier@example.com');
  assert.match(providerCalls[1].key, /^flo-/);
  const repeat = await send('/flo/api/meeting/book', 'flo.ai7uae.com', { starts_at: startsAt }, supplierHeaders);
  assert.equal(repeat.status, 200); assert.equal(providerCalls.length, 2);
  let current = await store.getCase(workspaceId, item.application_id);
  assert.deepEqual(schemaSubmissionGaps(schema, current), []);
  await store.updateCase(workspaceId, item.application_id, (record) => {
    record.meeting.starts_at = new Date(Date.now() - 3600_000).toISOString();
    record.status = 'pending_review'; record.reports = [{ version: 1,
      generated_at: new Date(Date.now() - 7200_000).toISOString() }]; return record;
  });
  const earlyAcceptance = await send(`/portal/api/flo/cases/${item.application_id}/decision`, 'app.kycprobe.com',
    { decision: 'accepted', rationale: 'Documents checked' });
  assert.equal(earlyAcceptance.status, 409);
  const confirmation = await send(`/portal/api/flo/cases/${item.application_id}/meeting/complete`, 'app.kycprobe.com',
    { met_at: new Date(Date.now() - 1800_000).toISOString(), note: 'Passport compared with caller and premises reviewed.' });
  assert.equal(confirmation.status, 200);
  current = await store.getCase(workspaceId, item.application_id);
  assert.equal(current.meeting.completed_by, 'buyer@example.com');
  assert.equal(current.reports.length, 2);
  assert.deepEqual(schemaSubmissionGaps(schema, current), []);
  const accepted = await send(`/portal/api/flo/cases/${item.application_id}/decision`, 'app.kycprobe.com',
    { decision: 'accepted', rationale: 'Meeting and documents reviewed' });
  assert.equal(accepted.status, 200);
});
