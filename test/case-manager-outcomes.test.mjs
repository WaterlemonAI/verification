import test from 'node:test';
import assert from 'node:assert/strict';
import { caseOutcome } from '../lib/case-manager-outcomes.mjs';
import { CASE_DIRECT_SERVICES } from '../lib/case-manager-contract.mjs';

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
  assert.equal(caseOutcome('bank-statement-analysis', { status: 'completed', decisionEligible: true }, { httpStatus: 200 }).outcome, 'unclassified');
  assert.equal(caseOutcome('bank-statement-analysis', { status: 'partial', decisionEligible: false }, { httpStatus: 200 }).outcome, 'review_required');
  assert.equal(caseOutcome('future-integration', { error: 'unavailable' }, { httpStatus: 503 }).outcome, 'could_not_complete');
});

test('every direct service has a conservative synthetic result path', () => {
  for (const service of CASE_DIRECT_SERVICES) {
    const outcome = caseOutcome(service.service, { status: 'completed', data: { synthetic: true } }, { httpStatus: 200 });
    assert.notEqual(outcome.outcome, 'passed', `${service.service} must not pass from HTTP 200 alone`);
    assert.ok(outcome.outcome === 'extracted' || outcome.outcome === 'review_required' || outcome.outcome === 'unclassified');
  }
});
