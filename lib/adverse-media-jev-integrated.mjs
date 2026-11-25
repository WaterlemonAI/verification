import { createHash } from 'node:crypto';
import { canonicalAdvanceUrl } from './adverse-media-advance-evidence.mjs';
import { ADVANCE_POLICY_IDS, ADVANCE_POLICY_CATALOG_VERSION } from './adverse-media-advance-policy-catalog.mjs';
import { collectJevArchiveArticles, JevArchiveSourceError } from './adverse-media-jev-archive-source.mjs';
import { advanceTitleUrlCandidate } from './gdelt-archive-candidate.mjs';
import { createEventRegistryArticleResolver } from './gdelt-article-evidence-provider.mjs';
import { groupJevIncidents } from './adverse-media-jev-incidents.mjs';
import { JevScreeningError, screenJevEventRegister } from './adverse-media-jev-screening.mjs';
import { validateSearchTransliterations } from './adverse-media-search-transliterations.mjs';

export const JEV_INTEGRATED_CONTRACT = 'advance-jev-integrated-test-v1';
const BRAVE_ORIGIN = 'https://api.search.brave.com';
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_ARTICLES = 40;
const MAX_BODY_CHARS = 32_000;
const MAX_JEV_RESERVED_USD = 0.15;
const MAX_SEARCH_EXTRACTION_ATTEMPTS = 5;
const TARGET_ARTICLE_BODIES = 3;
const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export class JevIntegratedError extends Error {
  constructor(code, status = 502) { super(code); this.name = 'JevIntegratedError'; this.status = status; }
}

function clean(value, max) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function validateJevIntegratedRequest(input, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['subject', 'adverse_profile', 'countries',
      'date_from', 'date_to', 'max_articles', 'max_archive_postings'].includes(key))
    || !input.subject || typeof input.subject !== 'object' || Array.isArray(input.subject)
    || Object.keys(input.subject).some((key) => !['name', 'entity_type', 'aliases', 'transliterations'].includes(key)))
    throw new JevIntegratedError('invalid_integrated_request', 400);
  const { name, entity_type = '', aliases = [] } = input.subject;
  if (typeof name !== 'string' || !name.trim() || name.length > 200
    || /[\u0000-\u001f]/.test(name)
    || !['', 'individual', 'business'].includes(entity_type)
    || !Array.isArray(aliases) || aliases.length > 3
    || aliases.some((item) => typeof item !== 'string' || !item.trim()
      || item.length > 200 || /[\u0000-\u001f]/.test(item))
    || new Set([name, ...aliases].map((item) => item.trim().toLocaleLowerCase())).size !== aliases.length + 1
    || input.adverse_profile !== 'all'
    || !Array.isArray(input.countries) || input.countries.length !== 0
    || (input.max_articles !== undefined && (!Number.isInteger(input.max_articles)
      || input.max_articles < 1 || input.max_articles > MAX_ARTICLES))
    || (input.max_archive_postings !== undefined && (!Number.isInteger(input.max_archive_postings)
      || input.max_archive_postings < 1 || input.max_archive_postings > 1_000)))
    throw new JevIntegratedError('invalid_integrated_request', 400);
  const to = input.date_to || now.toISOString().slice(0, 10);
  if (!validDate(to)) throw new JevIntegratedError('invalid_integrated_dates', 400);
  const from = input.date_from || new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000)
    .toISOString().slice(0, 10);
  if (!validDate(from) || !validDate(to) || from > to
    || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 30 * 86_400_000)
    throw new JevIntegratedError('invalid_integrated_dates', 400);
  let transliterations;
  try { transliterations = validateSearchTransliterations(input.subject.transliterations
    ?? { ar: [], hi: [] }); }
  catch { throw new JevIntegratedError('invalid_integrated_request', 400); }
  const subject = { name: name.trim(), entity_type,
    aliases: aliases.map((item) => item.trim()), transliterations };
  const query = [subject.name, ...subject.aliases].map((item) => `"${item.replaceAll('"', '')}"`).join(' OR ');
  if (query.length > 400) throw new JevIntegratedError('integrated_search_query_too_long', 400);
  const queries = [{ value: query, language: 'en' },
    ...Object.entries(transliterations).flatMap(([language, names]) =>
      names.map((value) => ({ value: `"${value}"`, language })))];
  return { subject, adverse_profile: 'all', countries: [], date_from: from,
    date_to: to, max_articles: input.max_articles || 8,
    max_archive_postings: input.max_archive_postings || 500, query, queries };
}

