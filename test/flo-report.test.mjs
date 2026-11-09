import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFloReportModel } from '../lib/flows/report-model.mjs';
import { createFloReport } from '../lib/flows/report-pdf.mjs';

test('a corrected report reads the latest retained document and HTML/PDF share its model', async () => {
  const item = { application_id: '11111111-1111-4111-8111-111111111111', workspace_id: '1234567890abcdef',
    status: 'processing', draft: { business_name: 'New Name LLC', licence_number: 'N-1', stakeholders: [] },
    documents: [
      { type: 'trade_licence', document_id: 'old', extraction_result: { data: { license_status: 'Expired' } } },
      { type: 'trade_licence', document_id: 'new', extraction_result: { data: { license_status: 'Active' } } },
      { type: 'formation_document', document_id: 'formation', extraction_result: { data: { shareholders: 'unreadable' } } }
    ], checks: [], comparisons: [], reports: [{ version: 1 }] };
  const report = await createFloReport(item);
  const model = buildFloReportModel(item);
  assert.equal(report.version, 2);
  assert.ok(model.sections[0].lines.includes('Trade licence status: Active'));
  assert.ok(report.model.sections[0].lines.includes('Trade licence status: Active'));
  assert.match(report.html, /Trade licence status: Active/);
  assert.equal(report.pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(!report.html.includes('Trade licence status: Expired'));
  const arabic = await createFloReport({ ...item, draft: { ...item.draft, business_name: 'شركة الاختبار' } });
  assert.ok(arabic.html.includes('شركة الاختبار'));
  assert.equal(arabic.pdf.subarray(0, 4).toString(), '%PDF');
});
