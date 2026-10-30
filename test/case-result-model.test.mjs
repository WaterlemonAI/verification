import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCasePresentation, serviceName } from '../api-site/case-result-model.mjs';

test('screening view shows evidence and incomplete coverage without inventing clearance', () => {
  const view = buildCasePresentation({ service_id: 'adverse-media', outcome: 'review_required' }, {
    entity: { name: 'Example Person' },
    summary: { risk_level: 'review', decision_eligible: false, statement: 'Review one result.' },
    coverage: { complete: false, sources: [{ source: 'current_news', status: 'unavailable' }] },
    results: [{ title: 'Investigation report', publisher: 'Example News', url: 'https://example.test/story', excerpt: 'Investigation only.' }]
  });
  assert.deepEqual(view.metrics.find((value) => value.label === 'Decision eligible'), { label: 'Decision eligible', value: 'No' });
  assert.equal(view.sections.find((section) => section.title === 'Public evidence').items[0].title, 'Investigation report');
  assert.equal(view.sections.find((section) => section.title === 'Source coverage').items[0].meta, 'unavailable');
  assert.equal(JSON.stringify(view).includes('Passed'), false);
});

test('OCR view expands nested extracted values and labels them as extraction', () => {
  const view = buildCasePresentation({ service_id: 'emirates-id-ocr' }, {
    status: 'completed', data: { full_name: 'Example Person', details: { id_number: '784000000000000' },
      directors: ['Person A', 'Person B'] }, review_flags: ['low_confidence_photo']
  });
  const rows = view.sections.find((section) => section.title === 'Extracted information').fields;
  assert.deepEqual(rows.find((row) => row.label === 'Details · ID number'),
    { label: 'Details · ID number', value: '784000000000000' });
  assert.equal(rows.find((row) => row.label === 'Directors').value, 'Person A, Person B');
  assert.match(view.note, /human verification/);
});

test('Forms view distinguishes each check from overall eligibility', () => {
  const view = buildCasePresentation({ service_id: 'forms' }, {
    status: 'completed', summary: { decision_eligible: false }, services: [{
      service_id: 'merchant-screening', transport: { status: 'completed' },
      coverage: { status: 'incomplete' }, eligibility: { status: 'ineligible', reason_codes: ['incomplete_coverage'] },
      response: { summary: { risk_level: 'safe', decision_eligible: false } }
    }]
  });
  const check = view.sections.find((section) => section.title === 'Selected checks').items[0];
  assert.match(check.meta, /incomplete/);
  assert.deepEqual(check.fields.find((field) => field.label === 'Decision eligible'),
    { label: 'Decision eligible', value: 'No' });
  assert.equal(serviceName('bank-statement-analysis'), 'Bank statement analysis');
});

test('unknown service retains a bounded overview and leaves the full response to JSON', () => {
  const response = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field_${index}`, index]));
  const view = buildCasePresentation({ service_id: 'new-integration' }, response);
  assert.equal(view.sections[0].fields.length, 24);
  assert.match(view.note, /Final response JSON/);
});
