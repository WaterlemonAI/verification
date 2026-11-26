import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createAppServer, finalizeAdverseMediaReport } from '../server.mjs';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryAdverseMediaReportStore, reportOwnerId } from '../lib/adverse-media-report-store.mjs';
import { MemoryAdverseMediaJsonStore } from '../lib/adverse-media-json-store.mjs';
import { startDeepResearchWorker } from '../lib/deep-research-queue.mjs';
import { screenAdverseMedia, presentAdverseMediaResponse } from '../lib/adverse-media.mjs';
import { processArchiveReviewPage } from '../lib/gdelt-archive-review.mjs';
import { createEventRegistryArticleResolver } from '../lib/gdelt-article-evidence-provider.mjs';
import { createGeminiArchiveArticleReviewer } from '../lib/ai7uae-gemini-adverse-api.mjs';

process.env.NODE_ENV = 'test';
process.env.GDELT_ARCHIVE_REVIEW_ENABLED = 'true';
process.env.GDELT_PUBLIC_FALLBACK_ENABLED = 'false';
process.env.API_PUBLIC_BASE_URL = 'https://api.ai7uae.com';
const token = 'ai7_async_journey_fixture_key';
process.env.AI7_API_KEY_HASHES = createHash('sha256').update(token).digest('hex');

const name = 'Example Holdings';
const nameHash = createHash('sha256').update(name.toLowerCase()).digest('hex');
const snapshot = { coverage_start: '2026-11-20T01:00:00.000Z',
  coverage_end: '2026-11-20T01:30:00.000Z', index_version: 2, committed_intervals: 3 };
const articleUrl = 'https://news.publisher.com/article/123';
const articleTitle = 'Example Holdings charged by regulator for fraud';
const quote = 'Example Holdings was charged by the regulator for fraud.';
const article = `${quote} The filing identifies the company and its legal proceeding. `.repeat(6);
const row = { partitionKey: `o-${nameHash[0]}`, rowKey: `${nameHash}_20261120013000-1`,
  recordId: '20261120013000-1', publishedAt: snapshot.coverage_end,
  source: 'news.publisher.com', url: articleUrl, title: articleTitle,
  matchedName: name, themes: 'ECONOMY', language: 'en' };
const baseline = { complete: true, origin: 'local', results: [], evidencePending: true,
  state: snapshot, scan: { mode: 'v2_point_summary', mentions_indexed: 1, unreviewed_count: 1 } };
const table = { listEntities({ queryOptions }) {
  const selected = String(queryOptions.filter).includes(`o-${nameHash[0]}`)
    ? [row] : [];
  return { byPage({ continuationToken }) { return (async function* () {
    const page = continuationToken ? [] : selected;
    page.continuationToken = undefined;
    yield page;
  })(); } };
} };

