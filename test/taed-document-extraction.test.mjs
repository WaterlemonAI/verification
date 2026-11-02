import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractDocumentWithTaed, TAED_DOCUMENT_API_IDS } from '../lib/taed-document-extraction.mjs';

const sample = { apiId: TAED_DOCUMENT_API_IDS['moa-analysis'], bytes: Buffer.from('synthetic PDF'),
  mediaType: 'application/pdf', apiKey: 'synthetic-key' };

test('TAED adapter sends the documented multipart request without exposing the key in the body', async () => {
  const result = await extractDocumentWithTaed({ ...sample, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://www.taed.dev/api/v1/extract');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-API-Key'], 'synthetic-key');
    assert.equal(options.body.get('api_id'), sample.apiId);
    const file = options.body.get('file');
    assert.equal(file.name, 'document.pdf');
    assert.equal(file.type, 'application/pdf');
    assert.equal(await file.text(), 'synthetic PDF');
    assert.equal(options.body.get('api_key'), null);
    return new Response(JSON.stringify({ result: { company_name: 'Test LLC' } }), { status: 200 });
  } });
  assert.deepEqual(result, { result: { company_name: 'Test LLC' } });
});

test('TAED adapter rejects invalid input before making a paid call', async () => {
  let called = false;
  await assert.rejects(extractDocumentWithTaed({ ...sample, apiId: 'wrong',
    fetchImpl: async () => { called = true; } }), /document_ocr_taed_api_id_invalid/);
  await assert.rejects(extractDocumentWithTaed({ ...sample, bytes: Buffer.alloc(25 * 1024 * 1024 + 1),
    fetchImpl: async () => { called = true; } }), /document_ocr_file_limit/);
  assert.equal(called, false);
});

test('TAED adapter reduces HTTP and malformed response failures to safe codes', async () => {
  await assert.rejects(extractDocumentWithTaed({ ...sample,
    fetchImpl: async () => new Response('provider details', { status: 429 }) }), /document_ocr_taed_http_429/);
  await assert.rejects(extractDocumentWithTaed({ ...sample,
    fetchImpl: async () => new Response('not JSON', { status: 200 }) }), /document_ocr_taed_response_invalid/);
});

test('TAED adapter recognizes documented failures without leaking provider text', async () => {
  for (const [status, code] of [[500, 'EXTRACTION_PIPELINE_FAILURE'],
    [403, 'MODEL_COMPLIANCE_REFUSAL'], [422, 'SCHEMA_MISMATCH_EMPTY_OUTPUT'],
    [422, 'UNREADABLE_IMAGE_CONTENT']]) {
    await assert.rejects(extractDocumentWithTaed({ ...sample,
      fetchImpl: async () => new Response(JSON.stringify({ error: { code, message: 'private details' } }), { status }) }),
    new RegExp(`document_ocr_taed_${code.toLowerCase()}`));
  }
});

test('TAED adapter accepts WebP and bounds response bytes', async () => {
  await extractDocumentWithTaed({ ...sample, mediaType: 'image/webp',
    fetchImpl: async (_url, options) => {
      assert.equal(options.body.get('file').name, 'document.webp');
      return new Response('{}', { status: 200 });
    } });
  await assert.rejects(extractDocumentWithTaed({ ...sample,
    fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }) }),
  /document_ocr_taed_response_limit/);
});
