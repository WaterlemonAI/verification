import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processDocumentOcrJob } from '../lib/document-ocr-worker.mjs';

function fakeStore(stage = 'queued', serviceId = 'cheque-ocr') {
  const state = { partitionKey: 'a'.repeat(64), rowKey: 'job_ocr_test', jobId: 'ocr_test',
    transactionId: 'synthetic-transaction', serviceId, status: 'queued',
    stage, fileCount: 1, processedFiles: 0, azureCallCount: 0, geminiCallCount: 0 };
  let ocr = { pages: [], figures: [], verifiedMrz: null };
  let result;
  const artifacts = new Map();
  return {
    state,
    getRow: async () => state,
    getInputs: async () => ({ row: state, files: [{ mediaType: 'image/png', bytes: Buffer.from('synthetic') }] }),
    transition: async (_row, nextStage, extra = {}) => Object.assign(state, { stage: nextStage }, extra),
    getOcr: async () => ocr,
    saveOcr: async (_row, pages, calls, processedFiles, figures = [], verifiedMrz = null) => {
      ocr = { pages, figures, verifiedMrz };
      return Object.assign(state, { stage: 'ocr_complete', azureCallCount: calls.azure,
        paddleCallCount: calls.paddleocr, processedFiles });
    },
    saveArtifact: async (_row, name, bytes) => artifacts.set(name, bytes),
    complete: async (_row, value) => { result = value; Object.assign(state, { status: value.status, stage: 'finished' }); },
    fail: async (_row, nextStage, reasonCode) => Object.assign(state, { status: 'failed', stage: nextStage, reasonCode }),
    result: () => result,
    artifact: (name) => artifacts.get(name)
  };
}

test('a completed OCR job never calls Azure or Gemini again', async () => {
  const store = fakeStore();
  let scans = 0;
  let azureCalls = 0;
  let geminiCalls = 0;
  const options = { store, partitionKey: store.state.partitionKey, jobId: store.state.jobId,
    getGeminiKey: async () => 'synthetic-key',
    scan: async () => { scans += 1; },
    analyze: async () => { azureCalls += 1; return { pages: [{ page: 1, text: 'Bank Example' }] }; },
    structure: async () => { geminiCalls += 1; return { data: {}, evidence: [], mrz: null,
      document_classification: 'cheque', review_required: false, review_flags: [], model: 'synthetic' }; }
  };
  assert.equal((await processDocumentOcrJob(options)).status, 'completed');
  assert.equal((await processDocumentOcrJob(options)).status, 'completed');
  assert.deepEqual([scans, azureCalls, geminiCalls], [1, 1, 1]);
  assert.equal(store.result().processing.provider_calls.gemini, 1);
});

test('Emirates ID saves only a tight crop from a high-confidence page region', async () => {
  const store = fakeStore('queued', 'emirates-id-ocr');
  const portrait = Buffer.from('synthetic-png');
  const options = { store, partitionKey: store.state.partitionKey, jobId: store.state.jobId,
    getGeminiKey: async () => 'synthetic-key', scan: async () => {},
    analyze: async (request) => {
      assert.equal(request.includeFigures, false);
      return { pages: [{ page: 1, text: 'ID 784-1234-1234567-1' }], figures: [] };
    },
    renderIdentity: async () => ({ figures: [{ id: '1.0', page: 1, sourceType: 'page',
      contentType: 'image/jpeg', bytes: Buffer.from('synthetic-jpeg') }], verifiedMrz: null }),
    structure: async ({ figures }) => ({ data: { emirates_id_number: '784123412345671' }, evidence: [], mrz: null,
      document_classification: 'emirates_id', figure_roles: [],
      image_regions: [{ id: figures[0].id, role: 'photo', confidence: 'high', x1: 100, y1: 100, x2: 250, y2: 400 }],
      review_required: false, review_flags: [], model: 'synthetic' }),
    cropIdentity: async (_image, box) => { assert.equal(box.x2, 250); return portrait; }
  };
  assert.equal((await processDocumentOcrJob(options)).status, 'completed');
  assert.deepEqual(store.artifact('photo'), portrait);
  assert.equal(store.artifact('signature'), undefined);
  assert.deepEqual(store.result().artifacts, [{ name: 'photo', content_type: 'image/png', page: 1 }]);
});

