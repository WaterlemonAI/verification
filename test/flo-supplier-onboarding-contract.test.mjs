import test from 'node:test';
import assert from 'node:assert/strict';
import { supplierRequirements, supplierSubmissionGaps, validateSupplierDraft } from '../lib/flows/templates/supplier-onboarding-v1/rules.mjs';

const base = {
  supplierType: 'legal_entity', representativeEmail: 'rep@example.com', representativePhone: '+971555550000',
  representativeTitle: 'Director', identityType: 'emirates_id', authorityBasis: 'board_resolution',
  ownershipComplete: 'yes', locationEvidenceType: 'ejari', registeredAddressSame: 'yes',
  siteActivities: 'Trading', addressChanges: '0', keyPersonChanges: '0', vatRegistered: 'yes',
  thirdPartyPayments: 'no', cashPayment: 'no', supplyType: 'goods', staffCount: '12',
  supplyDescription: 'Wholesale goods', unusualCapacity: 'no', goodsOrigin: 'UAE',
  goodsRights: 'own', intermediary: 'no', accuracyDeclaration: true, screeningConsent: true
};

test('supplier contract enforces legal-entity, authority, VAT and goods conditions server-side', () => {
  const draft = validateSupplierDraft(base);
  const required = supplierRequirements(draft);
  assert.ok(required.documents.includes('tradeLicenceFile'));
  assert.ok(required.documents.includes('brFile'));
  assert.ok(required.documents.includes('vatFile'));
  const item = { draft, documents: required.documents.map((type) => ({ type })) };
  assert.deepEqual(supplierSubmissionGaps(item), []);
  assert.ok(supplierSubmissionGaps({ ...item, documents: [] }).includes('tradeLicenceFile'));
  assert.ok(supplierSubmissionGaps({ ...item, draft: { ...draft, accuracyDeclaration: false } }).includes('accuracyDeclaration'));
  assert.ok(supplierSubmissionGaps({ ...item, draft: { ...draft, ownershipComplete: 'no' } }).includes('owners'));
});

test('natural-person branch and conditional answers are independent of the company document list', () => {
  const draft = validateSupplierDraft({ ...base, supplierType: 'natural_person', vatRegistered: 'no', vatReason: 'Below threshold',
    meetingAvailability: 'Weekdays', registeredAddressSame: 'no', operatingAddress: 'Dubai',
    addressChanges: '1', addressChangeExplanation: 'Moved office', thirdPartyPayments: 'yes',
    thirdPartyDetail: 'Parent pays', authorityBasis: '', ownershipComplete: '' });
  const required = supplierRequirements(draft);
  assert.ok(!required.documents.includes('tradeLicenceFile'));
  assert.ok(!required.documents.includes('vatFile'));
  for (const field of ['meetingAvailability', 'operatingAddress', 'addressChangeExplanation', 'thirdPartyDetail', 'vatReason'])
    assert.ok(required.text.includes(field));
  assert.throws(() => validateSupplierDraft({ supplierType: 'unknown' }));
  assert.throws(() => validateSupplierDraft({ hidden_provider_key: 'secret' }));
  assert.ok(supplierSubmissionGaps({ draft: { ...draft, controlledTest: true }, documents: [] }).includes('controlledTest'));
});
