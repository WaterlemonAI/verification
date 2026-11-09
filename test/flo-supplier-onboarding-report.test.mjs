import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createFloReport } from '../lib/flows/report-pdf.mjs';

test('supplier report retains typed sections, incomplete coverage and full per-subject adverse evidence', async () => {
  const item = {
    application_id: '00000000-0000-4000-8000-000000000001', workspace_id: '1234567890abcdef',
    flow_id: 'supplier-onboarding-v1', template_version: '1.0.0', status: 'pending_review',
    draft: { supplierType: 'legal_entity', tradingName: 'Example LLC', supplyType: 'services',
      siteActivities: 'Consulting', owners: [{ fullName: 'Alice Example', role: 'UBO', share: '75' }] },
    documents: [{ document_id: 'licence-1', type: 'tradeLicenceFile', sha256: 'abc', scan_result: 'passed',
      extraction_state: 'completed', extraction_result: { data: { company_name_english: 'Example LLC', license_number: 'LIC-1' } } }],
    subjects: [{ subject_id: 'person-1', name: 'Alice Example', type: 'individual', roles: ['UBO'], source_ids: ['licence-1'] }],
    checks: [
      { service_id: 'stakeholder-adverse-media', subject_id: 'person-1', transport: 'completed', coverage: 'complete',
        business_result: 'review', reason_codes: [], raw_response: { matches: [{ id: 'hit-1', narrative: 'Synthetic evidence <review>' }] } },
      { service_id: 'bank-letter-authenticity', subject_id: 'entity-1', transport: 'not_run', coverage: 'not_run',
        business_result: 'could_not_complete', reason_codes: ['no_documented_provider'] }
    ],
    facts: [], comparisons: [], preview_issues: [], reports: [],
    gemini_review: { status: 'not_run', reason_codes: ['gemini_unconfigured'] }
  };
  const report = await createFloReport(item);
  assert.equal(report.model.flow_id, 'supplier-onboarding-v1');
  assert.ok(report.model.sections.some((section) => section.title === 'Organisation, UBOs and signing authority'
    && section.lines.some((line) => line.includes('Alice Example'))));
  assert.ok(report.model.sections.some((section) => section.title === 'Incomplete or unavailable checks'
    && section.lines.some((line) => line.includes('bank-letter-authenticity'))));
  assert.ok(report.model.sections.some((section) => section.title === 'Adverse-media response appendix'
    && section.lines.some((line) => line.includes('hit-1'))));
  assert.ok(report.html.includes('hit-1'));
  assert.ok(report.html.includes('&lt;review&gt;'));
  assert.ok(report.pdf.length > 1000);
  assert.ok((await PDFDocument.load(report.pdf)).getPageCount() >= 1);
});
