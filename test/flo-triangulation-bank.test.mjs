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
