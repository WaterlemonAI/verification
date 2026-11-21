import { isIP } from 'node:net';

const ENDPOINT = 'https://analytics.eventregistry.org/api/v1/extractArticleInfo';
const BULK_ENDPOINT = 'https://eventregistry.org/api/v1/article/getArticles';
const VERSION = 'event-registry-extract-v1';
const MAX_RESPONSE_BYTES = 512_000;
const MAX_ARTICLE_CHARS = 32_000;
const MAX_BULK_RESPONSE_BYTES = 6_000_000;
const BULK_PAGE_SIZE = 100;
// Two recent pages reserve at most two article-search tokens. Historical
// search costs five tokens per year and would crowd out source/Gemini checks
// under the existing per-screening allowance; use per-URL extraction there.
const MAX_BULK_PAGES = 2;
const BULK_CACHE_MS = 60 * 60_000;
const bulkCache = new Map();

async function boundedBody(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (Number(response.headers.get('content-length') || 0) > maxBytes) {
    throw new Error('article_provider_response_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error('article_provider_response_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

function archiveDates(snapshot) {
  const start = String(snapshot?.coverage_start || '').slice(0, 10);
  const end = String(snapshot?.coverage_end || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)
    || start > end) return null;
  return { start, end };
}

async function bulkArticles(request, snapshot, key, fetchImpl) {
  const dates = archiveDates(snapshot);
  if (!dates || !request?.name) return null;
  if (Date.parse(`${dates.start}T00:00:00Z`) < Date.now() - 30 * 24 * 60 * 60_000) return null;
  const fingerprint = JSON.stringify([request.name, dates.start, dates.end]);
  const cached = bulkCache.get(fingerprint);
  if (cached?.expiresAt > Date.now()) return cached.promise;
  if (bulkCache.size >= 2) bulkCache.delete(bulkCache.keys().next().value);
  const promise = (async () => {
    const articles = new Map();
    for (let page = 1; page <= MAX_BULK_PAGES; page += 1) {
      let response;
      try { response = await fetchImpl(BULK_ENDPOINT, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: { $query: { $and: [
          { keyword: request.name, keywordSearchMode: 'phrase', keywordLoc: 'title,body' },
          { dateStart: dates.start, dateEnd: dates.end }
        ] }, $filter: { isDuplicate: 'keepAll', dataType: ['news', 'blog', 'pr'] } },
        resultType: 'articles', articlesSortBy: 'date', articlesPage: page,
        articlesCount: BULK_PAGE_SIZE, articleBodyLen: MAX_ARTICLE_CHARS,
        apiKey: key }), signal: AbortSignal.timeout(45_000) }); }
      catch (error) { if (articles.size) break; throw error; }
      if (!response.ok) {
        if (articles.size) break;
        throw new Error(`article_bulk_http_${response.status}`);
      }
      let payload;
      try { payload = JSON.parse(await boundedBody(response, MAX_BULK_RESPONSE_BYTES)); }
      catch (error) { if (articles.size) break; throw error; }
      if (!Array.isArray(payload?.articles?.results)) {
        if (articles.size) break;
        throw new Error('article_bulk_invalid_response');
      }
      for (const article of payload.articles.results) {
        const url = publicArticleUrl(article?.url);
        if (url && !articles.has(url.href)) articles.set(url.href, article);
      }
      const pages = Number(payload.articles.pages);
      if (!payload.articles.results.length || page >= pages) break;
    }
    return articles;
  })();
  bulkCache.set(fingerprint, { promise, expiresAt: Date.now() + BULK_CACHE_MS });
  try { return await promise; }
  catch { bulkCache.delete(fingerprint); return null; }
}

function publicArticleUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
      || !host.includes('.') || isIP(host) || host === 'localhost'
      || /(?:^|\.)(?:local|internal|localhost|test|example|invalid)$/.test(host)
      || url.href.length > 2048) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url;
  } catch { return null; }
}

