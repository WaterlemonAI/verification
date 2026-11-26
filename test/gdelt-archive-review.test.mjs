import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { processArchiveReviewPage, archiveReviewId } from '../lib/gdelt-archive-review.mjs';
import { advanceTitleUrlCandidate } from '../lib/gdelt-archive-candidate.mjs';
import { assessAdvanceScreening } from '../lib/adverse-media-advance-classifier.mjs';
import { normalizeAdvanceEvidence } from '../lib/adverse-media-advance-evidence.mjs';
import { compileAdvancePolicySet } from '../lib/adverse-media-advance-policy.mjs';
import { AzureAdverseMediaReportStore, MemoryAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';
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

test('Advance skips Event Registry for body-only mentions and records metadata exclusions', async () => {
  const store = new MemoryAdverseMediaReportStore();
  const unrelated = { ...row(1), title: 'Market report',
    url: 'https://publisher.example/market-report' };
  let calls = 0;
  const result = await finish({ ownerId: 'owner-filter', request, store,
    snapshotResult: baseline(1), table: table([unrelated]),
    candidateFilter: advanceTitleUrlCandidate,
    resolveArticle: async () => { calls += 1; throw new Error('must_not_call'); } });
  assert.equal(calls, 0);
  assert.equal(result.status, 'completed');
  assert.equal(result.not_selected_articles, 1);
  assert.equal(result.metadata_excluded, 1);
  const evidence = await store.listArchiveReviewItems({ ownerId: 'owner-filter', reviewId: result.review_id });
  assert.equal(evidence.items[0].status, 'metadata_excluded');
});

test('Advance defers selected archive URLs to one merged extraction and model review', async () => {
  const store = new MemoryAdverseMediaReportStore();
  const adverse = { ...row(1), title: 'Example Holdings fraud investigation',
    url: 'https://publisher.example/example-holdings-fraud' };
  let archiveProviderCalls = 0;
  const state = await finish({ ownerId: 'advance-deferred-owner', request, store,
    snapshotResult: baseline(1), table: table([adverse]),
    candidateFilter: advanceTitleUrlCandidate, deferSelected: true,
    resolveArticle: async () => { archiveProviderCalls += 1; throw new Error('must_not_call'); } });
  assert.equal(state.status, 'completed');
  assert.equal(state.deferred, 1);
  assert.equal(archiveProviderCalls, 0);
  const archiveItems = (await store.listArchiveReviewItems({
    ownerId: 'advance-deferred-owner', reviewId: state.review_id })).items;
  const quote = 'The regulator fined Example Holdings for fraud.';
  const response = { entity: { name, entity_type: 'business' },
    advance_source_results: [{ result_id: 'brave-overlap', title: adverse.title,
      url: adverse.url, excerpt: quote, source_type: 'brave_search' }],
    coverage: { complete: true, archive_review: state }, summary: {},
    media_buckets: { adverse_media: [], general_news_mentions: [], no_impact_media: [] } };
  const saved = new Map();
  const checkpoint = { get: async (key) => saved.get(key) || null,
    save: async (key, value) => { saved.set(key, value); } };
  let extractionCalls = 0;
  let modelCalls = 0;
  const options = { response, archiveItems, policySet: compileAdvancePolicySet({ policy_ids: ['FIN-01'] }),
    apiKey: 'test', checkpoint,
    extractArticle: async () => { extractionCalls += 1;
      return { text: `Verified article body. ${quote} Additional context.` }; },
    fetchImpl: async (_url, init) => {
      modelCalls += 1;
      const articles = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text).articles;
      assert.equal(articles.length, 1);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events: [{
        story_key: articles[0].story_key, adverse_assessment: 'adverse',
        subject_role: 'direct_actor', subject_relationship: 'direct', entity_match: 'confirmed',
        event_type_ids: ['FIN-01'], severity: 'serious', legal_stage: 'regulatory_action',
        supporting_quote: quote, confidence: 0.95, report_priority: 90
      }] }) }] } }] });
    } };
  const assessment = await assessAdvanceScreening(options);
  assert.equal(assessment.articles_considered, 1);
  assert.equal(assessment.evidence_profile.status, 'unsafe');
  assert.equal(extractionCalls, 1);
  assert.equal(modelCalls, 1);
  await assessAdvanceScreening(options);
  assert.equal(extractionCalls, 1);
  assert.equal(modelCalls, 1);
});

