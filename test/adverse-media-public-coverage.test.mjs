import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { approvedPublisherCount, approvedPublisherCoverage, approvedSearchablePublisherCount } = await import('../lib/approved-publishers.mjs');
const { globalArchiveSearch, presentAdverseMediaResponse, screenAdverseMedia,
  validateAdverseMediaRequest, normalizedResult } = await import('../lib/adverse-media.mjs');
const catalog = JSON.parse(await readFile(new URL('../api-site/adverse-media-publisher-catalog.json', import.meta.url), 'utf8'));
const page = await readFile(new URL('../api-site/adverse-media-coverage.html', import.meta.url), 'utf8');

test('public coverage document and downloadable catalog match the executable publisher map', () => {
  assert.equal(catalog.market_count, approvedPublisherCoverage.length);
  assert.equal(catalog.unique_publisher_count, approvedPublisherCount);
  assert.equal(catalog.unique_searchable_publisher_count, approvedSearchablePublisherCount);
  const table = page.match(/<table class="coverage-table market-table">([\s\S]*?)<\/table>/)?.[1];
  assert.ok(table);
  const rows = [...table.matchAll(/<tr><td>(.*?)<\/td><td>([A-Z]{2})<\/td><td>(\d+)<\/td><td>(\d+)<\/td><\/tr>/g)];
  assert.equal(rows.length, approvedPublisherCoverage.length);
  for (const market of approvedPublisherCoverage) {
    const row = rows.find((item) => item[2] === market.country_code);
    const publicMarket = catalog.markets.find((item) => item.country_code === market.country_code);
    assert.ok(row && publicMarket, market.country_code);
    assert.equal(Number(row[3]), market.catalog_publishers);
    assert.equal(Number(row[4]), market.searchable_publishers);
    assert.equal(publicMarket.publishers.length, market.catalog_publishers);
    assert.equal(publicMarket.publishers.filter((item) => item.targeted_search_eligible).length, market.searchable_publishers);
  }
  assert.doesNotMatch(`${page}\n${JSON.stringify(catalog)}`, /brave|gdelt|gemini|openai|\bgpt\b/i);
  assert.match(page, /adverse-media-publisher-catalog\.json/);
});

test('historical fallback remains available when the local index read throws', async () => {
  let fallbackCalls = 0;
  const result = await globalArchiveSearch({ name: 'Synthetic Example', aliases: [], countries: [], languages: ['en'] },
    async () => {
      fallbackCalls += 1;
      return { ok: true, json: async () => ({ articles: [] }) };
    },
    async () => { throw new Error('local_index_read_failed'); });
  assert.equal(fallbackCalls, 1);
  assert.equal(result.complete, true);
  assert.equal(result.origin, 'hosted');
});

test('both historical paths failing return partial after three public attempts', async () => {
  let attempts = 0;
  const result = await globalArchiveSearch({ name: 'Synthetic Example', aliases: [], countries: [], languages: ['en'] },
    async () => { attempts += 1; return { ok: false, status: 503, headers: { get: () => null } }; },
    async () => { throw new Error('local_index_read_failed'); });
  assert.equal(attempts, 3);
  assert.equal(result.hostedAttempts, 3);
  assert.equal(result.complete, false);
  assert.equal(result.localFailure, 'public_archive_incomplete');
});

test('public fallback requests only the gap after Azure and preserves indexed evidence', async () => {
  const request = validateAdverseMediaRequest({ entity_type: 'business', name: 'Example Group',
    date_from: '2026-10-01', date_to: '2026-11-18' });
  const urls = [];
  const result = await globalArchiveSearch(request, async (url) => {
    urls.push(new URL(url));
    return Response.json({ articles: [] });
  }, async () => ({ results: [{ title: 'Example Group investigation', url: 'https://news.example/one' }],
    complete: false, state: { coverage_start: '2026-10-22T21:15:00Z', coverage_end: '2026-11-19T01:30:00Z' } }));
  assert.equal(result.complete, true);
  assert.equal(result.results.length, 1);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get('startdatetime'), '20261001000000');
  assert.equal(urls[0].searchParams.get('enddatetime'), '20261022211500');
  assert.equal(urls[0].searchParams.get('timespan'), null);
});

test('third direct DOC attempt succeeds before final archive result', async () => {
  const request = validateAdverseMediaRequest({ entity_type: 'business', name: 'Example Group',
    date_from: '2026-10-01', date_to: '2026-11-18' });
  let calls = 0;
  const result = await globalArchiveSearch(request, async (input) => {
    calls += 1;
    assert.equal(new URL(input).pathname, '/api/v2/doc/doc');
    return calls < 3 ? Response.json({ error: 'busy' }, { status: 503 })
      : Response.json({ articles: [{ title: 'Example Group fined', url: 'https://news.example/fined',
        seendate: '20261118T010000Z' }] });
  }, async () => null);
  assert.equal(calls, 3);
  assert.equal(result.complete, true);
  assert.equal(result.hostedAttempts, 3);
  assert.equal(result.results.length, 1);
  assert.equal(result.publicWindows[0].status, 'complete');
});