function comparable(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function titleSimilarity(left, right) {
  const a = comparable(left);
  const b = comparable(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (text) => {
    const out = new Set();
    for (let index = 0; index < text.length - 1; index += 1) out.add(text.slice(index, index + 2));
    return out;
  };
  const first = grams(a);
  const second = grams(b);
  let overlap = 0;
  for (const gram of first) if (second.has(gram)) overlap += 1;
  return (2 * overlap) / (first.size + second.size || 1);
}

function samePublisher(left, right) {
  const host = (url) => url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  return host(left) === host(right);
}

function sameSyndicatedArticle(left, right) {
  const ids = (url) => new Set((url.pathname.match(/\d{7,}/g) || [])
    .filter((id) => !/^(?:19|20)\d{6}$/.test(id)));
  const sourceIds = ids(left);
  if ([...ids(right)].some((id) => sourceIds.has(id))) return true;
  const slug = (url) => comparable(url.pathname.split('/').filter(Boolean).at(-1) || '');
  const sourceSlug = slug(left);
  return sourceSlug.length >= 24 && sourceSlug === slug(right);
}

export function createEventRegistryArticleResolver({ getApiKey, reviewArticle, fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (typeof getApiKey !== 'function' || typeof reviewArticle !== 'function') {
    throw new TypeError('article_resolver_dependencies_required');
  }
  const resolve = async (row, request) => {
    const sourceUrl = publicArticleUrl(row?.url);
    if (!sourceUrl) return { reason: 'invalid_public_article_url', provider_calls: 0 };
    const key = await getApiKey();
    if (!key) return { reason: 'article_provider_not_configured', provider_calls: 0 };
    let providerCalls = 0;
    const fail = (reason) => ({ reason, provider_calls: providerCalls,
      provider_tokens: providerCalls * 0.05 });
    let data;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      providerCalls += 1;
      try {
        const response = await fetchImpl(ENDPOINT, { method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ url: sourceUrl.href, apiKey: key }), signal: AbortSignal.timeout(30_000) });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt === 0) {
            await sleep(1_000);
            continue;
          }
          return fail(`article_provider_http_${response.status}`);
        }
        const body = await boundedBody(response);
        data = JSON.parse(body);
        break;
      } catch (error) {
        if (error?.message === 'article_provider_response_too_large') {
          return fail('article_provider_response_too_large');
        }
        if (error?.message === 'screening_cost_limit') {
          providerCalls -= 1;
          return fail('article_cost_limit');
        }
        if (attempt === 0 && (error?.name === 'TimeoutError' || error?.name === 'TypeError')) {
          await sleep(1_000);
          continue;
        }
        return fail('article_provider_unavailable');
      }
    }
    if (data?.statusCode && Number(data.statusCode) !== 200) {
      return fail('article_provider_rejected_url');
    }
    const text = String(data?.body || '').trim();
    if (text.length < 300) return fail('article_body_unavailable');
    if (text.length > MAX_ARTICLE_CHARS) return fail('article_body_over_review_limit');
    const canonical = publicArticleUrl(data?.urlCanonical || data?.url);
    if (!canonical || canonical.pathname === '/') {
      return fail('article_canonical_unverified');
    }
    const similarity = titleSimilarity(row?.title, data?.title);
    if (similarity < 0.65) return fail('article_title_mismatch');
    if (!samePublisher(sourceUrl, canonical)
      && (similarity < 0.85 || !sameSyndicatedArticle(sourceUrl, canonical))) {
      return fail('article_syndication_unverified');
    }
    let reviewed;
    try {
      reviewed = await reviewArticle({ row, request, text, extractedTitle: data.title,
        canonicalUrl: canonical.href, publishedAt: data.datetime || data.date || null });
    } catch (error) {
      return fail(error?.message === 'screening_cost_limit' ? 'article_cost_limit'
        : 'article_review_unavailable');
    }
    return { ...reviewed, url: sourceUrl.href, text, canonical_url: canonical.href,
      provider_calls: providerCalls, provider_tokens: providerCalls * 0.05,
      adapter_version: VERSION };
  };
  resolve.version = VERSION;
  return resolve;
}

// Search returns up to 100 full bodies per provider call. Exact URL matches
// avoid paying extractArticleInfo for articles already in Event Registry's
// corpus; absent or invalid matches retain the existing per-URL fallback.
export function createEventRegistryBulkArticleResolver({ getApiKey, reviewArticle,
  fallback, fetchImpl = fetch }) {
  if (typeof getApiKey !== 'function' || typeof reviewArticle !== 'function'
    || typeof fallback !== 'function') throw new TypeError('bulk_article_resolver_dependencies_required');
  const resolve = async (row, request, snapshot) => {
    const sourceUrl = publicArticleUrl(row?.url);
    if (!sourceUrl) return fallback(row, request);
    const key = await getApiKey();
    if (!key) return fallback(row, request);
    const article = (await bulkArticles(request, snapshot, key, fetchImpl))?.get(sourceUrl.href);
    const body = String(article?.body || '').trim();
    // A body exactly at the requested limit may have been truncated by the
    // provider. Such text cannot support a complete article-level decision.
    if (!article || body.length < 300 || body.length >= MAX_ARTICLE_CHARS
      || titleSimilarity(row?.title, article?.title) < 0.65) return fallback(row, request);
    let reviewed;
    try {
      reviewed = await reviewArticle({ row, request, text: body,
        extractedTitle: article.title, canonicalUrl: sourceUrl.href,
        publishedAt: article.dateTimePub || article.dateTime || null });
    } catch (error) {
      return { reason: error?.message === 'screening_cost_limit'
        ? 'article_cost_limit' : 'article_review_unavailable' };
    }
    return { ...reviewed, url: sourceUrl.href, text: body,
      canonical_url: sourceUrl.href, provider_calls: 0, provider_tokens: 0,
      ...(article.eventUri ? { story_key: String(article.eventUri).slice(0, 160) } : {}),
      adapter_version: 'event-registry-bulk-v1' };
  };
  resolve.version = 'event-registry-bulk-v1+fallback-v1';
  return resolve;
}
