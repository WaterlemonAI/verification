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
      return Object.assign(state, { stage: 'ocr_complete', azureCallCount: calls, processedFiles });
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

test('MOA jobs admitted to TAED use it after malware scan without Azure or Gemini', async () => {
  const store = fakeStore('queued', 'moa-analysis');
  store.state.pipeline = 'taed';
  let scanned = false;
  const outcome = await processDocumentOcrJob({ store, partitionKey: store.state.partitionKey,
    jobId: store.state.jobId,
    scan: async () => { scanned = true; },
    getTaedKey: async () => 'synthetic-taed-key',
    getGeminiKey: async () => { throw new Error('Gemini should not be called'); },
    analyze: async () => { throw new Error('Azure should not be called'); },
    taedExtract: async ({ apiId, apiKey }) => {
      assert.equal(scanned, true);
      assert.equal(apiId, '5070ccf6-a243-4e5e-8fb1-e5360ffb3ab0');
      assert.equal(apiKey, 'synthetic-taed-key');
      return { data: { 'Company Name': 'Example LLC',
        shareholders: '[{"name":"Sample Person","current status":"Active Shareholder"}]' },
      metadata: { fileName: 'private.pdf' } };
    } });
  assert.equal(outcome.status, 'completed');
  assert.equal(store.result().data.company_name, 'Example LLC');
  assert.equal(store.result().data.shareholders[0].phone_number, 'Not Found');
  assert.equal(store.result().processing, undefined);
  assert.equal(store.result().review_flags, undefined);
  assert.equal(store.result().metadata, undefined);
});

test('Trade License TAED job returns extracted rows without verification or model metadata', async () => {
  const store = fakeStore('queued', 'uae-trade-license-ocr');
  store.state.pipeline = 'taed';
  let scanned = false;
  const outcome = await processDocumentOcrJob({ store, partitionKey: store.state.partitionKey,
    jobId: store.state.jobId,
    scan: async () => { scanned = true; },
    getTaedKey: async () => 'synthetic-taed-key',
    getGeminiKey: async () => { throw new Error('Gemini should not be called'); },
    analyze: async () => { throw new Error('Azure should not be called'); },
    taedExtract: async ({ apiId }) => {
      assert.equal(scanned, true);
      assert.equal(apiId, '0e6e2e97-e185-4933-85d8-6344b004ca99');
      return { data: { 'License Number': 'TEST-123',
        'Directors/Business Owner': 'Name: Alice Example, Nationality: Exampleland, ID Number: TEST1, Phone Number: Null, email: Null, Shareholding Percentage: 100%' },
      metadata: { fileName: 'private.pdf' } };
    } });
  assert.equal(outcome.status, 'completed');
  assert.equal(store.result().data.license_number, 'TEST-123');
  assert.equal(store.result().data.directors_business_owners[0].shareholding_percent, '100%');
  for (const field of ['processing', 'review_flags', 'review_required', 'metadata', 'confidence'])
    assert.equal(store.result()[field], undefined);
});

test('a replayed MOA TAED call cannot make a duplicate paid request', async () => {
  const store = fakeStore('taed_in_flight', 'moa-analysis');
  store.state.pipeline = 'taed';
  store.state.timestamp = new Date().toISOString();
  let calls = 0;
  const outcome = await processDocumentOcrJob({ store, partitionKey: store.state.partitionKey,
    jobId: store.state.jobId,
    getTaedKey: async () => { calls += 1; return 'synthetic-key'; },
    taedExtract: async () => { calls += 1; } });
  assert.equal(outcome.status, 'in_progress');
  assert.equal(calls, 0);
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
