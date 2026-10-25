import catalog from '../top_50_media_publishers_30_largest_economies_2026.json' with { type: 'json' };

const publishers = new Map();
for (const country of catalog.countries) {
  for (const outlet of country.outlets) {
    const domain = outlet.domain.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith('.') || domain.endsWith('.')) {
      throw new Error('invalid_approved_publisher_domain');
    }
    if (!publishers.has(domain)) publishers.set(domain, { name: outlet.name, domain });
  }
}

export const approvedPublisherCount = publishers.size;

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
    if (publisher) return publisher;
    hostname = hostname.slice(hostname.indexOf('.') + 1);
  }
  return null;
}
