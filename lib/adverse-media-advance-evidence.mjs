import { createHash } from 'node:crypto';
import { ADVANCE_LEXICON_VERSION, matchAdvanceTitleUrl } from './adverse-media-advance-lexicon.mjs';

function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }

export function canonicalAdvanceUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return ''; }
}

function compact(value, max) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeAdvanceEvidence(response, archiveItems = []) {
  const buckets = response.media_buckets || {};
  const rawBrave = Array.isArray(response.advance_source_results);
  const searchItems = rawBrave ? response.advance_source_results : [
    ...(response.results || []),
    ...(buckets.adverse_media || []),
    ...(buckets.general_news_mentions || []),
    ...(buckets.no_impact_media || [])
  ];
  const items = new Map();
  const add = (item, source) => {
    const rawUrl = compact(item.url || item.canonical_url, 2048);
    const url = canonicalAdvanceUrl(rawUrl);
    const key = url || `invalid:${hash(`${rawUrl}|${item.title || ''}`)}`;
    const prior = items.get(key);
    const archive = source === 'kycprobe_entity_map';
    const signal = archive ? null : rawBrave ? matchAdvanceTitleUrl({ title: item.title, url: rawUrl }) : null;
    const sourceLabels = archive ? [source] : item.source_types || [item.source_type || source];
    const selectionStatus = archive
      ? item.selection_status || (item.status === 'metadata_excluded' ? 'not_selected' : 'selected')
      : rawBrave ? signal.selected ? 'selected' : 'not_selected' : item.selection_status || 'selected';
    const selected = selectionStatus === 'selected' || prior?.selection_status === 'selected';
    const selectionReason = archive ? item.selection_source || item.reason || ''
      : rawBrave ? signal.selected ? 'adverse_title_url_signal' : 'no_adverse_title_url_signal'
        : item.selection_reason || '';
    const matches = [...new Set([...(prior?.matched_term_ids || []),
      ...(archive ? item.matched_term_ids || [] : signal?.matches.map((match) => match.term_id) || [])])];
    const categories = [...new Set([...(prior?.matched_categories || []),
      ...(archive ? item.matched_categories || [] : signal?.matches.map((match) => match.category) || [])])];
    const excerpt = compact(archive ? item.quote || prior?.excerpt : prior?.archive_status
      ? prior.excerpt : item.excerpt || prior?.excerpt, 1200);
    items.set(key, {
      story_key: `s-${hash(key).slice(0, 32)}`,
      result_id: compact(prior?.result_id || item.result_id || item.record_id, 160) || `r-${hash(key).slice(0, 32)}`,
      url: url || rawUrl, canonical_url: url || null,
      title: compact(selectionStatus === 'selected' || !prior?.title ? item.title || prior?.title
        : prior.title, 500),
      publisher: compact(item.publisher || prior?.publisher, 200),
      published_at: compact(item.published_at || prior?.published_at, 60),
      excerpt, evidence_grade: archive && item.quote ? 'verified_archive_quote'
        : prior?.evidence_grade === 'verified_archive_quote' ? 'verified_archive_quote'
          : excerpt ? 'search_excerpt' : 'metadata_only',
      sources: [...new Set([...(prior?.sources || []), ...sourceLabels])],
      search_call_ids: [...new Set([...(prior?.search_call_ids || []), ...(item.search_call_ids || [])])],
      archive_status: archive ? item.status : prior?.archive_status || null,
      archive_reason: archive ? compact(item.reason, 160) : prior?.archive_reason || '',
      identity_match: prior?.identity_match || item.identity_match || null,
      evidence_assessment: compact(prior?.evidence_assessment || item.evidence_assessment, 500),
      matched_name: archive ? compact(item.matched_name, 200) : prior?.matched_name || '',
      subject_role: archive ? item.subject_role || prior?.subject_role || ''
        : prior?.subject_role || item.subject_role || '',
      media_bucket: prior?.media_bucket || item.media_bucket || '',
      selection_status: selected ? 'selected' : 'not_selected',
      selection_reason: selectionStatus === 'selected' ? selectionReason
        : prior?.selection_status === 'selected' ? prior.selection_reason : selectionReason,
      lexicon_version: ADVANCE_LEXICON_VERSION,
      matched_term_ids: matches, matched_categories: categories,
      legal_stage: archive ? item.legal_stage || prior?.legal_stage || ''
        : prior?.legal_stage || item.legal_stage || ''
    });
  };
  for (const item of searchItems) add(item, item.source_type || 'brave_search');
  for (const item of archiveItems) add(item, 'kycprobe_entity_map');
  const merged = [...items.values()];
  return { items: merged, counts: {
    search_returned: searchItems.length,
    search_results: new Set(searchItems.map((item) => canonicalAdvanceUrl(item.url)).filter(Boolean)).size,
    archive_decisions: archiveItems.length,
    unique_urls: merged.length,
    selected_candidates: merged.filter((item) => item.selection_status === 'selected').length,
    metadata_excluded: merged.filter((item) => item.selection_status === 'not_selected').length,
    invalid_urls: merged.filter((item) => !item.canonical_url).length,
    overlap_urls: merged.filter((item) => item.sources.includes('kycprobe_entity_map')
      && item.sources.some((source) => source !== 'kycprobe_entity_map')).length,
    missing_article_evidence: merged.filter((item) => item.selection_status === 'selected' && !item.excerpt).length,
    archive_not_selected: archiveItems.filter((item) => item.selection_status === 'not_selected').length
  } };
}
