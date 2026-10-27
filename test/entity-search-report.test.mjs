import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { createEntitySearchAuditPdf } from '../lib/entity-search-report.mjs';

const request = { name: 'Example Test Entity', type: 'Business', search_type: ['pep', 'sanction', 'watchlist'],
  fields_weightage: [{ field: 'name', weightage: 1 }], fuzziness: 0.8 };

test('a completed no-match result reports no identified risk indicators without a JSON attachment', async () => {
  const report = await createEntitySearchAuditPdf({ request,
    response: { message: 'Search Successful', profiles_success: true, data: { profiles: [] } },
    httpStatus: 200, completedAt: '2026-10-27T00:00:00Z', transactionId: 'qa-no-match' });
  assert.equal(report.outcome, 'NO IDENTIFIED RISK INDICATORS');
  assert.deepEqual(report.datasetOutcomes.map(item => [item.count, item.assessed]), [[0, true], [0, true], [0, true]]);
  const pdf = await PDFDocument.load(report.bytes);
  assert.ok(pdf.getPageCount() <= 4);
  assert.equal(pdf.catalog.get(PDFName.of('Names')), undefined);
  assert.match(pdf.getTitle(), /KYCProbe AML Screening/);
});

test('returned candidate categories stay potential matches and incomplete coverage fails closed', async () => {
  const response = { message: 'Search Successful', profiles_success: true, data: { profiles: [
    { category: ['WLT'], score: '94%', personal_details: { name: [{ first_name: 'Example', last_name: 'Person' }] },
      watchlists: { authority: [{ watchlist_list_name: 'Example Authority - Enforcement Notices' }] } }
  ] } };
  const matched = await createEntitySearchAuditPdf({ request, response, httpStatus: 200,
    completedAt: '2026-10-27T00:00:00Z', transactionId: 'qa-match' });
  assert.equal(matched.outcome, 'POTENTIAL MATCHES - REVIEW REQUIRED');
  assert.deepEqual(matched.datasetOutcomes.map(item => item.count), [0, 0, 1]);
  const incomplete = await createEntitySearchAuditPdf({ request,
    response: { ...response, profiles_success: false }, httpStatus: 200,
    completedAt: '2026-10-27T00:00:00Z', transactionId: 'qa-incomplete' });
  assert.equal(incomplete.outcome, 'SCREENING INCOMPLETE');
  assert.equal(incomplete.datasetOutcomes.every(item => !item.assessed), true);
  const unconfirmed = await createEntitySearchAuditPdf({ request,
    response: { message: 'Search Successful', data: { profiles: [] } }, httpStatus: 200,
    completedAt: '2026-10-27T00:00:00Z', transactionId: 'qa-unconfirmed' });
  assert.equal(unconfirmed.outcome, 'SCREENING INCOMPLETE');
});
