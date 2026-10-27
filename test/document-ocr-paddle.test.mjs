import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvironmentStore, KeyVaultStore } from '../lib/api-store.mjs';
import { DOCUMENT_OCR_APIS } from '../lib/document-ocr-contracts.mjs';
import { normalizePaddleResult } from '../lib/document-ocr-paddle.mjs';
import { processDocumentOcrJob } from '../lib/document-ocr-worker.mjs';

test('all eight settings default to Azure, persist independently, and stay out of the public catalog', async () => {
  const records = new Map();
  const store = Object.create(KeyVaultStore.prototype);
  store.getJson = async (name, fallback) => records.get(name)?.value || fallback;
  store.setSecret = async (name, value, tags) => { records.set(name, { value: JSON.parse(value), tags }); };
  for (const api of DOCUMENT_OCR_APIS) assert.equal(await store.getDocumentOcrEngine(api.id), 'azure');
  await store.setDocumentOcrEngine('cheque-ocr', 'paddle', 'admin@example.test');
  assert.equal(await store.getDocumentOcrEngine('cheque-ocr'), 'paddle');
  assert.equal(await store.getDocumentOcrEngine('emirates-id-ocr'), 'azure');
  assert.equal(records.get('document-ocr-engine-cheque-ocr').tags.previous, 'azure');
  assert.equal(records.get('document-ocr-engine-cheque-ocr').tags.actor, 'admin@example.test');
  await assert.rejects(store.setDocumentOcrEngine('unknown', 'paddle', 'admin@example.test'), /engine_invalid/);
  const local = new EnvironmentStore();
  await local.setDocumentOcrEngine('cheque-ocr', 'paddle', 'admin@example.test');
  const admin = await local.listIntegrations();
  const customer = await local.listIntegrations({ publicOnly: true });
  assert.equal(admin.find((item) => item.id === 'cheque-ocr').extractionEngine, 'paddle');
  assert.equal(customer.find((item) => item.id === 'cheque-ocr').extractionEngine, undefined);
});

test('Paddle pages keep Arabic, coordinates, order and multiple pages with bounded input', () => {
  const result = normalizePaddleResult({ pages: [
    { page: 1, lines: [{ text: 'شركة الإمارات', box: [10, 20, 300, 50] }] },
    { page: 2, lines: [{ text: 'Account: 123', box: [100, 200, 400, 250] }] }
  ] }, 2);
  assert.equal(result.pages.length, 2);
  assert.match(result.pages[0].text, /شركة الإمارات/);
  assert.equal(result.pages[1].text, 'Account: 123');
  assert.deepEqual(result.pages[1].lines[0].box, [100, 200, 400, 250]);
  assert.equal(result.verifiedMrz, null);
  assert.throws(() => normalizePaddleResult({ pages: [{ page: 2, lines: [] }] }, 1), /result_invalid/);
  assert.throws(() => normalizePaddleResult({ pages: [{ page: 1, lines: [{ text: 'x', box: [-1, 0, 1, 1] }] }] }, 1), /result_invalid/);
});

function workerStore(engine) {
  const row = { partitionKey: 'a'.repeat(64), rowKey: 'job_test', jobId: 'ocr_test',
    transactionId: 'synthetic', serviceId: 'cheque-ocr', status: 'queued', stage: 'queued',
    fileCount: 1, processedFiles: 0, azureCallCount: 0, paddleCallCount: 0,
    geminiCallCount: 0, extractionEngine: engine };
  let result;
  return { row, getRow: async () => row,
    getInputs: async () => ({ row, files: [{ bytes: Buffer.from('synthetic'), mediaType: 'image/png' }] }),
    transition: async (_row, stage, fields = {}) => Object.assign(row, { stage }, fields),
    saveOcr: async (_row, _pages, calls, count) => Object.assign(row, {
      stage: 'ocr_complete', processedFiles: count, [engine === 'paddle' ? 'paddleCallCount' : 'azureCallCount']: calls
    }),
    complete: async (_row, value) => { result = value; Object.assign(row, { status: value.status, stage: 'finished' }); },
    fail: async (_row, stage, reasonCode) => Object.assign(row, { status: 'failed', stage, reasonCode }),
    result: () => result };
}

