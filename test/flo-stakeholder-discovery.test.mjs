import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverGenericStakeholders, hasDocumentOwnerNames, verifiedManagerNames } from '../lib/flows/stakeholder-discovery.mjs';

test('manager aliases from licence verification and owner details remain distinct screening subjects', () => {
  const item = { application_id: 'case-1', draft: { supplier_type: 'Company or other Legal person',
    business_name: 'Example LLC' },
  documents: [{ document_id: 'licence', type: 'trade_licence', extraction_result: { data: {
    stakeholder_names: 'Not Found', owner_details: 'Amina Owner | Shareholder | 60%',
    business_manager_names: 'Sam Manager' } } }],
  checks: [{ check_id: 'tlv', service_id: 'uae-trade-licence', raw_response: { status: 'Success',
    trade_licence_verification_api: { businessManagerName: 'Sam Manager',
      directorsBusinessOwners: [{ name: 'Amina Owner', shareholding_percent: '60%' }] } } }] };
  assert.equal(hasDocumentOwnerNames(item), true);
  assert.deepEqual(verifiedManagerNames(item), ['Sam Manager']);
  const subjects = discoverGenericStakeholders(item);
  assert.equal(subjects.length, 2);
  const manager = subjects.find((person) => person.name === 'Sam Manager');
  const owner = subjects.find((person) => person.name === 'Amina Owner');
  assert.deepEqual(manager.source_ids, ['licence', 'tlv']);
  assert.ok(manager.roles.includes('verified business manager'));
  assert.equal(owner.shareholding_percent, '60%');
  assert.ok(!manager.roles.some((role) => /owner/i.test(role)));
});