test('public result cap cannot claim complete archive coverage', async () => {
  const result = await globalArchiveSearch(validateAdverseMediaRequest({ entity_type: 'business', name: 'Example Group',
    date_from: '2026-10-01', date_to: '2026-11-18' }), async () => Response.json({
    articles: Array.from({ length: 250 }, (_, index) => ({ title: `Article ${index}`, url: `https://example.org/${index}`,
      seendate: '20261118T010000Z' }))
  }), async () => null);
  assert.equal(result.complete, false);
  assert.equal(result.hostedAttempts, 1);
});

test('Azure-only mode retains available history without calling public GDELT', async () => {
  const previous = process.env.GDELT_PUBLIC_FALLBACK_ENABLED;
  process.env.GDELT_PUBLIC_FALLBACK_ENABLED = 'false';
  try {
    const request = validateAdverseMediaRequest({ entity_type: 'business', name: 'Example Group' });
    let publicCalls = 0;
    const localSearch = async () => ({
      results: [{ title: 'Example Group faces fraud investigation', url: 'https://example.com/story' }],
      complete: false,
      state: { coverage_start: '2026-10-22T21:15:00Z', coverage_end: '2026-11-18T01:30:00Z' }
    });
    const result = await globalArchiveSearch(request, async () => { publicCalls += 1; throw new Error('unexpected_public_call'); }, localSearch);
    assert.equal(publicCalls, 0);
    assert.equal(result.results.length, 1);
    assert.equal(result.complete, false);
    assert.equal(result.origin, 'local_partial');
    assert.equal(result.localFailure, 'requested_window_not_covered');
    assert.equal(result.hostedAttempts, 0);

    const screened = await screenAdverseMedia({ request, apiKey: 'test', fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.hostname === 'api.search.brave.com') return Response.json(url.pathname.includes('/news/')
        ? { results: [] } : { web: { results: [] } });
      publicCalls += 1;
      throw new Error('unexpected_public_call');
    } });
    const presented = presentAdverseMediaResponse(screened);
    assert.equal(publicCalls, 0);
    assert.equal(presented.status, 'partial');
    assert.equal(presented.coverage.archive_scope, 'all_stored_history');
    assert.equal(presented.summary.decision_eligible, false);
    assert.equal(presented.coverage.archive_reason_code, 'watermark_unavailable');
    assert.ok(presented.coverage.reason_codes.includes('archive_unavailable'));
  } finally {
    if (previous === undefined) delete process.env.GDELT_PUBLIC_FALLBACK_ENABLED;
    else process.env.GDELT_PUBLIC_FALLBACK_ENABLED = previous;
  }
});

test('Azure-only mode reports an internal index read failure without public fallback', async () => {
  const previous = process.env.GDELT_PUBLIC_FALLBACK_ENABLED;
  process.env.GDELT_PUBLIC_FALLBACK_ENABLED = 'false';
  try {
    const result = await globalArchiveSearch({ name: 'Example Group' },
      async () => { throw new Error('unexpected_public_call'); },
      async () => { throw new Error('local_index_read_failed'); });
    assert.equal(result.complete, false);
    assert.equal(result.hostedAttempts, 0);
    assert.equal(result.localFailure, 'read_failed');
  } finally {
    if (previous === undefined) delete process.env.GDELT_PUBLIC_FALLBACK_ENABLED;
    else process.env.GDELT_PUBLIC_FALLBACK_ENABLED = previous;
  }
});

test('Azure scan limit is surfaced as partial without a public GDELT call', async () => {
  const previous = process.env.GDELT_PUBLIC_FALLBACK_ENABLED;
  process.env.GDELT_PUBLIC_FALLBACK_ENABLED = 'false';
  try {
    let publicCalls = 0;
    const result = await globalArchiveSearch({ name: 'Example Group' },
      async () => { publicCalls += 1; throw new Error('unexpected_public_call'); },
      async () => ({ results: [], complete: false, limitReason: 'scan_row_limit_exceeded',
        scan: { rows_scanned: 100000, rows_returned: 0, truncated: true },
        state: { coverage_start: '2026-10-22T21:15:00Z', coverage_end: '2026-11-19T01:30:00Z' } }));
    assert.equal(publicCalls, 0);
    assert.equal(result.complete, false);
    assert.equal(result.localFailure, 'scan_row_limit_exceeded');
    assert.equal(result.scan.truncated, true);
  } finally {
    if (previous === undefined) delete process.env.GDELT_PUBLIC_FALLBACK_ENABLED;
    else process.env.GDELT_PUBLIC_FALLBACK_ENABLED = previous;
  }
});

test('older Azure archive evidence survives the live-index one-year filter', () => {
  const undated = validateAdverseMediaRequest({ entity_type: 'business', name: 'Example Group' });
  const olderDate = `${Number(undated.date_from.slice(0, 4)) - 1}-01-01T00:00:00.000Z`;
  const item = { title: 'Example Group fraud investigation', description: 'Example Group fraud investigation',
    url: 'https://example.com/investigation', published: olderDate, _sourceType: 'global_archive' };
  assert.ok(normalizedResult(item, undated));
  assert.equal(normalizedResult({ ...item, _sourceType: 'news' }, undated), null);
  assert.equal(normalizedResult(item, validateAdverseMediaRequest({ entity_type: 'business',
    name: 'Example Group', date_to: undated.date_to })), null);
});
