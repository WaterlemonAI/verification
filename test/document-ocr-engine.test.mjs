import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOCUMENT_OCR_BY_ID } from '../lib/document-ocr-contracts.mjs';
import { structureDocument, validateExtraction } from '../lib/document-ocr-engine.mjs';

const trade = DOCUMENT_OCR_BY_ID.get('uae-trade-license-ocr');
function candidate() {
  return { document_classification: 'trade_license',
    data: Object.fromEntries(Object.entries(trade.fields).map(([key, schema]) => [key, schema.type === 'array' ? [] : null])),
    evidence: [], figure_roles: [] };
}

test('a missing OCR citation forces review without inventing a field', () => {
  const result = candidate();
  result.data.license_number = 'TL-123';
  const checked = validateExtraction(trade, result, [{ page: 1, text: 'License Number TL-123' }]);
  assert.equal(checked.data.license_number, 'TL-123');
  assert.equal(checked.review_required, true);
  assert.deepEqual(checked.review_flags, ['EVIDENCE_NOT_FOUND:license_number',
    'IDENTIFYING_FIELDS_MISSING:company_name_english|company_name_arabic']);
  assert.throws(() => validateExtraction(trade, { ...result, data: { ...result.data, invented: 'x' } }, []), /invalid_extraction/);
});

test('structured extraction makes one bounded Gemini request and verifies page evidence', async () => {
  const result = candidate();
  result.data.license_number = 'TL-123';
  result.data.company_name_english = 'Example LLC';
  result.evidence = [{ field: 'license_number', page: 1, quote: 'License Number TL-123' },
    { field: 'company_name_english', page: 1, quote: 'Example LLC' }];
  let calls = 0;
  const fetched = async (url, options) => {
    calls += 1;
    assert.match(String(url), /generativelanguage\.googleapis\.com/);
    assert.equal(options.headers['x-goog-api-key'], 'test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.responseJsonSchema.properties.data.additionalProperties, false);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40 } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const output = await structureDocument({ definition: trade, pages: [{ page: 1, text: 'License Number TL-123 Example LLC' }],
    apiKey: 'test-key', fetchImpl: fetched });
  assert.equal(calls, 1);
  assert.equal(output.review_required, false);
  assert.equal(output.usage.input_tokens, 100);
});

test('POA period is explicit when absent and an invented period requires review', () => {
  const poa = DOCUMENT_OCR_BY_ID.get('uae-poa-ocr');
  const base = { document_classification: 'power_of_attorney',
    data: { ...Object.fromEntries(Object.entries(poa.fields).map(([key, schema]) => [key, schema.type === 'array' ? [] : null])),
      power_of_attorney: 'POA Determined' },
    evidence: [], figure_roles: [] };
  const noPeriod = validateExtraction(poa, base, [{ page: 1, text: 'Power of Attorney' }]);
  assert.equal(noPeriod.data.period, 'period not found');
  assert.equal(noPeriod.review_required, true);
  const invalid = validateExtraction(poa, { ...base, data: { ...base.data, period: 'From 31/02/2026 to 01/01/2027' } },
    [{ page: 1, text: 'From 31/02/2026 to 01/01/2027' }]);
  assert.ok(invalid.review_flags.includes('PERIOD_FORMAT_INVALID'));
});