test('an ambiguous in-flight Gemini stage fails closed without another paid call', async () => {
  const store = fakeStore('gemini_in_flight');
  let calls = 0;
  const result = await processDocumentOcrJob({ store, partitionKey: store.state.partitionKey, jobId: store.state.jobId,
    getGeminiKey: async () => { calls += 1; return 'synthetic-key'; },
    analyze: async () => { calls += 1; }, structure: async () => { calls += 1; } });
  assert.equal(result.status, 'failed');
  assert.equal(store.state.reasonCode, 'DOCUMENT_OCR_PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(calls, 0);
});

test('a duplicate queue delivery leaves a recent paid call running', async () => {
  const store = fakeStore('azure_in_flight');
  store.state.timestamp = new Date().toISOString();
  let calls = 0;
  const result = await processDocumentOcrJob({ store, partitionKey: store.state.partitionKey, jobId: store.state.jobId,
    getGeminiKey: async () => { calls += 1; }, analyze: async () => { calls += 1; },
    structure: async () => { calls += 1; } });
  assert.equal(result.status, 'in_progress');
  assert.equal(store.state.status, 'queued');
  assert.equal(calls, 0);
});

test('malware gate failure makes no provider calls', async () => {
  const store = fakeStore();
  let calls = 0;
  const result = await processDocumentOcrJob({ store, partitionKey: store.state.partitionKey, jobId: store.state.jobId,
    getGeminiKey: async () => { calls += 1; return 'synthetic-key'; },
    scan: async () => { throw new Error('DOCUMENT_OCR_MALWARE_DETECTED'); },
    analyze: async () => { calls += 1; }, structure: async () => { calls += 1; } });
  assert.equal(result.status, 'failed');
  assert.equal(store.state.reasonCode, 'DOCUMENT_OCR_MALWARE_DETECTED');
  assert.equal(calls, 0);
});

test('PaddleOCR selection is snapshotted and never calls Azure on queue replay', async () => {
  const store = fakeStore();
  store.state.ocrEngine = 'paddleocr';
  let azureCalls = 0;
  let paddleCalls = 0;
  const options = { store, partitionKey: store.state.partitionKey, jobId: store.state.jobId,
    getGeminiKey: async () => 'synthetic-key', scan: async () => {},
    analyze: async () => { azureCalls += 1; throw new Error('azure_must_not_run'); },
    analyzePaddle: async () => { paddleCalls += 1; return { pages: [{ page: 1, text: 'Cheque number 42' }] }; },
    structure: async () => ({ data: {}, evidence: [], mrz: null,
      document_classification: 'cheque', review_required: false, review_flags: [], model: 'synthetic' }) };
  assert.equal((await processDocumentOcrJob(options)).status, 'completed');
  assert.equal((await processDocumentOcrJob(options)).status, 'completed');
  assert.deepEqual([azureCalls, paddleCalls], [0, 1]);
  assert.equal(store.result().processing.provider_calls.paddleocr, 1);
  assert.equal(store.result().processing.provider_calls.azure, 0);
});

test('ambiguous PaddleOCR attempt fails closed without a second extraction', async () => {
  const store = fakeStore('paddle_in_flight');
  store.state.ocrEngine = 'paddleocr';
  let calls = 0;
  const outcome = await processDocumentOcrJob({ store, partitionKey: store.state.partitionKey,
    jobId: store.state.jobId, getGeminiKey: async () => 'synthetic-key',
    analyzePaddle: async () => { calls += 1; } });
  assert.equal(outcome.status, 'failed');
  assert.equal(calls, 0);
  assert.equal(store.state.reasonCode, 'DOCUMENT_OCR_PROVIDER_OUTCOME_UNKNOWN');
});
