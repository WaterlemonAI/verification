import test from 'node:test';
import assert from 'node:assert/strict';
import { buyerCase, customerCase, supplierCase } from '../lib/flows/projections.mjs';

test('supplier projection excludes raw screening, buyer events, callback state and secrets', () => {
  const item = {
    application_id: '11111111-1111-4111-8111-111111111111', workspace_id: '1234567890abcdef',
    flow_id: 'kys-v1', template_version: '1.0.0', status: 'pending_review',
    draft: { business_name: 'Example LLC' },
    documents: [{ document_id: 'doc', type: 'formation_document', size: 10,
      extraction_result: { data: { company_name: 'Example LLC', raw_response: 'PRIVATE_OCR',
        shareholders: [{ name: 'Alice', shareholding_percent: 40, private_note: 'PRIVATE_NOTE' }] } } }],
    checks: [{ service_id: 'entity-adverse-media', raw_response: { secret: 'PRIVATE_ADVERSE' } }],
    events: [{ type: 'buyer_decision', rationale: 'PRIVATE_DECISION' }],
    gemini_review: { output: { narrative: 'PRIVATE_GEMINI' } },
    link_hash: 'PRIVATE_LINK', session_hash: 'PRIVATE_SESSION', callback_secret: 'PRIVATE_CALLBACK',
    configuration: { brand_name: 'Buyer', callback_url: 'https://private.example/callback' },
    comparisons: [{ rule: 'name', outcome: 'mismatch', reason: 'different', left_fact_id: 'PRIVATE_FACT' }]
  };
  const supplier = supplierCase(item);
  const serialized = JSON.stringify(supplier);
  for (const privateValue of ['PRIVATE_OCR', 'PRIVATE_NOTE', 'PRIVATE_ADVERSE', 'PRIVATE_DECISION',
    'PRIVATE_GEMINI', 'PRIVATE_LINK', 'PRIVATE_SESSION', 'PRIVATE_CALLBACK', 'PRIVATE_FACT', 'private.example'])
    assert.ok(!serialized.includes(privateValue), privateValue);
  assert.equal(supplier.documents[0].extraction_result.data.shareholders[0].name, 'Alice');
  assert.equal(buyerCase(item).checks[0].raw_response.secret, 'PRIVATE_ADVERSE');
  assert.equal(customerCase(item).checks[0].raw_response.secret, 'PRIVATE_ADVERSE');
  assert.equal(customerCase(item).callback_secret, undefined);
});

test('buyer review requirements follow each flow and conditional supplier answers', () => {
  const supplier = buyerCase({ flow_id: 'supplier-onboarding-v1', draft: {
    supplierType: 'legal_entity', authorityBasis: 'power_of_attorney', vatRegistered: 'yes',
    registeredAddressSame: 'no', supplyType: 'goods' } });
  assert.ok(supplier.review_requirements.documents.includes('tradeLicenceFile'));
  assert.ok(supplier.review_requirements.documents.includes('poaFile'));
  assert.ok(supplier.review_requirements.documents.includes('vatFile'));
  assert.ok(supplier.review_requirements.text.includes('operatingAddress'));
  assert.ok(supplier.review_requirements.text.includes('goodsOrigin'));
  const classic = buyerCase({ flow_id: 'kys-v1', draft: {} });
  assert.deepEqual(classic.review_requirements.documents,
    ['trade_licence', 'formation_document', 'bank_letter']);
  assert.ok(!classic.review_requirements.documents.includes('tradeLicenceFile'));
});

test('buyer and customer JSON expose AI7EDD branding while retaining source evidence', () => {
  const item = { flow_id: 'kys-v1', draft: { business_name: 'Gemini Trading LLC' },
    documents: [{ type: 'bank_letter', extraction_result: { status: 'failed',
      model_id: 'gemini-3.5-flash-lite', reason_codes: ['gemini_unconfigured'],
      data: { business_name: 'Gemini Trading LLC' } } }],
    checks: [{ service_id: 'entity-adverse-media', raw_response: { company: 'Gemini Trading LLC',
      model_id: 'gemini-3.5-flash-lite', provider_calls: { gemini: 1 } } }],
    gemini_review: { status: 'failed', model_id: 'gemini-3.5-flash-lite',
      validation_errors: ['flo_gemini_http_error'], output: { narrative: 'Gemini review incomplete' } },
    events: [{ type: 'review_ready', payload: { gemini_review: { status: 'not_run',
      reason_codes: ['gemini_unconfigured'] }, diagnostic: { rationale: 'Gemini extraction failed' } } }],
    diagnostic: { rationale: 'Gemini extraction failed' } };
  for (const visible of [buyerCase(item), customerCase(item)]) {
    assert.equal(visible.gemini_review, undefined);
    assert.equal(visible.ai7edd_review.model_id, 'AI7EDD');
    assert.deepEqual(visible.ai7edd_review.validation_errors, ['flo_ai7edd_http_error']);
    assert.equal(visible.documents[0].extraction_result.model_id, 'AI7EDD');
    assert.deepEqual(visible.documents[0].extraction_result.reason_codes, ['ai7edd_unconfigured']);
    assert.equal(visible.events[0].payload.ai7edd_review.status, 'not_run');
    assert.equal(visible.events[0].payload.diagnostic.rationale, 'AI7EDD extraction failed');
    assert.equal(visible.diagnostic.rationale, 'AI7EDD extraction failed');
    assert.doesNotMatch(JSON.stringify(visible.ai7edd_review), /gemini/i);
    assert.equal(visible.checks[0].raw_response.company, 'Gemini Trading LLC');
    assert.equal(visible.checks[0].raw_response.model_id, 'AI7EDD');
    assert.deepEqual(visible.checks[0].raw_response.provider_calls, { ai7edd: 1 });
    assert.equal(visible.draft.business_name, 'Gemini Trading LLC');
  }
});
