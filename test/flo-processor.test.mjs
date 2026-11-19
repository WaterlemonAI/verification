import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { processFloApplication, processGenericFloApplication } from '../lib/flows/processor.mjs';
import { createFloReport } from '../lib/flows/report-pdf.mjs';
import { randomUUID } from 'node:crypto';
import { supplierCase } from '../lib/flows/projections.mjs';

process.env.FLO_DATA_KEY_HEX = '22'.repeat(32);

test('provider failure stays visible and PDF is retained without buyer acceptance', async () => {
  const store = new MemoryFloStore();
  const workspace = '1234567890abcdef';
  const { case: item } = await store.createCase(workspace, { customer_reference: 'REF', supplier_email: 'a@example.com', prefill: {} },
    'idem-12345678', 'a'.repeat(64), { enabled: true });
  await store.updateCase(workspace, item.application_id, (current) => {
    current.status = 'submitted'; current.draft = { business_name: 'Example', licence_number: 'LIC-1', iban: 'AE123',
      stakeholders: [{ name: 'Person One', role: 'shareholder', ownership_percentage: 40 }] };
    return current;
  });
  await processFloApplication({ workspace_id: workspace, application_id: item.application_id }, {
    floStore: store, callProvider: async (id) => ({ httpStatus: id === 'uae-trade-licence' ? 500 : 200,
      response: id === 'uae-trade-licence' ? { status: 'Error' } : { status: 'Success' } }), createReport: createFloReport
  });
  const completed = await store.getCase(workspace, item.application_id);
  assert.equal(completed.status, 'pending_review');
  assert.equal(completed.checks.find((check) => check.service_id === 'uae-trade-licence').business_result, 'could_not_complete');
  assert.equal(completed.checks.filter((check) => check.service_id === 'stakeholder-adverse-media').length, 1);
  assert.equal(completed.reports.length, 1);
  const bytes = await store.getEvidence(workspace, item.application_id, completed.reports[0].report_id);
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
});