async function boundedJson(response, maxBytes) {
  if (Number(response.headers?.get?.('content-length') || 0) > maxBytes)
    throw new JevIntegratedError('integrated_source_response_too_large');
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new JevIntegratedError('integrated_source_response_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
  catch { throw new JevIntegratedError('integrated_source_invalid_response'); }
}

async function searchBrave(request, apiKey, kind, fetchImpl, searchQuery) {
  const url = new URL(kind === 'news' ? '/res/v1/news/search' : '/res/v1/web/search', BRAVE_ORIGIN);
  url.searchParams.set('q', searchQuery.value);
  url.searchParams.set('count', '20');
  url.searchParams.set('country', 'ALL');
  if (searchQuery.language === 'en') url.searchParams.set('search_lang', 'en');
  url.searchParams.set('safesearch', 'moderate');
  url.searchParams.set('extra_snippets', 'true');
  url.searchParams.set('freshness', `${request.date_from}to${request.date_to}`);
  let response;
  try { response = await fetchImpl(url, { headers: { accept: 'application/json',
    'x-subscription-token': apiKey }, signal: AbortSignal.timeout(20_000) }); }
  catch { throw new JevIntegratedError(`brave_${kind}_unavailable`); }
  if (!response.ok) throw new JevIntegratedError(`brave_${kind}_http_${response.status}`);
  const payload = await boundedJson(response, 2_000_000);
  const rows = kind === 'news' ? payload?.results ?? [] : payload?.web?.results ?? [];
  if (!Array.isArray(rows)) throw new JevIntegratedError(`brave_${kind}_invalid_response`);
  return rows.map((item) => ({ title: item.title, url: item.url,
    publisher: item.meta_url?.hostname || '',
    published_at: item.age || item.published || item.page_age || '',
    excerpt: item.description || item.extra_snippets?.[0] || '', text: '',
    source: `brave_${kind}`, provider_id: '' }));
}

function articleFromHit(hit) {
  const url = canonicalAdvanceUrl(hit.url);
  const title = clean(hit.title, 500);
  if (!url || !title) return null;
  const text = clean(hit.text, MAX_BODY_CHARS);
  const excerpt = clean(hit.excerpt, 2_000);
  return { story_key: `s-${createHash('sha256').update(url).digest('hex').slice(0, 32)}`,
    title, url, publisher: clean(hit.publisher, 200),
    published_at: clean(hit.published_at, 60), excerpt,
    text, sources: hit.sources || [hit.source],
    provider_ids: hit.provider_id ? [clean(hit.provider_id, 160)] : [],
    matched_name: hit.matched_name || '',
    matched_term_ids: hit.matched_term_ids || [],
    matched_categories: hit.matched_categories || [],
    extraction_status: hit.extraction_status || null,
    evidence_grade: text ? 'event_registry_body' : excerpt ? 'search_excerpt' : 'metadata_only' };
}

function nameInSearchTitleOrUrl(hit, subject) {
  const normalize = (value) => String(value || '').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const haystack = ` ${normalize(`${hit.title || ''} ${hit.url || ''}`)} `;
  return [subject.name, ...subject.aliases, ...Object.values(subject.transliterations || {}).flat()].some((name) => {
    const needle = normalize(name);
    return needle.length >= 3 && haystack.includes(` ${needle} `);
  });
}

function mergeHits(hits) {
  const byUrl = new Map();
  for (const hit of hits) {
    const item = articleFromHit(hit);
    if (!item) continue;
    const prior = byUrl.get(item.url);
    if (!prior) { byUrl.set(item.url, item); continue; }
    prior.sources = [...new Set([...prior.sources, ...item.sources])];
    prior.provider_ids = [...new Set([...prior.provider_ids, ...item.provider_ids])];
    prior.matched_name ||= item.matched_name;
    prior.matched_term_ids = [...new Set([...prior.matched_term_ids, ...item.matched_term_ids])];
    prior.matched_categories = [...new Set([...prior.matched_categories, ...item.matched_categories])];
    prior.extraction_status ||= item.extraction_status;
    if (item.text && (!prior.text || item.text.length > prior.text.length)) {
      prior.text = item.text;
      prior.excerpt = item.excerpt;
      prior.evidence_grade = item.evidence_grade;
    } else if (!prior.excerpt && item.excerpt) {
      prior.excerpt = item.excerpt;
      if (!prior.text) prior.evidence_grade = 'search_excerpt';
    }
  }
  return [...byUrl.values()];
}

function selectedArticles(archive, brave, count) {
  const all = mergeHits([...archive, ...brave]);
  const archiveUrls = new Set(archive.map((item) => canonicalAdvanceUrl(item.url)).filter(Boolean));
  const selected = [
    ...all.filter((item) => archiveUrls.has(item.url)),
    ...all.filter((item) => !archiveUrls.has(item.url))
  ].slice(0, count);
  return { selected, discovered: all.length,
    brave_unique: all.filter((item) => item.sources.some((source) => source.startsWith('brave_'))).length };
}

async function enrichSearchArticles(selected, request, eventRegistryApiKey, fetchImpl) {
  const resolve = createEventRegistryArticleResolver({ getApiKey: async () => eventRegistryApiKey,
    reviewArticle: async () => ({}), fetchImpl });
  const candidates = selected.filter((item) => !item.text
    && !item.sources.includes('gdelt_v2_archive'))
    .map((item, index) => ({ item, index,
      relevant: advanceTitleUrlCandidate(item, { name: request.subject.name,
        aliases: [...request.subject.aliases, ...Object.values(request.subject.transliterations || {}).flat()],
        entity_type: request.subject.entity_type }).selected ? 1 : 0 }))
    .sort((a, b) => b.relevant - a.relevant || a.index - b.index);
  let attempts = 0;
  let calls = 0;
  let bodies = selected.filter((item) => item.text.length >= 300).length;
  const failures = {};
  for (const { item } of candidates) {
    if (attempts >= MAX_SEARCH_EXTRACTION_ATTEMPTS || bodies >= TARGET_ARTICLE_BODIES) break;
    attempts += 1;
    const result = await resolve({ url: item.url, title: item.title, publisher: item.publisher }, request);
    calls += Number(result.provider_calls || 0);
    if (result.text?.length >= 300) {
      item.text = clean(result.text, MAX_BODY_CHARS);
      item.evidence_grade = 'event_registry_body';
      item.extraction_status = 'body_available';
      item.sources = [...new Set([...item.sources, 'event_registry_extraction'])];
      bodies += 1;
    } else {
      const reason = result.reason || 'article_body_unavailable';
      failures[reason] = (failures[reason] || 0) + 1;
    }
  }
  return { attempts, calls, bodies,
    body_selected: selected.filter((item) => item.sources.includes('event_registry_extraction')
      && item.text.length >= 300).length,
    failures };
}

function publicArticle(item, screening, incident, jevReview) {
  return { story_key: item.story_key, title: item.title, url: item.url,
    publisher: item.publisher, published_at: item.published_at,
    excerpt: item.excerpt, sources: item.sources, provider_ids: item.provider_ids,
    matched_name: item.matched_name, matched_term_ids: item.matched_term_ids,
    matched_categories: item.matched_categories, extraction_status: item.extraction_status,
    evidence_grade: item.evidence_grade, text_characters: item.text.length,
    text_sha256: item.text ? createHash('sha256').update(item.text).digest('hex') : null,
    adverseness: screening.adverseness, relationship: screening.relationship,
    jev_review: jevReview || null,
    incident_id: incident?.incident_id || null,
    incident_label: incident?.incident_label || null,
    incident_status: incident?.group_status || 'unassigned',
    incident_reason: incident?.reason || (screening.adverseness === 'non-adverse'
      ? 'not_an_adverse_incident' : screening.adverseness === 'inconclusive'
        ? 'adverseness_inconclusive' : null) };
}

export async function runJevIntegratedTest(input, { braveApiKey, eventRegistryApiKey,
  jevApiKey, fetchImpl = fetch, now = new Date(), archiveSearch, archivePage } = {}) {
  const request = validateJevIntegratedRequest(input, now);
  if (!braveApiKey || !eventRegistryApiKey || !jevApiKey)
    throw new JevIntegratedError('integrated_provider_credentials_unavailable', 503);
  let archive;
  try { archive = await collectJevArchiveArticles(request, { eventRegistryApiKey, fetchImpl,
    archiveSearch, archivePage }); }
  catch (error) {
    if (error instanceof JevArchiveSourceError) throw new JevIntegratedError(error.message, error.status);
    throw error;
  }
  const searchResults = await Promise.all(request.queries.flatMap((query) => [
    searchBrave(request, braveApiKey, 'news', fetchImpl, query),
    searchBrave(request, braveApiKey, 'web', fetchImpl, query)
  ]));
  const news = searchResults.filter((_, index) => index % 2 === 0).flat();
  const web = searchResults.filter((_, index) => index % 2 === 1).flat();
  const namedSearchHits = [...news, ...web].filter((hit) => nameInSearchTitleOrUrl(hit, request.subject));
  const { selected, discovered, brave_unique } = selectedArticles(archive.hits,
    namedSearchHits, request.max_articles);
  const searchExtraction = await enrichSearchArticles(selected, request,
    eventRegistryApiKey, fetchImpl);
  if (selected.length && !selected.some((item) => item.sources.includes('event_registry_extraction')
    && item.text.length >= 300))
    throw new JevIntegratedError('event_registry_no_article_body', 424);

  let jevCalls = 0;
  let reservedBytes = 0;
  const screeningReviews = new Map();
  const jevFetch = async (url, options) => {
    if (String(url) !== JEV_URL) throw new JevIntegratedError('unexpected_jev_url');
    const bytes = Buffer.byteLength(options.body || '');
    if ((reservedBytes + bytes) * JEV_USD_PER_INPUT_TOKEN > MAX_JEV_RESERVED_USD)
      throw new JevScreeningError('jev_integrated_budget_exceeded');
    reservedBytes += bytes;
    jevCalls += 1;
    const response = await fetchImpl(url, options);
    if (response.ok) {
      const requestBody = JSON.parse(options.body);
      if (requestBody.questions.subject_association) {
        const answer = await response.clone().json();
        screeningReviews.set(requestBody.state.article.story_key, {
          association_probability: answer.answers?.subject_association?.noul ?? null,
          adverseness_probabilities: answer.answers?.adverseness?.probabilities || null,
          relationship_probabilities: answer.answers?.relationship?.probabilities || null
        });
      }
    }
    return response;
  };
  const subject = request.subject;
  const screened = selected.length
    ? await screenJevEventRegister({ subject, articles: selected },
      { apiKey: jevApiKey, fetchImpl: jevFetch })
    : { redundant: [], event_register: { articles: [] } };
  const redundantKeys = new Set(screened.redundant.map((item) => item.story_key));
  const retained = selected.filter((item) => !redundantKeys.has(item.story_key));
  const screeningByKey = new Map(screened.event_register.articles.map((item) => [item.story_key, item]));
  const adverseForGrouping = retained.filter((item) =>
    screeningByKey.get(item.story_key)?.adverseness === 'adverse');
  const grouped = adverseForGrouping.length
    ? await groupJevIncidents({ subject, articles: adverseForGrouping }, { apiKey: jevApiKey, fetchImpl: jevFetch })
    : null;
  const incidentByKey = new Map((grouped?.event_register.articles || []).map((item) => [item.story_key, item]));
  const eventRegister = retained.map((item) => publicArticle(item, screeningByKey.get(item.story_key),
    incidentByKey.get(item.story_key), screeningReviews.get(item.story_key)));
  return { contract: JEV_INTEGRATED_CONTRACT, subject, adverse_profile: 'all',
    search_names: { primary: subject.name, aliases: [...subject.aliases],
      transliterations: subject.transliterations },
    policy_catalog_version: ADVANCE_POLICY_CATALOG_VERSION,
    policy_ids: [...ADVANCE_POLICY_IDS],
    policy_evaluation_status: 'not_run',
    period: { from: request.date_from, to: request.date_to },
    coverage: { archive: archive.coverage,
    event_registry: { status: 'completed',
      calls: archive.coverage.event_registry_calls + searchExtraction.calls,
      body_available: searchExtraction.body_selected,
      search_url_attempts: searchExtraction.attempts,
      search_url_calls: searchExtraction.calls,
      search_url_failures: searchExtraction.failures,
      selected: selected.filter((item) => item.sources.includes('event_registry_extraction')).length,
      body_selected: selected.filter((item) => item.sources.includes('event_registry_extraction')
        && item.text.length >= 300).length,
      retained: eventRegister.filter((item) => item.sources.includes('event_registry_extraction')).length },
    brave: { status: 'completed', news_returned: news.length, web_returned: web.length,
      name_matched: namedSearchHits.length, unique: brave_unique,
      selected: selected.filter((item) => item.sources.some((source) => source.startsWith('brave_'))).length },
    unique_discovered: discovered, reviewed: selected.length,
    adverse_grouping_candidates: adverseForGrouping.length,
    omitted_due_to_test_limit: Math.max(0, discovered - selected.length) },
    event_register: { articles: eventRegister, incidents: grouped?.incidents || [] },
    incident_review: { eligibility_reviews: grouped?.eligibility_reviews || [],
      pair_reviews: grouped?.pair_reviews || [],
      unmerged_same_pairs: grouped?.unmerged_same_pairs || [],
      grouping_warnings: grouped?.grouping_warnings || [] },
    redundant: selected.filter((item) => redundantKeys.has(item.story_key)).map((item) => ({
      story_key: item.story_key, title: item.title, url: item.url, sources: item.sources,
      tag: 'redundant', jev_review: screeningReviews.get(item.story_key) || null })),
    usage: { event_registry_calls: archive.coverage.event_registry_calls + searchExtraction.calls,
      brave_calls: request.queries.length * 2, jev_calls: jevCalls,
      jev_input_bytes_reserved: reservedBytes,
      jev_cost_upper_bound_usd: Number((reservedBytes * JEV_USD_PER_INPUT_TOKEN).toFixed(6)),
      jev_cost_cap_usd: MAX_JEV_RESERVED_USD },
    report_generated: false };
}
