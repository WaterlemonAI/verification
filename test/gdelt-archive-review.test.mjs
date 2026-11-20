import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { processArchiveReviewPage, archiveReviewId } from '../lib/gdelt-archive-review.mjs';
import { MemoryAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';
import { presentAdverseMediaResponse, screenAdverseMedia, validateAdverseMediaRequest } from '../lib/adverse-media.mjs';

const name = 'Example Holdings';
const nameHash = createHash('sha256').update('example holdings').digest('hex');
const snapshot = { coverage_start: '2026-11-20T01:00:00.000Z',
  coverage_end: '2026-11-20T01:30:00.000Z', index_version: 2 };
const request = { name, entity_type: 'business', aliases: [], archive_all_stored: true };
const row = (index, url = `https://publisher.example/article-${index}`) => ({
  partitionKey: `o-${nameHash[0]}`, rowKey: `${nameHash}_20261120013000-${index}`,
  recordId: `20261120013000-${index}`, publishedAt: snapshot.coverage_end,
  source: 'publisher.example', url, title: `Example Holdings report ${index}`,
  matchedName: name, themes: 'ECONOMY', language: 'en'
});
function table(rows) {
  return { listEntities({ queryOptions }) {
    const filter = String(queryOptions.filter);
    const selected = filter.includes(`o-${nameHash[0]}`) && filter.includes(nameHash)
      ? rows : [];
    return { byPage({ maxPageSize, continuationToken }) {
      const start = Number(continuationToken || 0);
      return (async function* () {
        const page = selected.slice(start, start + maxPageSize);
        page.continuationToken = start + page.length < selected.length ? String(start + page.length) : undefined;
        yield page;
      })();
    } };
  } };
}
const baseline = (mentions) => ({ complete: true, state: snapshot,
  scan: { mode: 'v2_point_summary', mentions_indexed: mentions } });

async function finish(input) {
  let result;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    result = await processArchiveReviewPage(input);
    if (result.status !== 'processing') return result;
  }
  throw new Error('review_did_not_finish');
}

test('complete V1 paging retains all mentions, deduplicates URLs and does not clear unavailable articles', async () => {
  const store = new MemoryAdverseMediaReportStore();
  const result = await finish({ ownerId: 'owner-1', request, store,
    snapshotResult: baseline(3), table: table([row(1), row(2, row(1).url), row(3)]), pageSize: 1 });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'archive_evidence_unresolved');
  assert.equal(result.postings_scanned, 3);
  assert.equal(result.unique_articles, 2);
  assert.equal(result.unresolved, 2);
  const evidence = await store.listArchiveReviewItems({ ownerId: 'owner-1', reviewId: result.review_id });
  assert.equal(evidence.items.length, 2);
  assert.equal((await store.listArchiveReviewItems({ ownerId: 'owner-2', reviewId: result.review_id })).items.length, 0);
});

test('a direct adverse decision requires quoted article evidence and a confirmed subject match', async () => {
  const store = new MemoryAdverseMediaReportStore();
  const resolveArticle = async (item) => ({ status: 'adverse', url: item.url,
    text: 'Example Holdings was fined by the regulator.', quote: 'Example Holdings was fined',
    subject_role: 'direct_actor', entity_match: 'confirmed', legal_stage: 'regulatory_action',
    adapter_version: 'controlled-fixture-v1' });
  resolveArticle.version = 'controlled-fixture-v1';
  const result = await finish({ ownerId: 'owner-1', request, store,
    snapshotResult: baseline(1), table: table([row(1)]), resolveArticle });
  assert.equal(result.status, 'completed');
  assert.equal(result.adverse, 1);
  assert.equal(result.unresolved, 0);
  assert.equal(result.adverse_sample[0].quote, 'Example Holdings was fined');
  assert.equal(Object.hasOwn(result.adverse_sample[0], 'text'), false);
});

test('unsupported quote and count mismatch remain inconclusive', async () => {
  const store = new MemoryAdverseMediaReportStore();
  const resolveArticle = async (item) => ({ status: 'general', url: item.url,
    text: 'An unrelated story.', quote: 'Not in the source', subject_role: 'context_only' });
  resolveArticle.version = 'bad-fixture-v1';
  const result = await finish({ ownerId: 'owner-1', request, store,
    snapshotResult: baseline(2), table: table([row(1)]), resolveArticle });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'archive_posting_count_mismatch');
  assert.equal(result.unresolved, 1);
  assert.match(result.review_id, /^[a-f0-9]{32}$/);
  assert.equal(archiveReviewId('owner-2', request, snapshot, resolveArticle.version) === result.review_id, false);
});

