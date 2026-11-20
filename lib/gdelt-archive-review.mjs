import { createHash, randomUUID } from 'node:crypto';
import { pageLocalGdeltMentions, searchLocalGdeltIndex } from './gdelt-local-index.mjs';

export const ARCHIVE_REVIEW_POLICY = 'gdelt-archive-review-v1';
const hash = (value) => createHash('sha256').update(value).digest('hex');

function stableRequest(request) {
  return { entity_type: request.entity_type, name: request.name,
    aliases: request.aliases || [], transliterations: request.transliterations || {},
    associations: request.associations || [], archive_all_stored: request.archive_all_stored === true };
}

export function archiveReviewId(ownerId, request, snapshot, adapterVersion = 'unavailable') {
  if (!ownerId || !snapshot?.coverage_start || !snapshot?.coverage_end) throw new Error('invalid_archive_review_scope');
  return hash(JSON.stringify({ ownerId, request: stableRequest(request), snapshot: {
    coverage_start: snapshot.coverage_start, coverage_end: snapshot.coverage_end,
    index_version: snapshot.index_version, committed_intervals: snapshot.committed_intervals },
    policy: ARCHIVE_REVIEW_POLICY, adapterVersion })).slice(0, 32);
}

function articleId(row) {
  let url;
  try {
    const parsed = new URL(row.url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid');
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) parsed.searchParams.delete(key);
    url = parsed.href;
  } catch { url = `record:${String(row.recordId || row.rowKey || '')}`; }
  return { id: hash(url), url: url.startsWith('record:') ? null : url };
}

function adjudicate(row, evidence) {
  const base = { url: articleId(row).url, record_id: String(row.recordId || '').slice(0, 128),
    title: String(row.title || '').slice(0, 500), publisher: String(row.source || '').slice(0, 200),
    published_at: String(row.publishedAt || ''), matched_name: String(row.matchedName || '').slice(0, 200),
    reviewed_at: new Date().toISOString(), policy: ARCHIVE_REVIEW_POLICY,
    provider_calls: Number(evidence?.provider_calls || 0),
    provider_tokens: Number(evidence?.provider_tokens || 0) };
  if (!evidence || !['adverse', 'general', 'irrelevant'].includes(evidence.status)) {
    return { ...base, status: 'unresolved',
      reason: String(evidence?.reason || 'article_evidence_unavailable').slice(0, 160) };
  }
  const text = String(evidence.text || '');
  const quote = String(evidence.quote || '').trim();
  if (!quote || quote.length > 600 || !text.includes(quote) || evidence.url !== base.url
    || !['direct_actor', 'related_party', 'victim', 'namesake', 'context_only'].includes(evidence.subject_role)) {
    return { ...base, status: 'unresolved', reason: 'article_evidence_not_supported' };
  }
  if (evidence.status === 'adverse' && (evidence.subject_role !== 'direct_actor'
    || evidence.entity_match !== 'confirmed')) {
    return { ...base, status: 'unresolved', reason: 'direct_adverse_not_established' };
  }
  if (evidence.status === 'general' && evidence.entity_match !== 'confirmed') {
    return { ...base, status: 'unresolved', reason: 'subject_identity_not_established' };
  }
  if (evidence.status === 'irrelevant' && (evidence.entity_match !== 'excluded'
    || !['namesake', 'context_only'].includes(evidence.subject_role))) {
    return { ...base, status: 'unresolved', reason: 'exclusion_not_established' };
  }
  return { ...base, status: evidence.status, subject_role: evidence.subject_role,
    reason: String(evidence.reason || '').slice(0, 160), quote,
    canonical_url: String(evidence.canonical_url || '').slice(0, 2048),
    legal_stage: String(evidence.legal_stage || 'media_mention').slice(0, 50),
    evidence_digest: hash(text), adapter_version: String(evidence.adapter_version || '').slice(0, 80) };
}

