import test from 'node:test';
import assert from 'node:assert/strict';
import { CASE_DIRECT_SERVICES, CASE_PAYLOAD_SCHEMA, classifyCaseSubmission, caseExpiresAt,
  caseIsReadable, effectiveCaseTtlDays } from '../lib/case-manager-contract.mjs';

test('v1 covers sixteen current direct submissions and excludes non-submissions', () => {
  assert.equal(CASE_DIRECT_SERVICES.length, 16);
  for (const service of CASE_DIRECT_SERVICES) assert.equal(classifyCaseSubmission('POST', service.path)?.service, service.service);
  assert.equal(CASE_PAYLOAD_SCHEMA.properties.schema_version.const, 1);
  for (const path of ['/service/health', '/service/bank_statement_analysis/bsa_123/result',
    '/service/adverse_media/reports/123.pdf', '/service/adverse_media_search_plus/reports/123.pdf', '/reports/entity-search.pdf']) {
    assert.equal(classifyCaseSubmission('POST', path), null);
  }
  assert.equal(classifyCaseSubmission('GET', '/service/entity_search'), null);
  assert.equal(classifyCaseSubmission('POST', '/forms/vendor/submissions')?.service, 'forms');
  assert.equal(classifyCaseSubmission('POST', '/service/new', { id: 'new', method: 'POST', publicPath: '/service/new' })?.dynamic, true);
});

test('expiry is exact, OCR capped, invalid TTL rejected', () => {
  const accepted = '2026-10-29T10:00:00.000Z';
  assert.equal(effectiveCaseTtlDays(45, { ocr: true }), 30);
  assert.equal(caseExpiresAt(accepted, 1), '2026-10-30T10:00:00.000Z');
  assert.equal(caseExpiresAt(accepted, 45, { formHasOcr: true }), '2026-11-28T10:00:00.000Z');
  for (const bad of [0, 1.5, 46, undefined]) assert.throws(() => effectiveCaseTtlDays(bad));
  const caseRecord = { expires_at: caseExpiresAt(accepted, 1) };
  assert.equal(caseIsReadable(caseRecord, '2026-10-30T09:59:59.999Z'), true);
  assert.equal(caseIsReadable(caseRecord, '2026-10-30T10:00:00.000Z'), false);
});
