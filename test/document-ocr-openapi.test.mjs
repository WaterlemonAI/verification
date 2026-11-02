import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DOCUMENT_OCR_APIS } from '../lib/document-ocr-contracts.mjs';

const spec = JSON.parse(readFileSync(new URL('../api/document-ocr-openapi.json', import.meta.url)));
const main = JSON.parse(readFileSync(new URL('../api/openapi.json', import.meta.url)));

test('OpenAPI documents every OCR route and every structured output field', () => {
  for (const service of DOCUMENT_OCR_APIS) {
    const operation = spec.paths[service.publicPath]?.post;
    assert.ok(operation, `${service.id} POST is documented`);
    assert.deepEqual(operation.requestBody.content['multipart/form-data'].schema.required, ['file']);
    assert.equal(Boolean(operation.requestBody.content['multipart/form-data'].schema.properties.additional_file), service.maxFiles === 2);
    assert.ok(operation.parameters.some((parameter) => parameter.name === 'Idempotency-Key' && parameter.required));
    assert.ok(operation.responses['202']);
    const dataSchema = spec.components.schemas[`${service.id.replaceAll('-', '_')}_Data`];
    assert.deepEqual(Object.keys(dataSchema.properties), Object.keys(service.fields));
    assert.deepEqual(dataSchema.required, Object.keys(service.fields));
    assert.equal(main.paths[service.publicPath].$ref.startsWith('/document-extraction/openapi.json#/paths/'), true);
  }
  assert.ok(spec.paths['/service/{documentService}/jobs/{jobId}']?.get);
  assert.ok(spec.paths['/service/{documentService}/jobs/{jobId}/result']?.get);
  assert.ok(spec.paths['/service/emirates_id_ocr/jobs/{jobId}/artifacts/{artifactName}']?.get);
  assert.equal(JSON.stringify(spec).toLowerCase().includes('gemini'), false);
  assert.deepEqual(spec.components.schemas.DocumentOcrJob.properties.provider_calls.required,
    ['azure', 'ai7edd_model']);
});
