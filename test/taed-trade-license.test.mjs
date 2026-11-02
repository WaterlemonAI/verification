import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tradeLicenseDataFromTaed } from '../lib/taed-trade-license.mjs';

test('Trade License wrapper turns TAED labeled text into separate owner and manager rows', () => {
  const payload = { data: {
    'Issuing Authority': 'GOVERNMENT OF EXAMPLE', 'License Number': 'TEST-123',
    'Company Name (English)': 'SAMPLE TRADING LLC', 'Company Name (Arabic)': null,
    'Formation Number': 'TEST-456', Address: 'Synthetic address',
    'Issue Date': '15/10/2020', 'Expiry Date': '14/10/2026',
    Managers: 'ALICE EXAMPLE, BOB EXAMPLE',
    'Business Activity': 'Handbags & Leather Products Trading, Diamonds, Pearls, & Precious Stones Trading',
    'Directors/Business Owner': 'Name: Alice Example, Nationality: Exampleland, ID Number: TEST1, Phone Number: Null, email: Null, Shareholding Percentage: 60% | Name: Bob Example, Nationality: Exampleland, ID Number: TEST2, Phone Number: Null, email: Null, Shareholding Percentage: 40%',
    'Business Manager': 'Name: Alice Example, Nationality: Exampleland, ID Number: TEST1, Phone Number: Null, email: Null | Name: Bob Example, Nationality: Exampleland, ID Number: TEST2, Phone Number: Null, email: Null',
    Emirates: 'dubai', 'Authorizing Authority': 'dubai_department_of_economy_and_tourism',
    'Parent Entity': null, 'Sanction Country': null
  }, metadata: { fileName: 'private.pdf', model: 'hidden' } };
  const data = tradeLicenseDataFromTaed(payload);
  assert.deepEqual(data.managers, ['ALICE EXAMPLE', 'BOB EXAMPLE']);
  assert.deepEqual(data.business_activity, [payload.data['Business Activity']]);
  assert.deepEqual(data.directors_business_owners, [
    { name: 'Alice Example', nationality: 'Exampleland', id_number: 'TEST1', phone_number: 'Not Found',
      email: 'Not Found', shareholding_percent: '60%' },
    { name: 'Bob Example', nationality: 'Exampleland', id_number: 'TEST2', phone_number: 'Not Found',
      email: 'Not Found', shareholding_percent: '40%' }
  ]);
  assert.equal(data.business_managers.length, 2);
  assert.equal(data.business_managers[0].name, 'Alice Example');
  assert.equal(data.company_type, 'Not Found');
  assert.equal(data.company_name_arabic, 'Not Found');
  assert.equal(data.parent_entity, 'Not Found');
  assert.equal(data.sanction_country, 'Not Found');
  assert.equal(data.emirates, 'dubai');
  assert.equal(data.authorizing_authority, 'dubai_department_of_economy_and_tourism');
  assert.equal(data.metadata, undefined);
});

test('Trade License wrapper preserves entity rows and the TAED sanction field as data', () => {
  const data = tradeLicenseDataFromTaed({ data: {
    'License Number': 'TEST-123',
    'Parent Entity': '[{"Name":"Parent Example LLC","Shareholding Percentage":"75%"}]',
    'Sanction Country': 'EDD Requird'
  } });
  assert.deepEqual(data.parent_entity, [{ name: 'Parent Example LLC', shareholding_percent: '75%' }]);
  assert.equal(data.sanction_country, 'EDD Requird');
  assert.deepEqual(tradeLicenseDataFromTaed({ data: { 'License Number': 'TEST-123',
    'Parent Entity': 'Name: Parent One LLC, Shareholding Percentage: 75% | Name: Parent Two LLC, Shareholding Percentage: 25%'
  } }).parent_entity, [
    { name: 'Parent One LLC', shareholding_percent: '75%' },
    { name: 'Parent Two LLC', shareholding_percent: '25%' }
  ]);
  assert.throws(() => tradeLicenseDataFromTaed({ data: {} }), /document_ocr_taed_trade_license_invalid/);
});
