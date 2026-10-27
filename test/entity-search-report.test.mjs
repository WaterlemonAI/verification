import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { createEntitySearchAuditPdf, entityProfileName } from '../lib/entity-search-report.mjs';

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
    { category: ['WLT'], score: '94%', basic_details: { first_name: 'Example Test Entity', type: 'Organization', uid: 'ORG-1' },
      watchlists: { authority: [{ watchlist_list_name: 'Example Authority - Enforcement Notices' }] } }
  ] } };
  const matched = await createEntitySearchAuditPdf({ request, response, httpStatus: 200,
    completedAt: '2026-10-27T00:00:00Z', transactionId: 'qa-match' });
  assert.equal(entityProfileName(response.data.profiles[0]), 'Example Test Entity');
  assert.equal(matched.outcome, 'POSSIBLE IDENTITY MATCHES - REVIEW');
  assert.equal(matched.candidateSummary.nameAligned, 1);
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

test('organization profiles show their basic names and report unmatched or wrong-type hits without inflating counts', async () => {
  const organization = { basic_details: { first_name: 'Smilesville Trading', type: 'Organization', uid: 'ORG-1' },
    category: ['PEP', 'WLT'], score: '92%', watchlists: { authority: [{ watchlist_list_name: 'Registry' }] } };
  const unrelated = { basic_details: { first_name: 'Another Company', type: 'Organization', uid: 'ORG-2' },
    category: ['WLT'], score: '85%' };
  const wrongType = { basic_details: { first_name: 'Smilesville Trading', type: 'Individual', uid: 'PER-3' },
    category: ['PEP'], score: '80%' };
  const businessRequest = { ...request, name: 'Smilesville Trading', type: 'Organization' };
  const response = { message: 'Search Successful', profiles_success: true,
    data: { profiles: [organization, unrelated, wrongType] } };
  const report = await createEntitySearchAuditPdf({ request: businessRequest, response, httpStatus: 200,
    completedAt: '2026-10-27T00:00:00Z', transactionId: 'qa-org' });
  assert.equal(report.outcome, 'POSSIBLE IDENTITY MATCHES - REVIEW');
  assert.deepEqual(report.candidateSummary, { returned: 3, categoryAppearances: 4, nameAligned: 2,
    partialNames: 0, namesAbsent: 0, typeConflicts: 1, plausibleNames: 1 });
  const noAlignedName = await createEntitySearchAuditPdf({ request: businessRequest,
    response: { ...response, data: { profiles: [unrelated] } }, httpStatus: 200,
    completedAt: '2026-10-27T00:00:00Z', transactionId: 'qa-unrelated' });
  assert.equal(noAlignedName.outcome, 'UNVERIFIED SEARCH HITS - REVIEW');
  assert.equal(noAlignedName.candidateSummary.plausibleNames, 0);
  const unnamed = await createEntitySearchAuditPdf({ request: businessRequest,
    response: { ...response, data: { profiles: [{ category: ['WLT'], score: '99%' }] } }, httpStatus: 200,
    completedAt: '2026-10-27T00:00:00Z', transactionId: 'qa-unnamed' });
  assert.equal(unnamed.outcome, 'UNVERIFIED SEARCH HITS - REVIEW');
  assert.equal(unnamed.candidateSummary.namesAbsent, 1);
});
