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
