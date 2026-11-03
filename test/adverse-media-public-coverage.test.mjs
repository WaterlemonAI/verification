import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { approvedPublisherCount, approvedPublisherCoverage, approvedSearchablePublisherCount } = await import('../lib/approved-publishers.mjs');
const { globalArchiveSearch } = await import('../lib/adverse-media.mjs');
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

test('both historical paths failing never returns completed coverage', async () => {
  await assert.rejects(globalArchiveSearch({ name: 'Synthetic Example', aliases: [], countries: [], languages: ['en'] },
    async () => ({ ok: false, status: 503, headers: { get: () => null } }),
    async () => { throw new Error('local_index_read_failed'); }), /archive_search_failed_503/);
});
