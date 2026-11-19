import test from 'node:test';
import assert from 'node:assert/strict';
import { criticalConsistencyIssues } from '../lib/flows/consistency.mjs';

const base = () => ({ workflow_schema: { document_policy: { ocr_required: true } },
  draft: { supplier_type: 'Company or other Legal person', registration_jurisdiction: 'United Arab Emirates' },
  comparisons: [], checks: [{ service_id: 'uae-trade-licence', coverage: 'complete', raw_response: {
    status: 'Success', uae_tl_verification: { license_status: 'Active', moec_status: 'Active',
      expiration_date: '2027-01-01' } } }] });

test('inactive TLV, expired API licence and material document contradictions block acceptance', () => {
  const item = base(); item.checks[0].raw_response.uae_tl_verification.license_status = 'Expired';
  item.comparisons = [{ rule: 'licence_tlv_company_type', outcome: 'mismatch' },
    { rule: 'licence_tlv_status', outcome: 'mismatch' },
    { rule: 'owner_shareholding_tlv', outcome: 'mismatch' },
    { rule: 'bank_statement_iban', outcome: 'mismatch' }];
  const codes = criticalConsistencyIssues(item, { now: new Date('2026-11-20T12:00:00Z') }).map((issue) => issue.code);
  assert.ok(codes.includes('tlv_inactive'));
  assert.ok(codes.includes('licence_tlv_company_type'));
  assert.ok(codes.includes('licence_tlv_status'));
  assert.ok(codes.includes('owner_shareholding_tlv'));
  assert.ok(codes.includes('bank_statement_iban'));
});

test('matching API evidence can pass the deterministic consistency gate', () => {
  assert.deepEqual(criticalConsistencyIssues(base(), { now: new Date('2026-11-20T12:00:00Z') }), []);
});