test('Advance preserves an adverse title on a later posting of the same URL', async () => {
  const store = new MemoryAdverseMediaReportStore();
  const url = 'https://publisher.example/example-holdings-story';
  const postings = [{ ...row(1, url), title: 'Example Holdings product update' },
    { ...row(2, url), title: 'Example Holdings fined for fraud' }];
  const state = await finish({ ownerId: 'advance-overlap-owner', request, store,
    snapshotResult: baseline(2), table: table(postings), pageSize: 1,
    candidateFilter: advanceTitleUrlCandidate, deferSelected: true });
  assert.equal(state.status, 'completed');
  assert.equal(state.postings_scanned, 2);
  assert.equal(state.postings_recorded, 2);
  assert.equal(state.unique_articles, 1);
  assert.equal(state.metadata_excluded, 1);
  assert.equal(state.deferred, 1);
  const items = (await store.listArchiveReviewItems({
    ownerId: 'advance-overlap-owner', reviewId: state.review_id })).items;
  assert.equal(items.length, 2);
  const evidence = normalizeAdvanceEvidence({ advance_source_results: [] }, items);
  assert.equal(evidence.counts.selected_candidates, 1);
  assert.equal(evidence.items[0].title, postings[1].title);
  assert.equal(evidence.items[0].selection_reason, 'title_and_adverse_signal');
});

test('Azure archive metadata writes one page per transaction and safely replays conflicts', async () => {
  const rows = new Map();
  let transactions = 0;
  let individualCreates = 0;
  const store = Object.create(AzureAdverseMediaReportStore.prototype);
  store.table = {
    async submitTransaction(actions) {
      transactions += 1;
      assert.equal(actions.length, 2);
      if (actions.some(([, row]) => rows.has(row.rowKey))) {
        throw Object.assign(new Error('conflict'), { statusCode: 409 });
      }
      for (const [, row] of actions) rows.set(row.rowKey, row);
    },
    async createEntity(row) {
      individualCreates += 1;
      if (rows.has(row.rowKey)) throw Object.assign(new Error('conflict'), { statusCode: 409 });
      rows.set(row.rowKey, row);
    }
  };
  const input = { ownerId: 'batch-owner', reviewId: 'review-1', items: [
    { articleId: 'first', item: { status: 'metadata_excluded' } },
    { articleId: 'second', item: { status: 'deferred' } }
  ] };
  await store.saveArchiveReviewItems(input);
  await store.saveArchiveReviewItems(input);
  assert.equal(transactions, 2);
  assert.equal(individualCreates, 2);
  assert.equal(rows.size, 2);
});

test('Advance records more than 1,000 archive postings without the legacy scan ceiling', async () => {
  const store = new MemoryAdverseMediaReportStore();
  const postings = Array.from({ length: 1005 }, (_, index) => ({ ...row(index),
    title: `Neutral market update ${index}` }));
  let state;
  for (let index = 0; index < 12; index++) {
    state = await processArchiveReviewPage({ ownerId: 'advance-large-owner', request, store,
      snapshotResult: baseline(postings.length), table: table(postings),
      candidateFilter: advanceTitleUrlCandidate, pageSize: 100,
      maxPostings: Number.MAX_SAFE_INTEGER });
    if (state.status !== 'processing') break;
  }
  assert.equal(state.status, 'completed');
  assert.equal(state.postings_scanned, 1005);
  assert.equal(state.metadata_excluded, 1005);
  assert.equal(state.unscanned_postings || 0, 0);
});

test('Advance archive review pauses at its cost ceiling and resumes after a budget revision', async () => {
  const store = new MemoryAdverseMediaReportStore();
  const adverse = { ...row(1), title: 'Example Holdings fined for fraud' };
  let calls = 0;
  const input = { ownerId: 'advance-budget-owner', request, store,
    snapshotResult: baseline(1), table: table([adverse]),
    candidateFilter: advanceTitleUrlCandidate, pageSize: 1,
    maxPostings: Number.MAX_SAFE_INTEGER,
    resolveArticle: async () => {
      calls += 1;
      const text = 'The regulator fined Example Holdings for fraudulent accounting.';
      return calls === 1 ? { reason: 'article_cost_limit' }
        : { status: 'adverse', url: adverse.url, text, quote: text,
          subject_role: 'direct_actor', entity_match: 'confirmed',
          reason: 'article_party_fact_supported' };
    } };
  const blocked = await processArchiveReviewPage({ ...input, budgetRevision: '1' });
  assert.equal(blocked.status, 'budget_blocked');
  assert.equal(blocked.pending_count, 1);
  assert.equal((await processArchiveReviewPage({ ...input, budgetRevision: '1' })).status,
    'budget_blocked');
  assert.equal(calls, 1);
  const resumed = await finish({ ...input, budgetRevision: '2' });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.adverse, 1);
  assert.equal(calls, 2);
});

test('Advance refuses an archive snapshot that changed after admission', async () => {
  const store = new MemoryAdverseMediaReportStore();
  await assert.rejects(processArchiveReviewPage({ ownerId: 'snapshot-owner', request, store,
    snapshotResult: baseline(1), table: table([row(1)]),
    candidateFilter: advanceTitleUrlCandidate,
    expectedSnapshot: { ...snapshot, coverage_end: '2026-11-21T01:30:00.000Z' } }),
  /archive_review_snapshot_changed/);
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