async function countItems(store, ownerId, reviewId) {
  const counts = { unique_articles: 0, adverse: 0, unresolved: 0, general: 0, irrelevant: 0,
    provider_calls: 0, provider_tokens: 0 };
  const adverse_sample = [];
  let cursor = null;
  do {
    const page = await store.listArchiveReviewItems({ ownerId, reviewId, cursor, pageSize: 100 });
    for (const item of page.items) {
      counts.unique_articles += 1;
      counts.provider_calls += Number(item.provider_calls || 0);
      counts.provider_tokens += Number(item.provider_tokens || 0);
      if (!['adverse', 'general', 'irrelevant', 'unresolved'].includes(item.status)) {
        counts.unresolved += 1;
      } else counts[item.status] += 1;
      if (item.status === 'adverse' && adverse_sample.length < 20) adverse_sample.push(item);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { ...counts, adverse_sample };
}

// One queue delivery handles one bounded Azure page. The state is immutable to
// callers, owner scoped, and ETag guarded; duplicate deliveries can replay a
// page without writing duplicate article decisions.
export async function processArchiveReviewPage({ ownerId, request, store, snapshotResult,
  table, resolveArticle = async () => null, pageSize = 50, maxPostings = 200,
  clock = () => Date.now() }) {
  if (request.archive_all_stored !== true) throw new Error('archive_review_requires_all_stored');
  const baseline = snapshotResult || await searchLocalGdeltIndex(request);
  if (!baseline?.complete || baseline.scan?.mode !== 'v2_point_summary' || !baseline.state) {
    return { status: 'unavailable', reason: 'verified_v2_snapshot_required' };
  }
  if (!Number.isInteger(maxPostings) || maxPostings < 1
    || baseline.scan.mentions_indexed > maxPostings) {
    return { status: 'inconclusive', reason: 'archive_review_posting_budget',
      expected_postings: baseline.scan.mentions_indexed, unresolved: baseline.scan.mentions_indexed };
  }
  const reviewId = archiveReviewId(ownerId, request, baseline.state, resolveArticle.version || 'unavailable');
  let saved = await store.getArchiveReview({ ownerId, reviewId });
  if (!saved) {
    const initial = { review_id: reviewId, policy: ARCHIVE_REVIEW_POLICY, status: 'processing',
      snapshot: baseline.state, expected_postings: baseline.scan.mentions_indexed,
      cursor: { index: 0, token: null }, postings_scanned: 0, pages_scanned: 0,
      updated_at: new Date(clock()).toISOString() };
    try { saved = await store.saveArchiveReview({ ownerId, reviewId, state: initial }); }
    catch (error) { if (![409, 412].includes(error.statusCode)) throw error;
      saved = await store.getArchiveReview({ ownerId, reviewId }); }
  }
  if (saved.state.status !== 'processing') return saved.state;
  if (saved.state.snapshot.coverage_start !== baseline.state.coverage_start
    || saved.state.snapshot.coverage_end !== baseline.state.coverage_end
    || saved.state.snapshot.committed_intervals !== baseline.state.committed_intervals
    || saved.state.expected_postings !== baseline.scan.mentions_indexed) {
    throw new Error('archive_review_snapshot_changed');
  }
  if (saved.state.lease_until && saved.state.lease_until > clock()) {
    return { review_id: reviewId, status: 'busy' };
  }
  const leaseId = randomUUID();
  const claimed = await store.saveArchiveReview({ ownerId, reviewId, etag: saved.etag,
    state: { ...saved.state, lease_id: leaseId, lease_until: clock() + 10 * 60_000 } });
  const page = await pageLocalGdeltMentions(request, { state: baseline.state, cursor: claimed.state.cursor,
    pageSize, table });
  for (const row of page.rows) {
    const key = articleId(row);
    if (await store.getArchiveReviewItem({ ownerId, reviewId, articleId: key.id })) continue;
    let evidence = null;
    try { evidence = await resolveArticle(row, request); } catch { /* unresolved is the safe outcome */ }
    await store.saveArchiveReviewItem({ ownerId, reviewId, articleId: key.id,
      item: adjudicate(row, evidence) });
  }
  const next = { ...claimed.state, cursor: page.nextCursor,
    postings_scanned: claimed.state.postings_scanned + page.rows.length,
    pages_scanned: claimed.state.pages_scanned + 1,
    updated_at: new Date(clock()).toISOString(), lease_id: null, lease_until: null };
  if (page.done) {
    const counts = await countItems(store, ownerId, reviewId);
    Object.assign(next, counts);
    next.status = next.postings_scanned === next.expected_postings
      && counts.unique_articles <= next.postings_scanned && counts.unresolved === 0
      ? 'completed' : 'inconclusive';
    next.reason = next.postings_scanned !== next.expected_postings ? 'archive_posting_count_mismatch'
      : counts.unresolved ? 'archive_evidence_unresolved' : null;
  }
  return (await store.saveArchiveReview({ ownerId, reviewId, etag: claimed.etag, state: next })).state;
}