test('optional Ejari PDF result and certificate are retained in Flo and compared to the licence', async () => {
  const store = new MemoryFloStore();
  const workspace = '1234567890abcdef';
  const { case: item } = await store.createCase(workspace,
    { customer_reference: 'EJARI', supplier_email: 'a@example.com', prefill: {} },
    'idem-ejari-1234', 'b'.repeat(64), { enabled: true });
  const ejariId = randomUUID();
  await store.putEvidence(workspace, item.application_id, ejariId, Buffer.from('%PDF-1.4\nexample'));
  await store.updateCase(workspace, item.application_id, (current) => {
    current.status = 'submitted'; current.draft = { business_name: 'Example LLC', licence_number: 'LIC-1' };
    current.documents = [
      { document_id: randomUUID(), type: 'trade_licence', extraction_state: 'completed',
        extraction_result: { data: { company_name_english: 'Example LLC', license_number: 'LIC-1' } } },
      { document_id: ejariId, type: 'ejari', mime_type: 'application/pdf', extraction_state: 'not_run',
        uploaded_at: new Date().toISOString() }
    ];
    return current;
  });
  const ejariStore = {
    async createJob({ pdfBytes }) { assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-'); return { job: { id: 'ejari_test' } }; },
    async getResult() { return { job: { status: 'verified' }, result: { status: 'verified',
      fields: { tenant_name: 'Example LLC' }, reasonCodes: [], certificateAvailable: true } }; },
    async getCertificate() { return Buffer.from('%PDF-1.4\ncertificate'); }
  };
  await processFloApplication({ workspace_id: workspace, application_id: item.application_id, job_type: 'process', attempt: 0 }, {
    floStore: store, ejariStore, callProvider: async () => ({ httpStatus: 200, response: { status: 'Success' } }),
    createReport: createFloReport
  });
  const completed = await store.getCase(workspace, item.application_id);
  const document = completed.documents.find((value) => value.document_id === ejariId);
  assert.equal(document.extraction_result.data.status, 'verified');
  assert.equal((await store.getEvidence(workspace, item.application_id, document.certificate_document_id)).subarray(0, 4).toString(), '%PDF');
  assert.equal(completed.checks.find((check) => check.service_id === 'ejari-verification').coverage, 'complete');
  assert.equal(completed.comparisons.find((comparison) => comparison.rule === 'ejari_tenant_licence_name').outcome, 'match');
});

test('generic Flo preview extracts a custom document before supplier submission', async () => {
  const store = new MemoryFloStore();
  const workspace = '1234567890abcdef';
  const { case: item } = await store.createCase(workspace,
    { customer_reference: 'OCR', supplier_email: 'a@example.com', prefill: {} },
    'idem-generic-ocr', 'c'.repeat(64), { enabled: true });
  const documentId = randomUUID();
  await store.putEvidence(workspace, item.application_id, documentId, Buffer.from('synthetic-image'));
  await store.updateCase(workspace, item.application_id, (current) => {
    current.status = 'in_progress';
    current.workflow_schema = { schema_version: '1.0.0', name: 'Example', stages: [], checks: [], tokens: {} };
    current.documents = [{ document_id: documentId, type: 'incorporation_record', mime_type: 'image/png',
      extraction_state: 'not_run', uploaded_at: new Date().toISOString() }];
    return current;
  });
  await processFloApplication({ workspace_id: workspace, application_id: item.application_id,
    job_type: 'preview', attempt: 0 }, { floStore: store,
    extractSupplement: async (_bytes, _mime, type) => {
      assert.equal(type, 'incorporation_record');
      return { status: 'completed', model_id: 'mock', schema_version: '1.0.0',
        data: { company_name: 'Example LLC', registration_number: '42', incorporation_date: '2026-01-01',
          registration_country: 'United Arab Emirates', business_activities: 'Construction', issuer_name: 'Registry' } };
    } });
  const projected = supplierCase(await store.getCase(workspace, item.application_id));
  assert.ok(projected.preview_ready_at);
  assert.equal(projected.documents[0].extraction_result.data.company_name, 'Example LLC');
  assert.equal(projected.documents[0].extraction_result.data.business_activities, 'Construction');
});

test('generic checks route natural persons and foreign suppliers without a UAE licence assumption', async () => {
  const cases = [
    { supplier_type: 'Natural person', business_name: 'Person One', registration_country: 'AE',
      expectedType: 'individual', expectedAmlType: 'Individual' },
    { supplier_type: 'Company or other Legal person', registration_jurisdiction: 'Outside the UAE',
      business_name: 'Foreign Example Ltd', registration_country: 'GB',
      expectedType: 'business', expectedAmlType: 'Organization' }
  ];
  for (const [index, sample] of cases.entries()) {
    const store = new MemoryFloStore(); const workspace = '1234567890abcdef';
    const { case: item } = await store.createCase(workspace,
      { customer_reference: `ROUTE-${index}`, supplier_email: 'a@example.com', prefill: {} },
      `idem-route-${index}`, String(index + 1).repeat(64), { enabled: true });
    await store.updateCase(workspace, item.application_id, (current) => {
      current.workflow_schema = { schema_version: '1.0.0', name: 'Example', stages: [],
        checks: ['uae-trade-licence', 'entity-aml', 'entity-adverse-media'], tokens: {} };
      current.status = 'submitted'; current.draft = sample; return current;
    });
    const calls = [];
    await processGenericFloApplication({ workspace_id: workspace, application_id: item.application_id }, {
      floStore: store, callProvider: async (serviceId, input) => {
        calls.push({ serviceId, input }); return { httpStatus: 200, response: { status: 'Success' } };
      }, createReport: async () => ({ report_id: randomUUID(), pdf: Buffer.from('%PDF'), html: '<p>Review</p>',
        model: {}, version: '1.0.0', sha256: 'a'.repeat(64), generated_at: new Date().toISOString() })
    });
    assert.equal(calls.find((call) => call.serviceId === 'entity-aml')?.input.type, sample.expectedAmlType);
    assert.equal(calls.find((call) => call.serviceId === 'entity-adverse-media')?.input.entity_type, sample.expectedType);
    assert.equal(calls.some((call) => call.serviceId === 'uae-trade-licence'), false);
  }
});

test('document-sourced owners and representative receive both stakeholder screenings', async () => {
  const store = new MemoryFloStore(); const workspace = '1234567890abcdef';
  const { case: item } = await store.createCase(workspace,
    { customer_reference: 'STAKEHOLDER-1', supplier_email: 'a@example.com', prefill: {} },
    'stakeholder-case', '1'.repeat(64), { enabled: true });
  await store.updateCase(workspace, item.application_id, (current) => {
    current.workflow_schema = { schema_version: '1.0.0', name: 'Al Naboodah', stages: [],
      checks: ['stakeholder-aml', 'stakeholder-adverse-media'], tokens: {} };
    current.status = 'submitted';
    current.draft = { supplier_type: 'Company or other Legal person', business_name: 'Example LLC',
      registration_country: 'AE' };
    current.documents = [
      { document_id: 'licence', type: 'trade_licence', extraction_state: 'completed',
        extraction_result: { data: { stakeholder_names: 'Amina Owner; Rafi Director' } } },
      { document_id: 'identity', type: 'identity_document', extraction_state: 'completed',
        extraction_result: { data: { full_name_english: 'Rafi Director' } } }
    ];
    return current;
  });
  const calls = [];
  await processGenericFloApplication({ workspace_id: workspace, application_id: item.application_id }, {
    floStore: store, callProvider: async (serviceId, input) => {
      calls.push({ serviceId, input }); return { httpStatus: 200, response: { status: 'Success' } };
    }, createReport: async () => ({ report_id: randomUUID(), pdf: Buffer.from('%PDF'), html: '<p>Review</p>',
      model: {}, version: '1.0.0', sha256: 'a'.repeat(64), generated_at: new Date().toISOString() })
  });
  const updated = await store.getCase(workspace, item.application_id);
  assert.equal(updated.subjects.length, 3); // entity, owner, representative/director
  assert.equal(updated.checks.filter((check) => check.service_id === 'stakeholder-aml').length, 2);
  assert.equal(updated.checks.filter((check) => check.service_id === 'stakeholder-adverse-media').length, 2);
  assert.equal(calls.length, 4);
  assert.ok(updated.subjects.find((subject) => subject.name === 'Rafi Director').roles.includes('representative'));
});

test('trade licence verification managers and owners become source-linked screening subjects', async () => {
  const store = new MemoryFloStore(); const workspace = '1234567890abcdef';
  const { case: item } = await store.createCase(workspace,
    { customer_reference: 'MANAGER-1', supplier_email: 'a@example.com', prefill: {} },
    'manager-case', '2'.repeat(64), { enabled: true });
  await store.updateCase(workspace, item.application_id, (current) => {
    current.workflow_schema = { schema_version: '1.0.0', name: 'Al Naboodah', stages: [],
      checks: ['stakeholder-aml', 'stakeholder-adverse-media', 'uae-trade-licence'], tokens: {} };
    current.status = 'submitted'; current.draft = { supplier_type: 'Company or other Legal person',
      registration_jurisdiction: 'United Arab Emirates', business_name: 'Example LLC',
      licence_number: '123', registration_country: 'AE' };
    current.documents = [
      { document_id: 'licence', type: 'trade_licence', extraction_state: 'completed',
        extraction_result: { data: { license_number: '123', business_manager_names: 'Sam Manager' } } },
      { document_id: 'identity', type: 'identity_document', extraction_state: 'completed',
        extraction_result: { data: { full_name_english: 'Rafi Representative' } } }
    ]; return current;
  });
  const calls = [];
  await processGenericFloApplication({ workspace_id: workspace, application_id: item.application_id }, {
    floStore: store, callProvider: async (serviceId, input) => {
      calls.push({ serviceId, input });
      return { httpStatus: 200, response: serviceId === 'uae-trade-licence'
        ? { status: 'Success', uae_tl_verification: {
          business_manager: { name: 'Sam Manager', nationality: 'AE' },
          directors_business_owners: [{ name: 'Amina Owner', shareholding_percent: '70%' }] } }
        : { status: 'Success' } };
    }, createReport: async () => ({ report_id: randomUUID(), pdf: Buffer.from('%PDF'), html: '<p>Review</p>',
      model: {}, version: '1.0.0', sha256: 'a'.repeat(64), generated_at: new Date().toISOString() })
  });
  const updated = await store.getCase(workspace, item.application_id);
  const manager = updated.subjects.find((subject) => subject.name === 'Sam Manager');
  const owner = updated.subjects.find((subject) => subject.name === 'Amina Owner');
  assert.ok(manager.roles.includes('verified business manager'));
  assert.ok(manager.source_ids.some((source) => updated.checks.some((check) => check.check_id === source
    && check.service_id === 'uae-trade-licence')));
  assert.equal(owner.shareholding_percent, '70%');
  for (const person of [manager, owner]) {
    assert.ok(updated.checks.some((check) => check.service_id === 'stakeholder-aml'
      && check.subject_id === person.subject_id));
    assert.ok(updated.checks.some((check) => check.service_id === 'stakeholder-adverse-media'
      && check.subject_id === person.subject_id));
  }
  assert.equal(calls.filter((call) => call.serviceId.startsWith('stakeholder-')).length, 6);
});
