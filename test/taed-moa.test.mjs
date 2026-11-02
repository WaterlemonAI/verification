import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moaDataFromTaed } from '../lib/taed-moa.mjs';

test('MOA wrapper maps the documented TAED response and keeps phone compatibility', () => {
  const payload = { data: {
    'Company Name': 'Example LLC', 'Registration Number': '6973268',
    'Business Objectives': 'Coffee Shop, Cafeteria', 'Authorized Capital': 'DHS 100000',
    'Date of Incorporation': '17/08/2022',
    shareholders: JSON.stringify([{ name: 'Sample Person', 'id number': 'TEST123', nationality: 'India',
      '% share': '100%', '# of shares': '100', 'date of joining': '17/08/2022',
      'date of removal': null, 'current status': 'Active Shareholder' }])
  }, metadata: { fileName: 'private.pdf', model: 'hidden' } };
  assert.deepEqual(moaDataFromTaed(payload), {
    company_name: 'Example LLC', registration_number: '6973268',
    business_objectives: ['Coffee Shop', 'Cafeteria'], authorized_capital: 'DHS 100000',
    date_of_incorporation: '17/08/2022', shareholders: [{
      name: 'Sample Person', id_number: 'TEST123', nationality: 'India',
      shareholding_percent: '100%', number_of_shares: '100', date_of_joining: '17/08/2022',
      date_of_removal: 'Not Found', current_status: 'Active Shareholder', phone_number: 'Not Found'
    }]
  });
});

test('MOA wrapper rejects malformed shareholder JSON and unknown statuses', () => {
  assert.throws(() => moaDataFromTaed({ data: {} }), /document_ocr_taed_moa_invalid/);
  assert.throws(() => moaDataFromTaed({ data: { shareholders: 'not JSON' } }), /document_ocr_taed_moa_invalid/);
  assert.throws(() => moaDataFromTaed({ data: { shareholders: [{ 'current status': 'Invented' }] } }),
    /document_ocr_taed_moa_invalid/);
});
