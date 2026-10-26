import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';
import { createAdverseMediaAuditPdf, createAdverseMediaNarrative } from '../lib/adverse-media-report.mjs';
import { AzureAdverseMediaReportStore, MemoryAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';

process.env.NODE_ENV = 'test';
const { finalizeAdverseMediaReport } = await import('../server.mjs');

const request = {
  entity_type: 'individual', name: 'Example Person', aliases: [], countries: ['AE'], languages: ['en'],
  date_from: '', date_to: '', max_results: 25, risk_threshold: 0.65,
  review_threshold_percent: 65, high_risk_threshold_percent: 90, deep_research: false,
  search_plus: true, callback_url: '', customer_logo_url: ''
};
const response = {
  screening_id: '03e3be3d-9713-4c23-9d14-0e9128c7fe15', status: 'completed', completed_at: '2026-10-26T09:31:00.000Z',
  entity: { entity_type: 'individual', name: 'Example Person', aliases: [], countries: ['AE'] },
  summary: {
    outcome: 'review_required', risk_level: 'review', highest_risk_score: 0.86, potentially_relevant_results: 1,
    categories: { financial_crime: 1 }, human_review_required: true,
    statement: 'One potentially relevant result reached the configured review threshold.', risk_threshold: 0.65,
    thresholds: { high_risk_percent: 90, review_percent: 65, safe_below_percent: 65 },
    risk_distribution: { high_risk: 0, review: 1, safe: 0 },
    results_at_or_above_threshold: 1, decision_eligible: true, threshold_status: 'review_required'
  },
  coverage: {
    complete: true, sources: [{ source: 'current_news', status: 'complete' }], reason_codes: [], retryable: false,
    languages_searched: [{ code: 'en', name: 'English' }], date_from: null, date_to: null,
    searched_at: '2026-10-26T09:31:00.000Z', archive_window: 'up to one year',
    search_plus: {
      requested: true, publisher_catalog_size: 1500, publishers_attempted: 2,
      publishers_screened: [
        { name: 'Example News', domain: 'news.example', country: 'United Arab Emirates', country_code: 'AE', category: 'general' },
        { name: 'Example Finance', domain: 'finance.example', country: 'United Arab Emirates', country_code: 'AE', category: 'finance' }
      ],
      publishers_not_completed: [], matched_results: 1, matched_publishers: []
    },
    limitation: 'Indexed public sources only.'
  },
  results: [{
    result_id: 'r-1', title: 'Example Person named in investigation', url: 'https://news.example/case', publisher: 'news.example',
    published_at: '2026-10-20T00:00:00Z', language: 'en', source_type: 'news_index',
    excerpt: 'Authorities opened an investigation. No final judgment was reported.', risk_score: 0.86, risk_level: 'review',
    categories: ['financial_crime'], legal_stage: 'investigation', review_required: true
  }]
};

test('report narrative uses a strict single-purpose JSON contract', async () => {
  const narrative = await createAdverseMediaNarrative({
    response, apiKey: 'private', fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      assert.match(payload.systemInstruction.parts[0].text, /single-purpose adverse-media audit report writer/);
      assert.match(payload.systemInstruction.parts[0].text, /untrusted data/);
      assert.equal(payload.generationConfig.responseJsonSchema.additionalProperties, false);
      assert.equal(JSON.parse(payload.contents[0].parts[0].text).job, 'write_adverse_media_audit_summary');
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        summary: 'One potentially relevant result requires review.', findings: ['An investigation-stage result met the threshold.'],
        recommendations: ['Complete documented human review before making a decision.']
      }) }] } }] });
    }
  });
  assert.equal(narrative.findings.length, 1);
  assert.match(narrative.recommendations[0], /human review/);
});

