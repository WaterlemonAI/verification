import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, validateFloConfig, validateLinkInput, submissionGaps } from '../lib/flows/contract.mjs';

test('Flo status transitions require buyer review', () => {
  assert.equal(canTransition('submitted', 'accepted'), false);
  assert.equal(canTransition('pending_review', 'accepted'), true);
  assert.equal(canTransition('accepted', 'in_progress'), false);
});

test('Flo configuration accepts only HTTPS public domain URLs', () => {
  assert.equal(validateFloConfig({ enabled: true, callback_url: 'https://buyer.example/callback' }).enabled, true);
  for (const url of ['http://buyer.example/x', 'https://127.0.0.1/x', 'https://localhost/x',
    'https://buyer.example/x#fragment', 'https://user:pass@buyer.example/x'])
    assert.throws(() => validateFloConfig({ enabled: true, callback_url: url }));
});

test('required fields and documents are explicit', () => {
  const input = validateLinkInput({ customer_reference: 'ORDER-1', supplier_email: 'SUPPLIER@example.com' });
  assert.equal(input.supplier_email, 'supplier@example.com');
  assert.deepEqual(submissionGaps({ draft: {}, documents: [] }), [
    'business_name', 'licence_number', 'company_type', 'activities', 'registered_address',
    'trade_licence', 'formation_document', 'bank_letter'
  ]);
});
