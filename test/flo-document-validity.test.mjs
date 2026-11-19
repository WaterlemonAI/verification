import test from 'node:test';
import assert from 'node:assert/strict';
import { documentValidityIssues } from '../lib/flows/document-validity.mjs';

const asOf = new Date('2026-11-20T12:00:00Z');
const document = (type, data, id = type) => ({ document_id: id, type, extraction_state: 'completed',
  extraction_result: { data } });
const item = (documents, draft = {}) => ({ workflow_schema: { document_policy: { ocr_required: true, reject_expired: true } },
  documents, draft });

test('expired OCR document is rejected with the supplier replacement message', () => {
  for (const [type, data, draft] of [
    ['trade_licence', { expiry_date: '2026-11-19' }, {}],
    ['natural_identity', { expiry_date: '2026-11-19' }, {}],
    ['identity_document', { expiry_date: '2026-11-19' }, {}],
    ['premises_evidence', { address: 'Dubai', evidence_type: 'Tenancy or lease', period_end_date: '2026-11-19' },
      { address_proof_type: 'Tenancy or lease' }],
    ['ejari', { fields: { end_date: '2026-11-19' } }, { address_proof_type: 'Ejari' }]
  ]) {
    const issues = documentValidityIssues(item([document(type, data)], draft), { now: asOf });
    assert.ok(issues.some((issue) => issue.code === 'expired'
      && issue.message.endsWith('is expired, please update recent')), type);
  }
});

test('unreadable expiry and OCR not completed cannot be treated as current', () => {
  assert.ok(documentValidityIssues(item([document('natural_identity', { expiry_date: 'Not Found' })]),
    { now: asOf }).some((issue) => issue.code === 'expiry_unreadable'));
  const pending = { document_id: 'id', type: 'natural_identity', extraction_state: 'queued' };
  assert.ok(documentValidityIssues(item([pending]), { now: asOf }).some((issue) => issue.code === 'ocr_incomplete'));
});

test('replacing an expired document supersedes it and non-expiring proof is allowed', () => {
  const docs = [document('natural_identity', { expiry_date: '2020-01-01' }, 'old'),
    document('natural_identity', { identity_type: 'Passport', full_name_english: 'Example Person',
      document_number: 'P123', expiry_date: '2027-01-01' }, 'new'),
    document('premises_evidence', { evidence_type: 'Title deed', address: 'Dubai', expiry_date: 'Not Found' })];
  assert.deepEqual(documentValidityIssues(item(docs, { address_proof_type: 'Title deed',
    natural_id_expiry: '2027-01-01' }), { now: asOf }), []);
});

test('bank letter freshness, stated expiry and document-to-field mismatch are checked separately', () => {
  const issues = documentValidityIssues(item([
    document('bank_letter', { issue_date: '2026-10-01', expiry_date: 'Not Found' }),
    document('identity_document', { expiry_date: '2027-01-01' })
  ], { representative_id_expiry: '2028-01-01' }), { now: asOf });
  assert.ok(issues.some((issue) => issue.code === 'bank_letter_not_recent'));
  assert.ok(issues.some((issue) => issue.code === 'expiry_mismatch'));
});

test('bank letter recency is measured at supplier submission, not a later buyer review', () => {
  const record = item([document('bank_letter', { account_holder: 'Example LLC', bank_name: 'Bank',
    letterhead_bank_name: 'Bank', iban: 'AE123', issue_date: '2026-11-01', expiry_date: 'Not Found' })]);
  record.submitted_at = '2026-11-20T10:00:00Z';
  assert.deepEqual(documentValidityIssues(record, { now: new Date('2027-01-01T10:00:00Z') }), []);
});

test('address proof must yield the selected type and readable address', () => {
  const issues = documentValidityIssues(item([document('premises_evidence', {
    evidence_type: 'Utility bill', address: 'Not Found', expiry_date: 'Not Found'
  })], { address_proof_type: 'Title deed' }), { now: asOf });
  assert.ok(issues.some((issue) => issue.code === 'address_unreadable'));
  assert.ok(issues.some((issue) => issue.code === 'address_proof_type_mismatch'));
});

test('source-generated Ejari certificate is retained without a second OCR requirement', () => {
  const docs = [document('ejari', { status: 'verified', fields: { end_date: '2027-01-01' } }),
    { document_id: 'certificate', type: 'ejari_certificate', scan_result: 'source_generated',
      extraction_state: 'not_applicable' }];
  assert.deepEqual(documentValidityIssues(item(docs, { address_proof_type: 'Ejari' }), { now: asOf }), []);
});

test('any printed address-proof expiry is checked even when a lease end is also present', () => {
  const docs = [document('premises_evidence', { evidence_type: 'Tenancy or lease', address: 'Dubai',
    period_end_date: '2027-01-01', expiry_date: '2026-01-01' })];
  const issues = documentValidityIssues(item(docs, { address_proof_type: 'Tenancy or lease' }), { now: asOf });
  assert.ok(issues.some((issue) => issue.code === 'expired'));
  assert.ok(issues.some((issue) => issue.code === 'validity_date_mismatch'));
});
