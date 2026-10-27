import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DOCUMENT_OCR_APIS, DOCUMENT_OCR_BY_ID, documentOcrPublicCatalog, geminiExtractionSchema } from '../lib/document-ocr-contracts.mjs';

test('all eight document APIs have unique routes and closed extraction schemas', () => {
  assert.equal(DOCUMENT_OCR_APIS.length, 8);
  assert.equal(new Set(DOCUMENT_OCR_APIS.map((item) => item.id)).size, 8);
  assert.equal(new Set(DOCUMENT_OCR_APIS.map((item) => item.publicPath)).size, 8);
  for (const definition of DOCUMENT_OCR_APIS) {
    const schema = geminiExtractionSchema(definition);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.data.required, Object.keys(definition.fields));
    assert.equal(schema.properties.data.additionalProperties, false);
  }
  assert.equal(DOCUMENT_OCR_BY_ID.get('emirates-id-ocr').maxFiles, 2);
  assert.equal(DOCUMENT_OCR_BY_ID.get('passport-icao-ocr').fields.mrz_lines.type, 'array');
  const published = JSON.parse(readFileSync(new URL('../api-site/document-extraction-catalog.json', import.meta.url), 'utf8'));
  assert.deepEqual(published, documentOcrPublicCatalog());
});