test('unverified V2 lookup cannot start review', async () => {
  const result = await processArchiveReviewPage({ ownerId: 'owner-1', request,
    store: new MemoryAdverseMediaReportStore(), snapshotResult: { complete: false,
      state: snapshot, scan: { mode: 'v2_point_summary', mentions_indexed: 1 } }, table: table([row(1)]) });
  assert.deepEqual(result, { status: 'unavailable', reason: 'verified_v2_snapshot_required' });
});

test('a review above its posting budget stays Inconclusive without calling a provider', async () => {
  let called = 0;
  const result = await processArchiveReviewPage({ ownerId: 'owner-1', request,
    store: new MemoryAdverseMediaReportStore(), snapshotResult: baseline(201),
    table: table([row(1)]), maxPostings: 200,
    resolveArticle: async () => { called += 1; return null; } });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'archive_review_posting_budget');
  assert.equal(result.expected_postings, 201);
  assert.equal(called, 0);
});

test('a complete archive review reaches the locked profile without relying on the V2 sample', async () => {
  const screened = validateAdverseMediaRequest({ entity_type: 'business', name,
    languages: ['en'] });
  const archiveSearch = async () => ({ origin: 'local', complete: true, evidencePending: true,
    results: [{ title: 'Sample is not evidence', url: 'https://publisher.example/sample' }],
    state: snapshot, scan: { mode: 'v2_point_summary', mentions_indexed: 1, unreviewed_count: 1 } });
  const aiClassifier = async (items) => ({ status: 'completed', candidates: items.length,
    results: items, inputTokens: 0, outputTokens: 0, cost: 0 });
  const base = { request: screened, apiKey: 'fixture',
    fetchImpl: async (input) => Response.json(new URL(input).pathname.includes('/news/')
      ? { results: [] } : { web: { results: [] } }), archiveSearch, aiClassifier,
    cacheSignature: async () => 'fixture-snapshot' };
  const review = { review_id: 'a'.repeat(32), status: 'completed', snapshot,
    expected_postings: 1, postings_scanned: 1, unique_articles: 1,
    adverse: 0, unresolved: 0, updated_at: '2026-11-20T02:00:00Z' };
  const safe = presentAdverseMediaResponse(await screenAdverseMedia({ ...base, archiveReview: review }));
  assert.equal(safe.summary.profile_status, 'safe');
  assert.equal(safe.coverage.archive_unreviewed_count, 0);
  assert.equal(safe.coverage.archive_review.status, 'completed');
  const unsafe = presentAdverseMediaResponse(await screenAdverseMedia({ ...base,
    archiveReview: { ...review, adverse: 1, updated_at: '2026-11-20T02:01:00Z' } }));
  assert.equal(unsafe.summary.profile_status, 'unsafe');
  assert.equal(unsafe.summary.outcome, 'unsafe');
  const inconclusive = presentAdverseMediaResponse(await screenAdverseMedia({ ...base,
    archiveReview: { ...review, status: 'inconclusive', unresolved: 1,
      reason: 'archive_evidence_unresolved', updated_at: '2026-11-20T02:02:00Z' } }));
  assert.equal(inconclusive.summary.profile_status, 'inconclusive');
  assert.equal(inconclusive.coverage.archive_review.reason, 'archive_evidence_unresolved');
  const stale = presentAdverseMediaResponse(await screenAdverseMedia({ ...base,
    archiveReview: { ...review, expected_postings: 2, postings_scanned: 2,
      updated_at: '2026-11-20T02:03:00Z' } }));
  assert.equal(stale.summary.profile_status, 'inconclusive');
  assert.equal(stale.coverage.archive_review, null);
});

test('an explicitly requested review cannot become Safe after the review switch is disabled', async () => {
  const request = validateAdverseMediaRequest({ entity_type: 'business', name,
    languages: ['en'], deep_research: true, archive_review: true,
    callback_url: 'https://example.com/webhook' });
  const result = presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey: 'fixture',
    aiClassifier: async (items) => ({ status: 'not_needed', results: items, candidates: 0,
      inputTokens: 0, outputTokens: 0, cost: 0 }),
    archiveSearch: async () => ({ origin: 'local', complete: true, evidencePending: false,
      results: [], state: snapshot, scan: { mode: 'v2_point_summary', mentions_indexed: 0, unreviewed_count: 0 } }),
    archiveReview: { status: 'inconclusive', reason: 'archive_review_disabled', unresolved: 1 },
    fetchImpl: async (input) => Response.json(new URL(input).pathname.includes('/news/')
      ? { results: [] } : { web: { results: [] } }), cacheSignature: async () => 'review-disabled' }));
  assert.equal(result.status, 'completed');
  assert.equal(result.coverage.archive_review.reason, 'archive_review_disabled');
  assert.equal(result.summary.profile_status, 'inconclusive');
  assert.equal(result.summary.decision_eligible, false);
});
