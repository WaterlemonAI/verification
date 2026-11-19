import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { MemoryFloQueue } from '../lib/flows/queue.mjs';
import { WorkflowService } from '../lib/flows/workflow-service.mjs';
import { handleFloRequest } from '../lib/flows/routes.mjs';
import { resolveCaseTemplate } from '../lib/flows/registry.mjs';
import { createFloReport } from '../lib/flows/report-pdf.mjs';

process.env.FLO_DATA_KEY_V1_HEX = '55'.repeat(32);

const isoOffset = (days) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
const company = 'Synthetic Example Trading LLC';
const address = 'Unit 101, Dubai, United Arab Emirates';
const licenceNumber = 'SYN-2026-001';
const iban = 'AE070331234567890123456';

async function syntheticPdf(title) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  page.drawText(`SYNTHETIC TEST DOCUMENT - ${title}`, { x: 40, y: 790, size: 15 });
  page.drawText(company, { x: 40, y: 750, size: 12 });
  return Buffer.from(await pdf.save());
}

test('Al Naboodah UAE company completes supplier submission and source-linked buyer review', async (t) => {
  const schema = JSON.parse(readFileSync(new URL('../docs/flo/al-naboodah/decision13-workflow.json', import.meta.url)));
  const store = new MemoryFloStore(); const queue = new MemoryFloQueue();
  const workspaceId = '1234567890abcdef';
  const workflows = new WorkflowService(store);
  const created = await workflows.create({ name: schema.name, schema });
  const published = await workflows.publish(created.flow_id, null, created.draft_revision);
  await workflows.assign(created.flow_id, workspaceId, 'active');
  await store.putConfig(workspaceId, { enabled: true, brand_name: 'Al Naboodah' }, created.flow_id);

  const server = createServer(async (req, res) => {
    const handled = await handleFloRequest(req, res, new URL(req.url, 'http://localhost'), {
      host: req.headers['x-test-host'], floStore: store,
      customerKey: async () => ({ id: workspaceId }),
      getPortal: async () => ({ account: { client_id: workspaceId, role: 'org_admin', email: 'buyer@example.test' } }),
      hasEntitlement: async () => true, hasFloPrice: async () => true,
      charge: async () => ({ allowed: true, settle: async () => {} }),
      scan: async () => 'passed', enqueue: (job) => queue.enqueue(job),
      enqueueEmail: async () => {} });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (path, host, method = 'GET', data, headers = {}) => {
    const response = await fetch(base + path, { method,
      headers: { 'x-test-host': host, ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes,
      json: () => JSON.parse(bytes.toString()) };
  };

  const link = await send(`/flows/${created.flow_id}/links`, 'api.ai7uae.com', 'POST',
    { customer_reference: 'SYNTHETIC-UAE-1', supplier_email: 'supplier@example.test' },
    { 'idempotency-key': 'synthetic-uae-entity-1' });
  assert.equal(link.status, 201, link.bytes.toString());
  assert.equal(link.json().template_version, published.published_version);
  const applicationId = link.json().application_id;
  const session = await send('/flo/api/session', 'flo.ai7uae.com', 'POST',
    { token: link.json().supplier_url.split('/').at(-1) });
  assert.equal(session.status, 200, session.bytes.toString());
  const supplierHeaders = { cookie: session.headers.get('set-cookie').split(';')[0],
    origin: 'https://flo.ai7uae.com', 'x-flo-application-id': applicationId,
    'x-flo-csrf': session.json().csrf_token };
  assert.equal(session.json().presentation.stages.length, 3);

  const firstDraft = { supplier_type: 'Company or other Legal person',
    registration_jurisdiction: 'United Arab Emirates', address_proof_type: 'Utility bill' };
  assert.equal((await send('/flo/api/draft', 'flo.ai7uae.com', 'POST', firstDraft, supplierHeaders)).status, 200);
  assert.equal((await send('/flo/api/declarations', 'flo.ai7uae.com', 'POST',
    { sample_terms: true }, supplierHeaders)).status, 200);
  for (const type of ['trade_licence', 'identity_document', 'premises_evidence', 'bank_letter']) {
    const uploaded = await send('/flo/api/documents', 'flo.ai7uae.com', 'POST', {
      type, mime_type: 'application/pdf', content_base64: (await syntheticPdf(type)).toString('base64')
    }, supplierHeaders);
    assert.equal(uploaded.status, 201, `${type}: ${uploaded.bytes.toString()}`);
  }
  const beforeExtraction = await send('/flo/api/submit', 'flo.ai7uae.com', 'POST', {}, supplierHeaders);
  assert.equal(beforeExtraction.status, 400);
  assert.ok(beforeExtraction.json().gaps.some((gap) => gap.includes('could not be read yet')));

  const extracted = {
    trade_licence: { company_name_english: company, license_number: licenceNumber,
      license_status: 'Active', company_type: 'LLC', issue_date: isoOffset(-90), expiry_date: isoOffset(365),
      address, business_activity: 'Building materials trading', issuer_name: 'Synthetic Test Registry',
      stakeholder_names: 'Amina Owner', business_manager_names: 'Sam Manager',
      owner_details: 'Amina Owner | Shareholder | 100%' },
    identity_document: { identity_type: 'Emirates ID', full_name_english: 'Sam Manager',
      document_number: 'SYNTHETIC-ID-1', nationality: 'AE', expiry_date: isoOffset(365) },
    premises_evidence: { evidence_type: 'Utility bill', address, tenant_name: company,
      evidence_date: isoOffset(-10), issuer_name: 'Synthetic Utility', document_number: 'SYN-UTILITY-1',
      period_start_date: 'Not Found', period_end_date: 'Not Found', expiry_date: 'Not Found' }
  };
  const bank = { business_name: company, account_holder: company, bank_name: 'Synthetic Test Bank',
    branch_name: 'Dubai', bank_country: 'AE', iban, account_number: '1234567890',
    issue_date: isoOffset(-7), expiry_date: 'Not Found', letterhead_bank_name: 'Synthetic Test Bank' };
  const extractSupplement = async (_bytes, _mime, type) => ({ status: 'completed', model_id: 'synthetic-test',
    schema_version: '1.0.0', data: extracted[type] });
  const extractBank = async () => ({ status: 'completed', model_id: 'synthetic-test',
    schema_version: '1.0.0', data: bank });
  const createReport = (item) => createFloReport(item, {
    loadEvidence: (documentId) => store.getEvidence(workspaceId, applicationId, documentId) });
  assert.equal((await send('/flo/api/extract', 'flo.ai7uae.com', 'POST', {}, supplierHeaders)).status, 202);
  const runWorker = async (job, extras = {}) => {
    const item = await store.getCase(workspaceId, applicationId);
    const template = await resolveCaseTemplate(item, store);
    return template.process(job, { floStore: store, extractSupplement, extractBank, createReport,
      enqueue: (next) => queue.enqueue(next), ...extras });
  };
  await queue.drain((job) => runWorker(job));
  const preview = await send('/flo/api/application', 'flo.ai7uae.com', 'GET', undefined, supplierHeaders);
  assert.equal(preview.status, 200);
  assert.ok(preview.json().application.preview_ready_at);
  assert.equal(preview.json().application.documents.find((doc) => doc.type === 'trade_licence')
    .extraction_result.data.business_manager_names, 'Sam Manager');

  const finalDraft = { business_name: company, registration_country: 'United Arab Emirates',
    licence_number: licenceNumber, licence_expiry: extracted.trade_licence.expiry_date,
    representative_id_expiry: extracted.identity_document.expiry_date,
    website_url: 'https://synthetic-supplier.example', operating_address_same: 'Yes',
    changes_over_twice: 'No', iban, bank_outside_registration: 'No', third_party_payment: 'No',
    cash_payment: 'No', supply_type: 'Services only',
    supply_description: 'Building materials trading services within the licensed activity', intermediary: 'No' };
  assert.equal((await send('/flo/api/draft', 'flo.ai7uae.com', 'POST', finalDraft, supplierHeaders)).status, 200);
  const submitted = await send('/flo/api/submit', 'flo.ai7uae.com', 'POST', {}, supplierHeaders);
  assert.equal(submitted.status, 202, submitted.bytes.toString());

  const providerCalls = [];
  const callProvider = async (serviceId, input) => {
    providerCalls.push({ serviceId, input });
    return { httpStatus: 200, response: serviceId === 'uae-trade-licence'
      ? { status: 'Success', uae_tl_verification: { licence_registration_name: company,
        uae_licence_number: licenceNumber, legal_type_from_entity: 'LLC', license_status: 'Active',
        moec_status: 'Active', expiration_date: extracted.trade_licence.expiry_date,
        licence_registration_address: address,
        business_managers: [{ name: 'Sam Manager' }],
        directors_business_owners: [{ name: 'Amina Owner', shareholding_percent: '100%' }] } }
      : { status: 'Success' } };
  };
  await queue.drain((job) => runWorker(job, { callProvider,
    runGeminiReview: async () => ({ status: 'completed', output: {
      narrative: 'Synthetic evidence requires buyer review.', issues: [], extraction_gaps: [] } }),
  }));
  const reviewed = await store.getCase(workspaceId, applicationId);
  assert.equal(reviewed.status, 'pending_review');
  assert.equal(reviewed.documents.length, 4);
  assert.equal(reviewed.reports.length, 1);
  assert.deepEqual(providerCalls.filter((entry) => entry.serviceId === 'uae-trade-licence')
    .map((entry) => entry.input), [{ company_name: company, licence_number: licenceNumber }]);
  assert.equal(providerCalls.filter((entry) => entry.serviceId === 'merchant-screening').length, 1);
  assert.equal(providerCalls.filter((entry) => entry.serviceId === 'stakeholder-aml').length, 2);
  assert.equal(providerCalls.filter((entry) => entry.serviceId === 'stakeholder-adverse-media').length, 2);
  assert.ok(reviewed.subjects.find((person) => person.name === 'Sam Manager')?.roles.includes('representative'));
  assert.ok(reviewed.subjects.find((person) => person.name === 'Amina Owner')?.roles.some((role) => /owner|shareholder/i.test(role)));
  assert.equal(reviewed.checks.some((check) => check.service_id === 'ejari-verification'), false);
  assert.equal(reviewed.comparisons.find((entry) => entry.rule === 'licence_tlv_business_manager').outcome, 'match');
  assert.ok(reviewed.comparisons.some((entry) => entry.rule === 'owner_shareholding_tlv' && entry.outcome === 'match'));

  const report = await send(`/portal/api/flo/cases/${applicationId}/report`, 'app.kycprobe.com');
  assert.equal(report.status, 200);
  const pdf = await PDFDocument.load(report.bytes);
  assert.ok(pdf.getPageCount() > 0);
  const attachments = pdf.catalog.lookup(PDFName.of('Names'))
    .lookup(PDFName.of('EmbeddedFiles')).lookup(PDFName.of('Names'));
  assert.equal(attachments.size(), 10); // Questionnaire plus four source files.
  const buyer = await send(`/portal/api/flo/cases/${applicationId}`, 'app.kycprobe.com');
  assert.equal(buyer.status, 200);
  assert.equal(buyer.json().application.status, 'pending_review');
});
