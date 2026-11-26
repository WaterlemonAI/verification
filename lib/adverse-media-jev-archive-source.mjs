import { canonicalAdvanceUrl } from './adverse-media-advance-evidence.mjs';
import { advanceTitleUrlCandidate } from './gdelt-archive-candidate.mjs';
import { createEventRegistryArticleResolver } from './gdelt-article-evidence-provider.mjs';
import { pageLocalGdeltMentions, searchLocalGdeltIndex } from './gdelt-local-index.mjs';

export class JevArchiveSourceError extends Error {
  constructor(code, status = 424) { super(code); this.name = 'JevArchiveSourceError'; this.status = status; }
}

export async function collectJevArchiveArticles(request, { eventRegistryApiKey, fetchImpl = fetch,
  archiveSearch = searchLocalGdeltIndex, archivePage = pageLocalGdeltMentions } = {}) {
  const archiveRequest = { name: request.subject.name, aliases: request.subject.aliases,
    entity_type: request.subject.entity_type,
    transliterations: request.subject.transliterations || {}, associations: [],
    archive_all_stored: true, date_to: request.date_to };
  let snapshot;
  try { snapshot = await archiveSearch(archiveRequest, { requireV2: true }); }
  catch { throw new JevArchiveSourceError('archive_v2_unavailable'); }
  if (!snapshot?.complete || snapshot.scan?.mode !== 'v2_point_summary'
    || !snapshot.state?.coverage_start || !snapshot.state?.coverage_end)
    throw new JevArchiveSourceError('archive_v2_unavailable');

  const startMs = Date.parse(`${request.date_from}T00:00:00.000Z`);
  const endMs = Date.parse(`${request.date_to}T23:59:59.999Z`);
  const coverageStartMs = Date.parse(snapshot.state.coverage_start);
  const coverageEndMs = Date.parse(snapshot.state.coverage_end);
  if (!Number.isFinite(coverageStartMs) || !Number.isFinite(coverageEndMs)
    || coverageStartMs > startMs || coverageEndMs + 15 * 60_000 <= endMs)
    throw new JevArchiveSourceError('archive_window_incomplete');
  const shortlisted = new Map();
  let cursor = null;
  let scanned = 0;
  let inPeriod = 0;
  let excluded = 0;
  let selectedPostings = 0;
  let pages = 0;
  for (;;) {
    if (scanned >= request.max_archive_postings || pages >= 30)
      throw new JevArchiveSourceError('archive_scan_limit_exceeded');
    let page;
    try { page = await archivePage(archiveRequest, { state: snapshot.state, cursor,
      pageSize: Math.min(100, request.max_archive_postings - scanned) }); }
    catch { throw new JevArchiveSourceError('archive_page_unavailable'); }
    if (!page || !Array.isArray(page.rows) || page.rows.length > request.max_archive_postings - scanned)
      throw new JevArchiveSourceError('archive_page_invalid');
    pages += 1;
    scanned += page.rows.length;
    for (const row of page.rows) {
      const publishedMs = Date.parse(String(row.publishedAt || ''));
      if (!Number.isFinite(publishedMs) || publishedMs < startMs || publishedMs > endMs) continue;
      inPeriod += 1;
      const selection = advanceTitleUrlCandidate(row, archiveRequest);
      if (!selection.selected) { excluded += 1; continue; }
      selectedPostings += 1;
      const url = canonicalAdvanceUrl(row.url);
      if (url && !shortlisted.has(url)) shortlisted.set(url, { ...row, url, selection });
      if (shortlisted.size > request.max_articles)
        throw new JevArchiveSourceError('archive_shortlist_exceeds_test_limit');
    }
    if (page.done) break;
    if (!page.nextCursor || JSON.stringify(page.nextCursor) === JSON.stringify(cursor))
      throw new JevArchiveSourceError('archive_cursor_invalid');
    cursor = page.nextCursor;
  }

  const resolve = createEventRegistryArticleResolver({ getApiKey: async () => eventRegistryApiKey,
    reviewArticle: async () => ({}), fetchImpl });
  const hits = [];
  let extractionCalls = 0;
  let bodies = 0;
  const extractionFailures = {};
  for (const row of shortlisted.values()) {
    const result = await resolve({ url: row.url, title: row.title,
      publisher: row.source }, archiveRequest);
    extractionCalls += Number(result.provider_calls || 0);
    if (result.text?.length >= 300) bodies += 1;
    else {
      const reason = result.reason || 'article_body_unavailable';
      extractionFailures[reason] = (extractionFailures[reason] || 0) + 1;
    }
    hits.push({ title: row.title, url: row.url, publisher: row.source,
      published_at: row.publishedAt, excerpt: '', text: result.text || '',
      sources: result.text ? ['gdelt_v2_archive', 'event_registry_extraction'] : ['gdelt_v2_archive'],
      provider_id: row.recordId || '',
      matched_name: row.selection.matched_name,
      matched_term_ids: row.selection.matched_terms,
      matched_categories: row.selection.matched_categories,
      extraction_status: result.text ? 'body_available' : result.reason || 'article_body_unavailable' });
  }
  return { hits, coverage: { status: 'completed', snapshot: snapshot.state,
    postings_scanned: scanned, postings_in_period: inPeriod, pages,
    excluded_by_name_or_terms: excluded, shortlisted_postings: selectedPostings,
    unique_shortlisted_urls: shortlisted.size, event_registry_calls: extractionCalls,
    event_registry_bodies: bodies, extraction_failures: extractionFailures,
    selector_version: advanceTitleUrlCandidate.version } };
}
