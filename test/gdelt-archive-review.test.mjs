import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { processArchiveReviewPage, archiveReviewId } from '../lib/gdelt-archive-review.mjs';
import { MemoryAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';
import { presentAdverseMediaResponse, screenAdverseMedia, validateAdverseMediaRequest,
  prepareArchiveReviewScope } from '../lib/adverse-media.mjs';

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

test('ten distinct adverse stories stop the historical review without buying more articles', async () => {
  const store = new MemoryAdverseMediaReportStore();
  let providerCalls = 0;
  const resolveArticle = async (item) => {
    providerCalls += 1;
    return { status: 'adverse', url: item.url,
      text: `${name} was fined by the regulator for event ${item.recordId}.`,
      quote: `${name} was fined by the regulator`, subject_role: 'direct_actor',
      entity_match: 'confirmed', legal_stage: 'regulatory_action' };
  };
  resolveArticle.version = 'threshold-fixture-v1';
  const result = await finish({ ownerId: 'owner-threshold', request, store,
    snapshotResult: baseline(13), table: table(Array.from({ length: 13 }, (_, i) => row(i + 1))),
    resolveArticle, pageSize: 4, maxPostings: 10 });
  assert.equal(result.status, 'sufficient_adverse_media_found');
  assert.equal(result.reason, 'ten_distinct_adverse_articles');
  assert.equal(result.adverse, 10);
  assert.equal(result.postings_scanned, 10);
  assert.equal(result.unscanned_postings, 3);
  assert.equal(providerCalls, 10);
  const evidence = await store.listArchiveReviewItems({ ownerId: 'owner-threshold', reviewId: result.review_id });
  assert.equal(evidence.items.length, 10);
  const replay = await processArchiveReviewPage({ ownerId: 'owner-threshold', request, store,
    snapshotResult: baseline(13), table: table(Array.from({ length: 13 }, (_, i) => row(i + 1))),
    resolveArticle, pageSize: 4 });
  assert.equal(replay.status, 'sufficient_adverse_media_found');
  assert.equal(providerCalls, 10);
});

test('no adverse findings completes after all postings without waiting for ten', async () => {
  const store = new MemoryAdverseMediaReportStore();
  const resolveArticle = async (item) => ({ status: 'general', url: item.url,
    text: `${name} opened a new office.`, quote: `${name} opened a new office`,
    subject_role: 'context_only', entity_match: 'confirmed' });
  resolveArticle.version = 'neutral-fixture-v1';
  const result = await finish({ ownerId: 'owner-neutral', request, store,
    snapshotResult: baseline(3), table: table([row(1), row(2), row(3)]),
    resolveArticle, pageSize: 2 });
  assert.equal(result.status, 'completed');
  assert.equal(result.adverse, 0);
  assert.equal(result.postings_scanned, 3);
  assert.equal(result.unresolved, 0);
});

test('syndicated articles with one headline cannot fill the ten-finding threshold', async () => {
  const store = new MemoryAdverseMediaReportStore();
  let providerCalls = 0;
  const resolveArticle = async (item) => {
    providerCalls += 1;
    return { status: 'adverse', url: item.url,
      text: `${name} was fined by the regulator.`, quote: `${name} was fined`,
      subject_role: 'direct_actor', entity_match: 'confirmed' };
  };
  resolveArticle.version = 'syndication-fixture-v1';
  const rows = Array.from({ length: 12 }, (_, i) => ({ ...row(i + 1),
    title: 'Example Holdings faced the same regulatory action' }));
  const result = await finish({ ownerId: 'owner-syndication', request, store,
    snapshotResult: baseline(12), table: table(rows), resolveArticle, pageSize: 4 });
  assert.equal(result.status, 'completed');
  assert.equal(result.adverse, 1);
  assert.equal(result.adverse_articles, 12);
  assert.equal(providerCalls, 12);
});

test('a crash after article extraction never purchases the same article again', async () => {
  const store = new MemoryAdverseMediaReportStore();
  const saveItem = store.saveArchiveReviewItem.bind(store);
  let writes = 0;
  store.saveArchiveReviewItem = async (input) => {
    if (++writes === 1) throw new Error('controlled_write_interruption');
    return saveItem(input);
  };
  let providerCalls = 0;
  const resolveArticle = async (item) => {
    providerCalls += 1;
    return { status: 'general', url: item.url, text: `${name} was mentioned in a routine story.`,
      quote: `${name} was mentioned`, subject_role: 'context_only', entity_match: 'confirmed' };
  };
  resolveArticle.version = 'controlled-fixture-v1';
  const input = { ownerId: 'owner-crash', request, store, snapshotResult: baseline(1),
    table: table([row(1)]), resolveArticle, pageSize: 1 };
  await assert.rejects(processArchiveReviewPage({ ...input, clock: () => 0 }), /controlled_write_interruption/);
  let result;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    result = await processArchiveReviewPage({ ...input, clock: () => 600_001 });
    if (result.status !== 'processing') break;
  }
  assert.equal(providerCalls, 1);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'archive_evidence_unresolved');
  assert.equal(result.unresolved, 1);
  const evidence = await store.listArchiveReviewItems({ ownerId: 'owner-crash', reviewId: result.review_id });
  assert.equal(evidence.items[0].reason, 'article_review_interrupted');
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

test('a high-volume review scans up to its posting limit before settling Inconclusive', async () => {
  let called = 0;
  const result = await finish({ ownerId: 'owner-budget', request,
    store: new MemoryAdverseMediaReportStore(), snapshotResult: baseline(13),
    table: table(Array.from({ length: 13 }, (_, i) => row(i + 1))),
    maxPostings: 2, pageSize: 4,
    resolveArticle: async () => { called += 1; return null; } });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason, 'archive_review_posting_budget');
  assert.equal(result.expected_postings, 13);
  assert.equal(result.postings_scanned, 2);
  assert.equal(result.unscanned_postings, 11);
  assert.equal(called, 2);
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
  const sufficient = presentAdverseMediaResponse(await screenAdverseMedia({ ...base,
    archiveReview: { ...review, status: 'sufficient_adverse_media_found',
      expected_postings: 13, postings_scanned: 10, adverse: 10,
      unscanned_postings: 3, updated_at: '2026-11-20T02:01:30Z' },
    archiveSearch: async () => ({ origin: 'local', complete: true, evidencePending: true,
      results: [], state: snapshot,
      scan: { mode: 'v2_point_summary', mentions_indexed: 13, unreviewed_count: 13 } }) }));
  assert.equal(sufficient.summary.profile_status, 'unsafe');
  assert.equal(sufficient.summary.profile_reason, 'sufficient_adverse_media_found');
  assert.equal(sufficient.coverage.archive_review.coverage_label, 'Sufficient adverse media found');
  assert.equal(sufficient.coverage.archive_review.unscanned_postings, 3);
  assert.ok(sufficient.coverage.reason_codes.includes('sufficient_adverse_media_found'));
  assert.ok(!sufficient.coverage.reason_codes.includes('archive_evidence_unreviewed'));
  const inconclusive = presentAdverseMediaResponse(await screenAdverseMedia({ ...base,
    archiveReview: { ...review, status: 'inconclusive', unresolved: 1,
      reason: 'archive_evidence_unresolved', updated_at: '2026-11-20T02:02:00Z' } }));
  assert.equal(inconclusive.summary.profile_status, 'inconclusive');
  assert.equal(inconclusive.coverage.archive_review.reason, 'archive_evidence_unresolved');
  const budgeted = presentAdverseMediaResponse(await screenAdverseMedia({ ...base,
    archiveReview: { ...review, status: 'inconclusive', reason: 'archive_review_posting_budget',
      expected_postings: 13, postings_scanned: 2, unique_articles: 2, unresolved: 1,
      unscanned_postings: 11 },
    archiveSearch: async () => ({ origin: 'local', complete: true, evidencePending: true,
      results: [], state: snapshot,
      scan: { mode: 'v2_point_summary', mentions_indexed: 13, unreviewed_count: 13 } }) }));
  assert.equal(budgeted.summary.profile_status, 'inconclusive');
  assert.equal(budgeted.coverage.archive_review.expected_postings, 13);
  assert.equal(budgeted.coverage.archive_review.postings_scanned, 2);
  assert.equal(budgeted.coverage.archive_review.unscanned_postings, 11);
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

test('final individual V2 lookup uses the exact associations reviewed by the worker', async () => {
  const individual = validateAdverseMediaRequest({ entity_type: 'individual',
    name: 'Mohammad Arbaz Uddin', languages: ['en'], deep_research: true,
    archive_review: true, callback_url: 'https://example.com/webhook' });
  let discoveryCalls = 0;
  const prepared = await prepareArchiveReviewScope({ request: { ...individual, callback_url: '' }, apiKey: 'fixture',
    fetchImpl: async () => { discoveryCalls += 1; return Response.json({ web: { results: [{
      title: 'Mohammad Arbaz Uddin founder of Acme Holdings',
      description: 'Mohammad Arbaz Uddin is founder of Acme Holdings.'
    }] } }); } });
  assert.deepEqual(prepared.associations, [{ value: 'Acme Holdings', type: 'organization' }]);
  let archiveLookups = 0;
  const reviewedRequest = { ...individual, callback_url: '', associations: prepared.associations };
  const review = { review_id: archiveReviewId('individual-owner', reviewedRequest, snapshot, 'fixture-v1'),
    status: 'completed', snapshot, expected_postings: 1, postings_scanned: 1,
    unique_articles: 1, adverse: 0, unresolved: 0, general: 1 };
  const input = { request: { ...individual, callback_url: '' }, apiKey: 'fixture',
    preparedArchiveScope: prepared, archiveReview: review,
    aiClassifier: async (items) => ({ status: 'not_needed', results: items, candidates: 0,
      inputTokens: 0, outputTokens: 0, cost: 0 }),
    archiveSearch: async (scoped) => {
      archiveLookups += 1;
      assert.deepEqual(scoped.associations, prepared.associations);
      return { origin: 'local', complete: true, evidencePending: true, results: [], state: snapshot,
        scan: { mode: 'v2_point_summary', mentions_indexed: 1, unreviewed_count: 1 } };
    },
    fetchImpl: async (url) => Response.json(new URL(url).pathname.includes('/news/')
      ? { results: [] } : { web: { results: [] } }),
    cacheSignature: async () => 'individual-scope-fixture' };
  const result = presentAdverseMediaResponse(await screenAdverseMedia(input));
  assert.equal(result.coverage.archive_review.status, 'completed');
  assert.equal(result.summary.profile_status, 'safe');
  assert.equal(discoveryCalls, 1);
  assert.equal(archiveLookups, 1);
  await assert.rejects(screenAdverseMedia({ ...input,
    preparedArchiveScope: { ...prepared, associations: [] } }), /archive_review_scope_mismatch/);
});
