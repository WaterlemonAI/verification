import test from 'node:test';
import assert from 'node:assert/strict';
import { caseOutcome } from '../lib/case-manager-outcomes.mjs';
import { CASE_DIRECT_SERVICES } from '../lib/case-manager-contract.mjs';
import { caseRequestStatus } from '../lib/case-manager-contract.mjs';

test('HTTP request status is separate from the service outcome', () => {
  assert.equal(caseRequestStatus(200), 'succeeded');
  assert.equal(caseRequestStatus(202), 'succeeded');
  assert.equal(caseRequestStatus(422), 'failed');
  assert.equal(caseRequestStatus(503), 'failed');
  assert.equal(caseRequestStatus(0), 'pending');
  assert.equal(caseRequestStatus(302), 'other');
  assert.equal(caseOutcome('future-integration', { verified: false }, { httpStatus: 200 }).outcome, 'unclassified');
});

test('HTTP success is not business success, partial results require review', () => {
  assert.equal(caseOutcome('future-integration', { status: 'ok' }, { httpStatus: 200 }).outcome, 'unclassified');
  assert.equal(caseOutcome('adverse-media', { status: 'partial', coverage: { complete: false },
    summary: { outcome: 'safe', decision_eligible: false } }, { httpStatus: 200 }).outcome, 'review_required');
  assert.equal(caseOutcome('merchant-screening', { status: 'partial', summary: {
    risk_level: 'safe', decision_eligible: false } }, { httpStatus: 200 }).outcome, 'review_required');
  assert.equal(caseOutcome('adverse-media', { status: 'completed', coverage: { complete: true },
    summary: { outcome: 'no_material_results', decision_eligible: true, human_review_required: false } }, { httpStatus: 200 }).outcome, 'passed');
  assert.equal(caseOutcome('adverse-media', {}, { httpStatus: 202 }).outcome, 'pending');
  assert.equal(caseOutcome('future-integration', 'plain supplier error', { httpStatus: 200 }).outcome, 'unclassified');
});

test('OCR extraction and BSA analysis do not imply identity or credit approval', () => {
  assert.equal(caseOutcome('passport-icao-ocr', { status: 'completed', data: {} }, { httpStatus: 200 }).outcome, 'extracted');
  assert.equal(caseOutcome('passport-icao-ocr', { status: 'review_required' }, { httpStatus: 200 }).outcome, 'review_required');
  assert.equal(caseOutcome('bank-statement-analysis', { status: 'completed', decisionEligible: false }, { httpStatus: 200 }).outcome, 'analyzed');
  assert.equal(caseOutcome('bank-statement-analysis', { status: 'partial', decisionEligible: false }, { httpStatus: 200 }).outcome, 'review_required');
  assert.equal(caseOutcome('future-integration', { error: 'unavailable' }, { httpStatus: 503 }).outcome, 'could_not_complete');
});

test('every direct service has a conservative synthetic result path', () => {
  for (const service of CASE_DIRECT_SERVICES) {
    const outcome = caseOutcome(service.service, { status: 'completed', data: { synthetic: true } }, { httpStatus: 200 });
    assert.notEqual(outcome.outcome, 'passed', `${service.service} must not pass from HTTP 200 alone`);
    assert.ok(['extracted', 'analyzed', 'review_required', 'unclassified'].includes(outcome.outcome));
  }
});

test('trade licence requires explicit active registration; negative and conflicting states do not pass', () => {
  const licence = { uae_licence_number: 'SYN-123', licence_registration_name: 'Synthetic Trading LLC',
    license_status: 'Active', expiration_date: '2099-01-01', moec_status: 'Active' };
  const response = { status: 'Success', uae_tl_verification: licence };
  assert.deepEqual(caseOutcome('uae-tlv', response, { httpStatus: 200 }),
    { outcome: 'passed', reasonCodes: ['LICENCE_ACTIVE'] });
  assert.equal(caseOutcome('uae-tlv', { ...response, uae_tl_verification: { ...licence, license_status: 'Expired' } },
    { httpStatus: 200 }).outcome, 'failed');
  assert.equal(caseOutcome('uae-tlv', { ...response, uae_tl_verification: { ...licence, moec_status: 'Suspended' } },
    { httpStatus: 200 }).outcome, 'review_required');
  assert.equal(caseOutcome('uae-tlv', { ...response, uae_tl_verification: { ...licence, expiration_date: '2020-01-01' } },
    { httpStatus: 200 }).outcome, 'review_required');
  assert.equal(caseOutcome('uae-tlv', { status: 'Success', trade_licence_verification_api: { uae_licence_number: 'SYN-123' } },
    { httpStatus: 200 }).outcome, 'review_required');
});