test('job snapshot chooses one provider; replay cannot repeat OCR or Gemini', async () => {
  for (const engine of ['azure', 'paddle']) {
    const store = workerStore(engine);
    let azure = 0, paddle = 0, gemini = 0;
    const options = { store, partitionKey: store.row.partitionKey, jobId: store.row.jobId,
      getGeminiKey: async () => 'synthetic', scan: async () => {},
      analyze: async () => { azure++; return { pages: [{ page: 1, text: 'Cheque 123' }] }; },
      analyzePaddle: async () => { paddle++; return { pages: [{ page: 1, text: 'Cheque 123' }] }; },
      structure: async () => { gemini++; return { document_classification: 'cheque', data: {}, evidence: [],
        mrz: null, review_required: false, review_flags: [], model: 'synthetic' }; }
    };
    assert.equal((await processDocumentOcrJob(options)).status, 'completed');
    assert.equal((await processDocumentOcrJob(options)).status, 'completed');
    assert.deepEqual([azure, paddle, gemini], engine === 'azure' ? [1, 0, 1] : [0, 1, 1]);
    assert.deepEqual(Object.keys(store.result()).sort(), ['transaction_id', 'job_id', 'service_id', 'status',
      'processed_at', 'document_classification', 'data', 'evidence', 'mrz', 'review_required',
      'review_flags', 'artifacts', 'processing'].sort());
    assert.equal(store.result().processing.provider_calls.azure, azure);
  }
});

test('Paddle coordinates reach the shared structuring path', async () => {
  const store = workerStore('paddle');
  let seenPages;
  await processDocumentOcrJob({ store, partitionKey: store.row.partitionKey, jobId: store.row.jobId,
    getGeminiKey: async () => 'synthetic', scan: async () => {},
    analyzePaddle: async () => ({ pages: [{ page: 1, text: 'Cheque',
      lines: [{ text: 'Cheque', box: [10, 20, 300, 50] }] }] }),
    structure: async ({ pages }) => { seenPages = pages; return { document_classification: 'cheque',
      data: {}, evidence: [], mrz: null, review_required: false, review_flags: [], model: 'synthetic' }; } });
  assert.deepEqual(seenPages[0].lines, [{ text: 'Cheque', box: [10, 20, 300, 50] }]);
});

test('Paddle in-flight replay and malware rejection make no additional provider calls', async () => {
  const store = workerStore('paddle');
  store.row.stage = 'paddle_in_flight';
  store.row.timestamp = new Date(Date.now() - 20 * 60_000).toISOString();
  let calls = 0;
  const options = { store, partitionKey: store.row.partitionKey, jobId: store.row.jobId,
    getGeminiKey: async () => { calls++; return 'synthetic'; },
    analyzePaddle: async () => { calls++; return { pages: [] }; } };
  assert.equal((await processDocumentOcrJob(options)).status, 'failed');
  assert.equal(calls, 0);
  assert.equal(store.row.reasonCode, 'DOCUMENT_OCR_PROVIDER_OUTCOME_UNKNOWN');
  const malware = workerStore('paddle');
  assert.equal((await processDocumentOcrJob({ ...options, store: malware,
    scan: async () => { throw new Error('document_ocr_malware_detected'); } })).status, 'failed');
  assert.equal(calls, 0);
});

test('unreadable Paddle output fails before Gemini without changing the public failure code', async () => {
  const store = workerStore('paddle');
  let gemini = 0;
  const result = await processDocumentOcrJob({ store, partitionKey: store.row.partitionKey,
    jobId: store.row.jobId, scan: async () => {},
    analyzePaddle: async () => ({ pages: [{ page: 1, text: '' }] }),
    getGeminiKey: async () => { gemini++; return 'synthetic'; } });
  assert.equal(result.status, 'failed');
  assert.equal(store.row.reasonCode, 'DOCUMENT_OCR_TEXT_UNAVAILABLE');
  assert.equal(gemini, 0);
});
