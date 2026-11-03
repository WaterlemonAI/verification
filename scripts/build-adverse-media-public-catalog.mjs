import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import catalog from '../top_50_media_publishers_30_largest_economies_2026.json' with { type: 'json' };
import supplemental from '../lib/search-plus-supplemental-publishers.json' with { type: 'json' };

const eligibleCategories = new Set([
  'general', 'finance', 'newspaper', 'news_agency', 'online_news', 'magazine',
  'television', 'broadcaster', 'radio'
]);
const countries = [...catalog.countries, ...supplemental.countries];
const markets = countries.map(({ country, iso2, outlets }) => ({
  country,
  country_code: iso2,
  catalog_publishers: outlets.length,
  searchable_publishers: outlets.filter((outlet) => eligibleCategories.has(outlet.category)).length,
  publishers: outlets.map(({ name, domain, category }) => ({
    name,
    domain: domain.toLowerCase(),
    category,
    targeted_search_eligible: eligibleCategories.has(category)
  }))
}));
const unique = new Map(markets.flatMap((market) => market.publishers.map((publisher) => [publisher.domain, publisher])));
const output = {
  published_at: '2026-11-04',
  description: 'Approved publisher selection pool for Adverse Media Search+. Catalog membership does not mean a publisher was searched on a particular run or every article was indexed.',
  market_count: markets.length,
  unique_publisher_count: unique.size,
  unique_searchable_publisher_count: [...unique.values()].filter((publisher) => publisher.targeted_search_eligible).length,
  markets
};
const destination = fileURLToPath(new URL('../api-site/adverse-media-publisher-catalog.json', import.meta.url));
await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
