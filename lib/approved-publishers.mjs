import catalog from '../top_50_media_publishers_30_largest_economies_2026.json' with { type: 'json' };

const publishers = new Map();
const publishersByCountry = new Map();
const HIGH_VALUE_CATEGORIES = new Set([
  'general', 'finance', 'newspaper', 'news_agency', 'online_news', 'magazine',
  'television', 'broadcaster', 'radio'
]);
for (const country of catalog.countries) {
  const countryPublishers = [];
  for (const outlet of country.outlets) {
    const domain = outlet.domain.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith('.') || domain.endsWith('.')) {
      throw new Error('invalid_approved_publisher_domain');
    }
    const publisher = {
      name: outlet.name,
      domain,
      country: country.country,
      country_code: country.iso2,
      category: outlet.category,
      country_rank: outlet.country_rank,
      global_rank: outlet.global_rank,
      score: outlet.score
    };
    if (!publishers.has(domain)) publishers.set(domain, publisher);
    countryPublishers.push(publisher);
  }
  publishersByCountry.set(country.iso2, countryPublishers);
}

export const approvedPublisherCount = publishers.size;

function customerPublisher(publisher) {
  return {
    name: publisher.name,
    domain: publisher.domain,
    country: publisher.country,
    country_code: publisher.country_code,
    category: publisher.category
  };
}

function rankedPublishers(items) {
  return items.filter((publisher) => HIGH_VALUE_CATEGORIES.has(publisher.category))
    .sort((left, right) => (Number(left.country_rank) || 999) - (Number(right.country_rank) || 999)
      || (Number(right.score) || 0) - (Number(left.score) || 0));
}

export function selectApprovedPublishers({ countries = [], limit = 100 } = {}) {
  const selected = [];
  const seen = new Set();
  const add = (publisher) => {
    if (!publisher || seen.has(publisher.domain) || selected.length >= limit) return;
    seen.add(publisher.domain);
    selected.push(customerPublisher(publisher));
  };
  const roundRobin = (groups) => {
    const maximum = Math.max(0, ...groups.map((group) => group.length));
    for (let index = 0; index < maximum && selected.length < limit; index += 1) {
      groups.forEach((group) => add(group[index]));
    }
  };

  const requestedGroups = [...new Set(countries)]
    .map((country) => rankedPublishers([...(publishersByCountry.get(country) || [])]))
    .filter((group) => group.length);
  if (requestedGroups.length) roundRobin(requestedGroups);

  if (selected.length < limit) {
    roundRobin(catalog.countries.map((country) => rankedPublishers([...(publishersByCountry.get(country.iso2) || [])])));
  }
  return selected;
}

// Search results must link directly to an approved publisher article. A hostname
// suffix is accepted only at a label boundary; lookalike domains are rejected.
export function approvedPublisherForUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || url.pathname === '/' || !url.pathname) return null;
  let hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  while (hostname.includes('.')) {
    const publisher = publishers.get(hostname);
    if (publisher) return customerPublisher(publisher);
    hostname = hostname.slice(hostname.indexOf('.') + 1);
  }
  return null;
}