test('HTTP submission completes queued article review, JSON, PDF and callback without retrying providers', async (t) => {
  const store = new EnvironmentStore();
  await store.setMasterKey('adverse-media', 'brave-fixture-key');
  await store.setMasterKey('adverse-media-ai', 'gemini-fixture-key');
  const reportStore = new MemoryAdverseMediaReportStore();
  const jsonStore = new MemoryAdverseMediaJsonStore();
  let enqueued = null;
  let available = false;
  let completed = false;
  let releases = 0;
  let deliveryAttempts = 0;
  let finalResponse;
  const calls = { brave: 0, event_registry_article: 0, gemini: 0, gdelt_public: 0 };
  const queue = {
    async enqueue(job) { enqueued = job; available = true; },
    async receive() {
      if (!available) return null;
      available = false;
      return { messageId: 'queued-1', popReceipt: 'receipt-1', messageText: JSON.stringify(enqueued) };
    },
    async release(_message, job) { releases += 1; enqueued = job; available = true; },
    async complete() { completed = true; controller.stop(); },
    async deadLetter() { assert.fail('the controlled job must not dead letter'); }
  };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      calls.brave += 1;
      return Response.json(url.pathname.includes('/news/') ? { results: [] } : { web: { results: [] } });
    }
    if (url.hostname === 'analytics.eventregistry.org') {
      calls.event_registry_article += 1;
      assert.equal(JSON.parse(options.body).url, articleUrl);
      return Response.json({ statusCode: 200, title: articleTitle, body: article, urlCanonical: articleUrl });
    }
    if (url.hostname === 'generativelanguage.googleapis.com') {
      calls.gemini += 1;
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ facts: [{
        result_id: 'article', party_relation: 'screened_subject', acted_party: name,
        event_kind: 'legal_action', reported_stage: 'charged', supporting_quote: quote
      }] }) }] } }] });
    }
    if (url.hostname === 'api.gdeltproject.org') calls.gdelt_public += 1;
    assert.fail(`Unexpected network provider ${url.hostname}`);
  };
  const app = createAppServer({ store, startWorker: false, deepResearchQueue: queue,
    adverseArchiveReviewStep: async () => ({ status: 'processing' }),
    reportStore, jsonStore, fetchImpl, formsQueue: null });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise((resolve) => app.close(resolve)); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const submitted = await fetch(`${base}/service/adverse_media`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'business', name, languages: ['en'],
      deep_research: true, archive_review: true, callback_url: 'https://example.com/webhook' }) });
  const receipt = await submitted.json();
  assert.equal(submitted.status, 202, JSON.stringify(receipt));
  assert.match(receipt.callback.signing_secret, /^[A-Za-z0-9_-]+$/);
  assert.equal(enqueued.screening_id, receipt.screening_id);

  let controller;
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('queued_journey_timeout')), 10_000);
    const originalComplete = queue.complete;
    queue.complete = async (message) => { await originalComplete(message); clearTimeout(timeout); resolve(); };
    controller = startDeepResearchWorker({ queue, store, resultStore: reportStore, fetchImpl,
      archiveReviewEnabled: () => true,
      archiveReviewStep: (job, { preparedArchiveScope, costGuard }) => {
        const reviewArticle = createGeminiArchiveArticleReviewer({ getApiKey: async () => 'gemini-fixture-key',
          fetchImpl: costGuard.fetch });
        const resolveArticle = createEventRegistryArticleResolver({ getApiKey: async () => 'event-fixture-key',
          reviewArticle, fetchImpl: costGuard.fetch });
        return processArchiveReviewPage({ ownerId: job.owner_id,
          request: { ...job.request, associations: preparedArchiveScope.associations },
          store: reportStore, snapshotResult: baseline, table, resolveArticle, pageSize: 1 });
      },
      screen: (input) => screenAdverseMedia({ ...input,
        archiveSearch: async () => baseline, cacheSignature: async () => 'queued-fixture-snapshot' }),
      present: presentAdverseMediaResponse,
      finalize: ({ job, response, costGuard }) => finalizeAdverseMediaReport({
        request: job.request, response, ownerId: job.owner_id, origin: job.request_origin,
        aiApiKey: '', fetchImpl: costGuard.fetch, reportStore, jsonStore, reportId: job.report_id,
        inputPayload: job.input_payload }),
      deliver: async (_job, response) => {
        deliveryAttempts += 1;
        finalResponse = response;
        if (deliveryAttempts === 1) throw new Error('controlled_callback_retry');
      }
    });
  });
  await done;
  assert.equal(completed, true);
  assert.ok(releases >= 2, 'archive paging and callback retry must release the queue item');
  assert.equal(deliveryAttempts, 2);
  assert.equal(finalResponse.screening_id, receipt.screening_id);
  assert.equal(finalResponse.summary.profile_status, 'unsafe');
  assert.equal(finalResponse.coverage.archive_review.status, 'completed');
  assert.equal(finalResponse.coverage.archive_review.adverse, 1);
  assert.equal(calls.event_registry_article, 1);
  assert.equal(calls.gemini, 1);
  assert.equal(calls.gdelt_public, 0);
  const usage = await reportStore.getDeepResearchUsage({ ownerId: reportOwnerId(token),
    screeningId: receipt.screening_id });
  assert.equal(usage.providerCalls.event_registry_article, 1);
  assert.equal(usage.providerCalls.gemini, 1);
  assert.equal(usage.providerCalls.brave, calls.brave);
  assert.ok(usage.reservedMicroUsd <= 140_000);
  const retained = await jsonStore.get({ ownerId: reportOwnerId(token), screeningId: receipt.screening_id });
  assert.equal(retained.response.report.sha256, finalResponse.report.sha256);
  const pdf = await fetch(`${base}${new URL(finalResponse.report.download_url).pathname}`);
  assert.equal(pdf.status, 200);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), finalResponse.report.sha256);
  const evidence = await reportStore.listArchiveReviewItems({ ownerId: reportOwnerId(token),
    reviewId: finalResponse.coverage.archive_review.review_id });
  assert.equal(evidence.items.length, 1);
  assert.equal(evidence.items[0].status, 'adverse');
});
