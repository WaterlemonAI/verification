import { createHash, randomUUID } from 'node:crypto';
import { pageLocalGdeltMentions, searchLocalGdeltIndex } from './gdelt-local-index.mjs';

export const ARCHIVE_REVIEW_POLICY = 'gdelt-archive-review-v2';
export const SUFFICIENT_ADVERSE_ARTICLES = 10;
const hash = (value) => createHash('sha256').update(value).digest('hex');

function storyKey(row) {
  // Syndicated copies of the same headline cannot fill the evidence threshold.
  // A missing or generic title falls back to the canonicalized article URL.
  const title = String(row.title || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  return hash(title.length >= 20 ? `title:${title}` : `url:${articleId(row).url || row.recordId || ''}`);
}

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
    ...(evidence.status === 'adverse' ? {
      story_key: evidence.story_key ? hash(`event:${evidence.story_key}`) : storyKey(row)
    } : {}),
    canonical_url: String(evidence.canonical_url || '').slice(0, 2048),
    legal_stage: String(evidence.legal_stage || 'media_mention').slice(0, 50),
    evidence_digest: hash(text), adapter_version: String(evidence.adapter_version || '').slice(0, 80) };
}

async function countItems(store, ownerId, reviewId) {
  const counts = { unique_articles: 0, adverse: 0, adverse_articles: 0,
    unresolved: 0, general: 0, irrelevant: 0,
    provider_calls: 0, provider_tokens: 0 };
  const adverse_sample = [];
  const adverseStoryKeys = new Set();
  let cursor = null;
  do {
    const page = await store.listArchiveReviewItems({ ownerId, reviewId, cursor, pageSize: 100 });
    for (const item of page.items) {
      counts.unique_articles += 1;
      counts.provider_calls += Number(item.provider_calls || 0);
      counts.provider_tokens += Number(item.provider_tokens || 0);
      if (!['adverse', 'general', 'irrelevant', 'unresolved'].includes(item.status)) {
        counts.unresolved += 1;
      } else if (item.status === 'adverse') {
        counts.adverse_articles += 1;
        const key = item.story_key || hash(`url:${item.canonical_url || item.url || item.record_id}`);
        if (!adverseStoryKeys.has(key)) {
          adverseStoryKeys.add(key);
          counts.adverse += 1;
          if (adverse_sample.length < 20) adverse_sample.push(item);
        }
      } else counts[item.status] += 1;
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { ...counts, adverse_sample, adverse_story_keys: [...adverseStoryKeys] };
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
  if (!Number.isInteger(maxPostings) || maxPostings < 1) throw new Error('invalid_archive_review_posting_limit');
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
  if (saved.state.postings_scanned >= maxPostings) {
    const counts = await countItems(store, ownerId, reviewId);
    return (await store.saveArchiveReview({ ownerId, reviewId, etag: saved.etag,
      state: { ...saved.state, ...counts, status: 'inconclusive',
        reason: 'archive_review_posting_budget',
        unscanned_postings: Math.max(0, saved.state.expected_postings - saved.state.postings_scanned) } })).state;
  }
  // An interrupted page is replayed in order. Existing article decisions are
  // read from the ledger without another paid call, then the threshold is
  // reconstructed at the exact posting where it was first reached.
  const adverseStoryKeys = new Set(saved.state.adverse_story_keys || []);
  const leaseId = randomUUID();
  const claimed = await store.saveArchiveReview({ ownerId, reviewId, etag: saved.etag,
    state: { ...saved.state, lease_id: leaseId, lease_until: clock() + 10 * 60_000 } });
  const page = await pageLocalGdeltMentions(request, { state: baseline.state, cursor: claimed.state.cursor,
    pageSize: Math.min(pageSize, maxPostings - saved.state.postings_scanned), table });
  let processed = 0;
  let sufficient = adverseStoryKeys.size >= SUFFICIENT_ADVERSE_ARTICLES;
  for (const row of page.rows) {
    if (sufficient) break;
    const key = articleId(row);
    const existing = await store.getArchiveReviewItem({ ownerId, reviewId, articleId: key.id });
    if (existing) {
      processed += 1;
      if (existing.status === 'adverse') adverseStoryKeys.add(existing.story_key
        || hash(`url:${existing.canonical_url || existing.url || existing.record_id}`));
      sufficient = adverseStoryKeys.size >= SUFFICIENT_ADVERSE_ARTICLES;
      continue;
    }
    let evidence = null;
    // Claim before dialing a paid provider. A crash between the response and
    // the decision write leaves this article unresolved rather than buying it
    // again when the page is replayed.
    const claimed = await store.claimArchiveReviewArticleCall({ ownerId, reviewId, articleId: key.id });
    if (claimed) {
      try { evidence = await resolveArticle(row, request, baseline.state); } catch { /* unresolved is the safe outcome */ }
    } else evidence = { reason: 'article_review_interrupted', provider_calls: 0 };
    const item = adjudicate(row, evidence);
    await store.saveArchiveReviewItem({ ownerId, reviewId, articleId: key.id, item });
    processed += 1;
    if (item.status === 'adverse') adverseStoryKeys.add(item.story_key);
    sufficient = adverseStoryKeys.size >= SUFFICIENT_ADVERSE_ARTICLES;
  }
  const next = { ...claimed.state, cursor: sufficient ? claimed.state.cursor : page.nextCursor,
    postings_scanned: claimed.state.postings_scanned + processed,
    pages_scanned: claimed.state.pages_scanned + 1,
    adverse_story_keys: [...adverseStoryKeys],
    updated_at: new Date(clock()).toISOString(), lease_id: null, lease_until: null };
  if (sufficient || page.done || next.postings_scanned >= maxPostings) {
    const counts = await countItems(store, ownerId, reviewId);
    Object.assign(next, counts);
    if (sufficient && counts.adverse >= SUFFICIENT_ADVERSE_ARTICLES) {
      next.status = 'sufficient_adverse_media_found';
      next.reason = 'ten_distinct_adverse_articles';
      next.unscanned_postings = Math.max(0, next.expected_postings - next.postings_scanned);
    } else if (next.postings_scanned >= maxPostings && next.postings_scanned < next.expected_postings) {
      next.status = 'inconclusive';
      next.reason = 'archive_review_posting_budget';
      next.unscanned_postings = next.expected_postings - next.postings_scanned;
    } else {
      next.status = next.postings_scanned === next.expected_postings
        && counts.unique_articles <= next.postings_scanned && counts.unresolved === 0
        ? 'completed' : 'inconclusive';
      next.reason = next.postings_scanned !== next.expected_postings ? 'archive_posting_count_mismatch'
        : counts.unresolved ? 'archive_evidence_unresolved' : null;
    }
  }
  return (await store.saveArchiveReview({ ownerId, reviewId, etag: claimed.etag, state: next })).state;
}
