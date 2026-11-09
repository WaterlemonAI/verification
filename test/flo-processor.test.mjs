import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { processFloApplication } from '../lib/flows/processor.mjs';
import { createFloReport } from '../lib/flows/report-pdf.mjs';
import { randomUUID } from 'node:crypto';

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