test('PDF includes a complete multi-page audit artifact and stable integrity metadata', async () => {
  const report = await createAdverseMediaAuditPdf({
    request, response,
    narrative: { summary: 'A relevant result requires review.', findings: ['One result met the threshold.'], recommendations: ['Perform human review.'] },
    origin: { received_at: '2026-10-26T09:30:00.000Z', network_origin: '203.0.113.10', processing_location: 'Microsoft Azure UAE North' },
    generatedAt: '2026-10-26T09:32:00.000Z'
  });
  assert.equal(report.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(report.reportId, /^[0-9a-f-]{36}$/);
  assert.match(report.sha256, /^[0-9a-f]{64}$/);
  const parsed = await PDFDocument.load(report.bytes);
  assert.ok(parsed.getPageCount() >= 2);
  assert.match(parsed.getTitle(), /Adverse Media Screening Result/);
  assert.match(parsed.getSubject(), new RegExp(response.screening_id));
});

test('permanent report store retains owner isolation and supports public capability lookup', async () => {
  const store = new MemoryAdverseMediaReportStore();
  const metadata = { report_id: 'rpt', transaction_id: 'txn', generated_at: new Date().toISOString(), sha256: 'a'.repeat(64), filename: 'report.pdf', retention: 'permanent' };
  await store.save({ ownerId: 'customer-a', reportId: 'rpt', bytes: Buffer.from('%PDF-test'), metadata });
  assert.equal((await store.get({ ownerId: 'customer-a', reportId: 'rpt' })).metadata.retention, 'permanent');
  assert.equal(await store.get({ ownerId: 'customer-b', reportId: 'rpt' }), null);
  assert.equal((await store.getPublic({ reportId: 'rpt' })).metadata.filename, 'report.pdf');
  assert.equal(await store.getPublic({ reportId: 'missing' }), null);
});

test('deep-research finalization reuses one saved report after a retry', async () => {
  const store = new MemoryAdverseMediaReportStore();
  let saves = 0;
  const originalSave = store.save.bind(store);
  store.save = async (value) => { saves += 1; return originalSave(value); };
  const reportId = 'e565a72c-c734-4ad5-ab72-7dc5ed8391bb';
  const input = { request, response, ownerId: 'synthetic-owner', reportId, aiApiKey: '',
    origin: { received_at: '2026-10-26T09:30:00.000Z', network_origin: '203.0.113.10',
      processing_location: 'Microsoft Azure UAE North' },
    fetchImpl: async () => { throw new Error('unexpected_provider_call'); }, reportStore: store };
  const first = await finalizeAdverseMediaReport(input);
  const second = await finalizeAdverseMediaReport(input);
  assert.equal(first.report.report_id, reportId);
  assert.equal(second.report.report_id, reportId);
  assert.equal(second.report.transaction_id, response.screening_id);
  assert.equal(saves, 1);
});

test('provider component checkpoints survive a worker-store restart and are removed after completion', async () => {
  const blobs = new Map();
  const container = {
    getBlockBlobClient(name) {
      return {
        async uploadData(bytes, options) {
          if (blobs.has(name) && options.conditions?.ifNoneMatch === '*') {
            throw Object.assign(new Error('already_exists'), { statusCode: 412 });
          }
          blobs.set(name, Buffer.from(bytes));
        },
        async download() {
          const bytes = blobs.get(name);
          if (!bytes) throw Object.assign(new Error('not_found'), { statusCode: 404 });
          return { readableStreamBody: Readable.from([bytes]) };
        }
      };
    },
    async *listBlobsFlat({ prefix }) {
      for (const name of blobs.keys()) if (name.startsWith(prefix)) yield { name };
    },
    async deleteBlob(name) { blobs.delete(name); }
  };
  const makeStore = () => {
    const store = new AzureAdverseMediaReportStore({
      blobServiceUrl: 'https://synthetic.blob.core.windows.net',
      credential: { getToken: async () => ({ token: 'synthetic', expiresOnTimestamp: Date.now() + 60000 }) }
    });
    store.container = container;
    return store;
  };
  const input = { ownerId: 'synthetic-owner', screeningId: 'synthetic-screening',
    componentKey: 'brave:https://api.search.brave.com/res/v1/news/search?q=synthetic' };
  await makeStore().saveDeepResearchComponent({ ...input, value: { results: [{ url: 'https://example.com/story' }] } });
  await makeStore().saveDeepResearchComponent({ ...input, value: { results: [{ url: 'https://example.com/changed' }] } });
  assert.deepEqual(await makeStore().getDeepResearchComponent(input),
    { results: [{ url: 'https://example.com/story' }] });
  await makeStore().deleteDeepResearchComponents(input);
  assert.equal(await makeStore().getDeepResearchComponent(input), null);
});

test('Azure Table reserves one lifetime provider budget across concurrent worker replicas', async () => {
  const entities = new Map();
  let version = 0;
  const key = (partitionKey, rowKey) => `${partitionKey}/${rowKey}`;
  const conflict = (statusCode) => Object.assign(new Error('table_conflict'), { statusCode });
  const table = {
    async getEntity(partitionKey, rowKey) {
      const row = entities.get(key(partitionKey, rowKey));
      if (!row) throw conflict(404);
      return { ...row };
    },
    async createEntity(row) {
      const id = key(row.partitionKey, row.rowKey);
      if (entities.has(id)) throw conflict(409);
      entities.set(id, { ...row, etag: String(++version) });
    },
    async updateEntity(row, _mode, { etag }) {
      const id = key(row.partitionKey, row.rowKey);
      if (entities.get(id)?.etag !== etag) throw conflict(412);
      entities.set(id, { ...row, etag: String(++version) });
    }
  };
  const makeStore = () => {
    const store = new AzureAdverseMediaReportStore({
      blobServiceUrl: 'https://synthetic.blob.core.windows.net',
      tableServiceUrl: 'https://synthetic.table.core.windows.net',
      credential: { getToken: async () => ({ token: 'synthetic', expiresOnTimestamp: Date.now() + 60000 }) }
    });
    store.table = table;
    return store;
  };
  const stores = [makeStore(), makeStore()];
  const details = { ownerId: 'synthetic-owner', screeningId: 'synthetic-job', costMicroUsd: 5000,
    provider: 'brave', maxMicroUsd: 5000 };
  const outcomes = await Promise.allSettled(stores.map((store) => store.reserveDeepResearchCost(details)));
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((item) => item.status === 'rejected' && item.reason.message === 'screening_cost_limit').length, 1);
  assert.deepEqual(await stores[1].getDeepResearchUsage(details),
    { reservedMicroUsd: 5000, providerCalls: { brave: 1, gemini: 0 } });
});
