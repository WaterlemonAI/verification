import { isIP } from 'node:net';

const ENDPOINT = 'https://analytics.eventregistry.org/api/v1/extractArticleInfo';
const VERSION = 'event-registry-extract-v1';
const MAX_RESPONSE_BYTES = 512_000;
const MAX_ARTICLE_CHARS = 32_000;

async function boundedBody(response) {
  if (Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) {
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
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('article_provider_response_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
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
