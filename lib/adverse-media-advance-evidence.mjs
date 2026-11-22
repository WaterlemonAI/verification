// Normalize the bounded search results and the paged archive evidence ledger
// before Advance-specific AI7 EDD classification. Raw article bodies remain
// with the extraction step; only supported quotes and source metadata travel.
import { createHash } from 'node:crypto';

function canonical(value) {
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
  const searchItems = [
    ...(response.results || []),
    ...(buckets.adverse_media || []).map((item) => ({ ...item, media_bucket: 'adverse_media' })),
    ...(buckets.general_news_mentions || []).map((item) => ({ ...item, media_bucket: 'general_news_mentions' })),
    ...(buckets.no_impact_media || []).map((item) => ({ ...item, media_bucket: 'no_impact_media' }))
  ];
  const items = new Map();
  const add = (item, source) => {
    const url = canonical(item.url || item.canonical_url);
    if (!url) return;
    const prior = items.get(url);
    const sources = [...new Set([...(prior?.sources || []),
      ...(source === 'kycprobe_entity_map' ? [source] : item.source_types || [source])])];
    const archiveStatus = source === 'kycprobe_entity_map' ? item.status : prior?.archive_status || null;
    items.set(url, {
      story_key: `s-${createHash('sha256').update(`${url}|${compact(item.title || prior?.title, 500)}`).digest('hex').slice(0, 32)}`,
      url, title: compact(item.title || prior?.title, 500),
      publisher: compact(item.publisher || prior?.publisher, 200),
      published_at: compact(item.published_at || prior?.published_at, 60),
      excerpt: compact(source === 'kycprobe_entity_map'
        ? item.quote || prior?.excerpt : item.excerpt || prior?.excerpt, 1200),
      sources, search_call_ids: [...new Set([...(prior?.search_call_ids || []),
        ...(item.search_call_ids || [])])], archive_status: archiveStatus,
      archive_reason: source === 'kycprobe_entity_map' ? compact(item.reason, 160)
        : prior?.archive_reason || '',
      result_id: compact(prior?.result_id || item.result_id || item.record_id, 160),
      identity_match: prior?.identity_match || item.identity_match || null,
      evidence_assessment: compact(prior?.evidence_assessment || item.evidence_assessment, 500),
      matched_name: source === 'kycprobe_entity_map' ? compact(item.matched_name, 200)
        : prior?.matched_name || '',
      subject_role: source === 'kycprobe_entity_map' ? item.subject_role || prior?.subject_role || ''
        : prior?.subject_role || item.subject_role || '',
      media_bucket: prior?.media_bucket || item.media_bucket || '',
      selection_status: source === 'kycprobe_entity_map' ? item.selection_status || ''
        : prior?.selection_status || '',
      legal_stage: source === 'kycprobe_entity_map' ? item.legal_stage || prior?.legal_stage || ''
        : prior?.legal_stage || item.legal_stage || ''
    });
  };
  for (const item of searchItems) add(item, item.source_type || 'brave_search');
  for (const item of archiveItems) add(item, 'kycprobe_entity_map');
  const merged = [...items.values()];
  return { items: merged, counts: {
    search_results: new Set(searchItems.map((item) => canonical(item.url)).filter(Boolean)).size,
    archive_decisions: archiveItems.length,
    unique_urls: merged.length,
    overlap_urls: merged.filter((item) => item.sources.length > 1).length,
    missing_article_evidence: merged.filter((item) => !item.excerpt).length,
    archive_not_selected: archiveItems.filter((item) => item.selection_status === 'not_selected').length
  } };
}