test('IBAN full owner and account match passes, explicit mismatch fails, ambiguity needs review', () => {
  const checks = { result: 'Full Bank and Account Owner Match', completeName: 'MATCH',
    bankAccountNumber: 'MATCH', bankCode: 'MATCH', bank: 'MATCH' };
  const response = { status: 1, msg: 'success', data: { results: checks } };
  assert.deepEqual(caseOutcome('iban-verification', response, { httpStatus: 200 }),
    { outcome: 'passed', reasonCodes: ['IBAN_FULL_OWNER_ACCOUNT_MATCH'] });
  assert.equal(caseOutcome('iban-verification', { ...response, data: { results: { ...checks, completeName: 'MISMATCH' } } },
    { httpStatus: 200 }).outcome, 'failed');
  assert.equal(caseOutcome('iban-verification', { ...response, data: { results: { ...checks, result: 'Partial Match' } } },
    { httpStatus: 200 }).outcome, 'review_required');
  assert.equal(caseOutcome('iban-verification', { ...response, data: { results: { ...checks, completeName: '' } } },
    { httpStatus: 200 }).outcome, 'review_required');
});

test('entity search passes only completed no-candidate checks; hits and incomplete coverage need review', () => {
  const clear = { message: 'Search Successful', profiles_success: true, apc_success: true,
    data: { profiles: [], aml: [], russiabridge: [], apc: [] } };
  assert.deepEqual(caseOutcome('entity-search', clear, { httpStatus: 200 }),
    { outcome: 'passed', reasonCodes: ['ENTITY_SEARCH_NO_CANDIDATES'] });
  assert.equal(caseOutcome('entity-search', { ...clear, data: { ...clear.data, profiles: [{ uid: 'candidate' }] } },
    { httpStatus: 200 }).outcome, 'review_required');
  assert.equal(caseOutcome('entity-search', { ...clear, profiles_success: false },
    { httpStatus: 200 }).outcome, 'review_required');
  assert.equal(caseOutcome('entity-search', { ...clear, data: { profiles: [], unknown_dataset: [] } },
    { httpStatus: 200 }).outcome, 'review_required');
});

test('Form result rolls up only explicit child decisions, not transport success alone', () => {
  const child = (service_id, response) => ({ service_id, response, http_status: 200,
    transport: { completed: true }, coverage: { complete: true }, eligibility: { decision_eligible: true } });
  const licence = child('uae-tlv', { status: 'Success', uae_tl_verification: {
    uae_licence_number: 'SYN-123', licence_registration_name: 'Synthetic Trading LLC',
    license_status: 'Active', expiration_date: '2099-01-01' } });
  const iban = child('iban-verification', { status: 1, data: { results: {
    result: 'Full Bank and Account Owner Match', completeName: 'MATCH', bankAccountNumber: 'MATCH' } } });
  const form = { status: 'completed', summary: { decision_eligible: true, total: 2 }, services: [licence, iban] };
  assert.equal(caseOutcome('forms', form, { httpStatus: 200 }).outcome, 'passed');
  const mismatch = child('iban-verification', { status: 1, data: { results: {
    result: 'No Match', completeName: 'MISMATCH', bankAccountNumber: 'MATCH' } } });
  assert.equal(caseOutcome('forms', { ...form, services: [licence, mismatch] }, { httpStatus: 200 }).outcome, 'failed');
  const dynamic = child('future-integration', { status: 'ok' });
  assert.equal(caseOutcome('forms', { ...form, services: [licence, dynamic] }, { httpStatus: 200 }).outcome, 'review_required');
  assert.equal(caseOutcome('forms', { ...form, summary: { decision_eligible: false, total: 2 } },
    { httpStatus: 200 }).outcome, 'review_required');
});
