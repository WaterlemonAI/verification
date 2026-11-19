import test from 'node:test';
import assert from 'node:assert/strict';
import { triangulateCase } from '../lib/flows/triangulation.mjs';

test('bank letter issue date and visible letterhead are review evidence', () => {
  for (const [issueDate, expected] of [
    ['2026-10-19', 'match'], ['2026-10-18', 'mismatch'], ['2026-11-20', 'mismatch'], ['Not Found', 'unavailable']
  ]) {
    const result = triangulateCase({ draft: { business_name: 'Example LLC' }, submitted_at: '2026-11-19T12:00:00Z',
      documents: [{ document_id: 'bank-1', type: 'bank_letter', extraction_result: { data: {
        business_name: 'Example LLC', account_holder: 'Example LLC', bank_name: 'Example Bank',
        letterhead_bank_name: 'Example Bank', branch_name: 'Main', issue_date: issueDate } } }] });
    assert.equal(result.comparisons.find((entry) => entry.rule === 'bank_letter_freshness').outcome, expected);
    assert.equal(result.comparisons.find((entry) => entry.rule === 'bank_letterhead_name').outcome, 'match');
    assert.equal(result.facts.find((entry) => entry.field_path === 'bank_letter.branch_name').value, 'Main');
  }
});

test('trade licence OCR, TLV result, premises and bank statement are compared by source', () => {
  const result = triangulateCase({ draft: { business_name: 'Example LLC', licence_expiry: '2027-01-01' },
    checks: [{ check_id: 'tlv-check', service_id: 'uae-trade-licence', raw_response: { status: 'Success',
      uae_tl_verification: { licence_registration_name: 'Example LLC', uae_licence_number: '123',
        legal_type_from_entity: 'Limited Liability Company', license_status: 'Active', licence_registration_address: 'Dubai UAE',
        business_manager: { name: 'Sam Manager' },
        expiration_date: '2027-01-01' } } }], documents: [
      { document_id: 'licence', type: 'trade_licence', extraction_result: { data: {
        company_name_english: 'Example LLC', license_number: '123', company_type: 'LLC', license_status: 'Current',
        address: 'Dubai UAE', expiry_date: '2027-01-01', business_manager_names: 'Sam Manager' } } },
      { document_id: 'premises', type: 'premises_evidence', extraction_result: { data: {
        evidence_type: 'Utility bill', address: 'Dubai UAE', tenant_name: 'Example LLC' } } },
      { document_id: 'letter', type: 'bank_letter', extraction_result: { data: {
        account_holder: 'Example LLC', bank_name: 'Example Bank', iban: 'AE123', bank_country: 'AE',
        account_number: '00123', branch_name: 'Main Dubai' } } },
      { document_id: 'statement', type: 'bank_statement', extraction_result: { data: {
        account_holder: 'Example LLC', bank_name: 'Example Bank', iban: 'AE123', bank_country: 'AE',
        account_number: '00123', branch_name: 'Main Dubai' } } }
    ] });
  for (const rule of ['licence_tlv_name', 'licence_tlv_number', 'licence_tlv_company_type', 'licence_tlv_status',
    'licence_tlv_address', 'licence_tlv_business_manager', 'licence_tlv_expiry', 'licence_premises_address',
    'bank_statement_account_holder', 'bank_statement_bank_name', 'bank_statement_iban',
    'bank_statement_account_number', 'bank_statement_branch'])
    assert.equal(result.comparisons.find((entry) => entry.rule === rule).outcome, 'match', rule);
  assert.equal(result.facts.find((fact) => fact.field_path === 'tlv.company_type').extraction_method, 'verification_api');
});

test('printed owner shareholding is compared with the verification result', () => {
  const result = triangulateCase({ draft: { business_name: 'Example LLC' }, documents: [
    { document_id: 'licence', type: 'trade_licence', extraction_result: { data: {
      owner_details: 'Amina Owner | Shareholder | 60%' } } }
  ], checks: [{ check_id: 'tlv', service_id: 'uae-trade-licence', raw_response: {
    uae_tl_verification: { directors_business_owners: [{ name: 'Amina Owner', shareholding_percent: '70%' }] }
  } }] });
  assert.equal(result.comparisons.find((entry) => entry.rule === 'owner_shareholding_tlv').outcome, 'mismatch');
});
