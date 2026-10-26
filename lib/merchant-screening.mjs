import { createHash, randomUUID } from 'node:crypto';
import { collectDomainRegistration, collectMerchantWebsite, validatePublicHttpsUrl } from './merchant-screening-network.mjs';

const SOCIAL_HOSTS = new Map([
  ['facebook.com', 'facebook'], ['instagram.com', 'instagram'], ['linkedin.com', 'linkedin'],
  ['twitter.com', 'x'], ['x.com', 'x'], ['youtube.com', 'youtube'], ['tiktok.com', 'tiktok'],
  ['pinterest.com', 'pinterest'], ['snapchat.com', 'snapchat'], ['threads.net', 'threads']
]);

const PAYMENT_HOST_PARTS = ['paypal.', 'stripe.', 'checkout.com', 'adyen.', 'klarna.', 'tabby.', 'tamara.'];
const TRACKING_HOST_PARTS = ['google-analytics.', 'googletagmanager.', 'doubleclick.', 'facebook.net', 'hotjar.', 'segment.'];
const PROHIBITED_SIGNALS = [
  { category: 'gambling', pattern: /\b(casino|sportsbook|betting|poker|roulette|lottery)\b/i, severity: 'critical' },
  { category: 'adult_content', pattern: /\b(porn|xxx|escort|adult[-_ ]?content)\b/i, severity: 'critical' },
  { category: 'weapons', pattern: /\b(firearm|ammunition|assault[-_ ]?rifle|weapon|gun[-_ ]?shop)\b/i, severity: 'high' },
  { category: 'controlled_substances', pattern: /\b(cocaine|heroin|methamphetamine|illegal[-_ ]?drug)\b/i, severity: 'critical' },
  { category: 'counterfeit_claim', pattern: /\b(counterfeit|fake[-_ ]?designer|replica[-_ ]?luxury)\b/i, severity: 'high' }
];

const PRODUCT_MCC_RULES = [
  { pattern: /\b(beer|wine|whisky|whiskey|vodka|alcohol|liquor)\b/i, mcc: '5921', description: 'Package Stores—Beer, Wine, and Liquor', risk: 'high' },
  { pattern: /\b(casino|betting|sportsbook|gambling|lottery)\b/i, mcc: '7995', description: 'Betting, including Lottery Tickets, Casino Gaming Chips, Off-Track Betting, and Wagers', risk: 'critical' },
  { pattern: /\b(cigarette|cigar|tobacco|vape|nicotine)\b/i, mcc: '5993', description: 'Cigar Stores and Stands', risk: 'high' },
  { pattern: /\b(pharmacy|prescription|medicine|medication|supplement)\b/i, mcc: '5912', description: 'Drug Stores and Pharmacies', risk: 'high' },
  { pattern: /\b(jewelry|jewellery|diamond|precious stone|gold ring)\b/i, mcc: '5944', description: 'Clock, Jewelry, Watch, and Silverware Stores', risk: 'medium' },
  { pattern: /\b(flight|hotel|tour|travel package|holiday package)\b/i, mcc: '4722', description: 'Travel Agencies and Tour Operators', risk: 'medium' },
  { pattern: /\b(computer|laptop|phone|camera|electronics)\b/i, mcc: '5732', description: 'Electronics Stores', risk: 'low' },
  { pattern: /\b(software|application|saas|digital license|artificial intelligence|ai|ai platform|intelligence api|supplier intelligence|multimodal intelligence)\b/i, mcc: '5734', description: 'Computer Software Stores', risk: 'low' },
  { pattern: /\b(shirt|dress|trousers|clothing|apparel|fashion)\b/i, mcc: '5651', description: 'Family Clothing Stores', risk: 'low' },
  { pattern: /\b(grocery|food|vegetable|fruit|pantry)\b/i, mcc: '5411', description: 'Grocery Stores and Supermarkets', risk: 'low' },
  { pattern: /\b(book|ebook|novel|textbook)\b/i, mcc: '5942', description: 'Book Stores', risk: 'low' },
  { pattern: /\b(cosmetic|makeup|skincare|perfume)\b/i, mcc: '5977', description: 'Cosmetic Stores', risk: 'low' }
];

const COUNTRY_POLICY_PACKS = {
  AE: {
    name: 'United Arab Emirates baseline merchant disclosure pack',
    expected: ['privacy', 'terms', 'returns', 'customer_support'],
    note: 'Automated presence and content checks only; this is not a legal conclusion under UAE federal or free-zone law.'
  },
  DEFAULT: {
    name: 'Generic merchant disclosure baseline',
    expected: ['privacy', 'terms', 'returns', 'customer_support'],
    note: 'Automated presence and content checks only; country-specific legal review is required.'
  }
};

function text(value) {
  return String(value ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function evidenceId(kind, sourceUrl, content) {
  return `ev_${createHash('sha256').update(`${kind}\n${sourceUrl}\n${content}`).digest('hex').slice(0, 16)}`;
}

function pageEvidence(page) {
  const bodyHash = createHash('sha256').update(page.body).digest('hex');
  return {
    evidence_id: evidenceId('web_page', page.url, bodyHash),
    type: 'web_page', source_url: page.url, retrieved_at: new Date().toISOString(),
    http_status: page.status, sha256: bodyHash
  };
}

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, 'i').exec(tag);
  return match?.[1] ?? match?.[2] ?? '';
}

function metaValue(html, key) {
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = attribute(tag, 'name') || attribute(tag, 'property');
    if (name.toLowerCase() === key.toLowerCase()) return attribute(tag, 'content');
  }
  return '';
}

function extractJsonLd(html) {
  const output = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of String(html).matchAll(pattern)) {
    try { output.push(JSON.parse(match[1].trim())); } catch { /* malformed merchant markup */ }
  }
  return output;
}

function flattenJsonLd(value, output = []) {
  if (Array.isArray(value)) value.forEach((item) => flattenJsonLd(item, output));
  else if (value && typeof value === 'object') {
    if (value['@type']) output.push(value);
    if (value['@graph']) flattenJsonLd(value['@graph'], output);
  }
  return output;
}

function types(node) {
  return (Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']]).map((value) => String(value).toLowerCase());
}

function postalAddress(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return unique([value.streetAddress, value.addressLocality, value.addressRegion, value.postalCode, value.addressCountry]).join(', ');
}

function linkRecords(page) {
  const records = [];
  const patterns = [
    ['anchor', /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi],
    ['script', /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi],
    ['iframe', /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi],
    ['form', /<form\b[^>]*\baction\s*=\s*["']([^"']+)["'][^>]*>/gi]
  ];
  for (const [kind, pattern] of patterns) {
    for (const match of String(page.body).matchAll(pattern)) {
      try {
        const url = new URL(match[1], page.url);
        if (!['http:', 'https:'].includes(url.protocol)) continue;
        url.hash = '';
        records.push({ url: url.href, kind, label: kind === 'anchor' ? text(match[2]).slice(0, 240) : '', source_url: page.url });
      } catch { /* malformed merchant link */ }
    }
  }
  return records;
}

function contactLinks(html, scheme) {
  const values = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of String(html).matchAll(pattern)) {
    if (match[1].toLowerCase().startsWith(`${scheme}:`)) values.push(match[1].slice(scheme.length + 1).split('?')[0]);
  }
  return values;
}

function rootHost(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function socialNetwork(hostname) {
  const host = rootHost(hostname);
  for (const [domain, network] of SOCIAL_HOSTS) if (host === domain || host.endsWith(`.${domain}`)) return network;
  return null;
}

function classifyOutgoing(url, merchantHost) {
  const host = rootHost(url.hostname);
  if (host === rootHost(merchantHost) || host.endsWith(`.${rootHost(merchantHost)}`)) return 'first_party';
  if (socialNetwork(host)) return 'social_media';
  if (PAYMENT_HOST_PARTS.some((part) => host.includes(part))) return 'payment_service';
  if (TRACKING_HOST_PARTS.some((part) => host.includes(part))) return 'analytics_or_advertising';
  return 'external';
}

function prohibitedMatches(value) {
  return PROHIBITED_SIGNALS.filter(({ pattern }) => pattern.test(value)).map(({ category, severity }) => ({ category, severity }));
}

function policyType(record) {
  let path = '';
  try { path = new URL(record.url).pathname.toLowerCase().replace(/\/$/, ''); } catch { return null; }
  const label = record.label.toLowerCase().replace(/\s+/g, ' ').trim();
  const editorial = /^\/(insights|blog|news|articles|announcements)(\/|$)/.test(path);
  if (!editorial && (/\/(privacy|privacy-policy|data-protection-policy)$/.test(path) || /\b(privacy|data protection) policy\b/.test(label))) return 'privacy';
  if (!editorial && (/\/(terms|terms-of-use|terms-and-conditions|conditions-of-use)$/.test(path) || /\bterms( of use| and conditions)?\b/.test(label))) return 'terms';
  if (!editorial && (/\/(returns?|refunds?|return-policy|refund-policy)$/.test(path) || /\b(return|refund) policy\b/.test(label))) return 'returns';
  if (!editorial && (/\/(shipping|delivery|shipping-policy|delivery-policy)$/.test(path) || /\b(shipping|delivery) policy\b/.test(label))) return 'shipping';
  if (!editorial && (/\/(contact|support|help|customer-support)$/.test(path) || /^(contact|support|help|customer support)( us)?$/.test(label))) return 'customer_support';
  return null;
}

function productFromNode(node, sourceUrl, evidenceIdValue) {
  const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers || {};
  let productUrl = sourceUrl;
  try { if (node.url) productUrl = new URL(String(node.url), sourceUrl).href; } catch { /* keep evidence page */ }
  return {
    name: String(node.name || '').trim(),
    description: text(node.description || '').slice(0, 500) || null,
    sku: node.sku ? String(node.sku) : null,
    brand: typeof node.brand === 'string' ? node.brand : node.brand?.name || null,
    price: offers.price != null ? String(offers.price) : null,
    currency: offers.priceCurrency || null,
    url: productUrl,
    evidence_ids: [evidenceIdValue]
  };
}

function mapProductMcc(product) {
  const haystack = `${product.name} ${product.description || ''}`;
  const match = PRODUCT_MCC_RULES.find(({ pattern }) => pattern.test(haystack));
  const prohibited = prohibitedMatches(haystack);
  const risk = prohibited.reduce((level, item) => item.severity === 'critical' ? 'critical' : level === 'critical' ? level : 'high', match?.risk || 'unclassified');
  return {
    ...product,
    candidate_mcc: match ? { code: match.mcc, description: match.description, confidence: 'low' } : null,
    risk_level: risk,
    risk_signals: prohibited.map(({ category }) => category),
    mapping_status: match ? 'candidate_for_human_review' : 'unmapped'
  };
}

function severityPoints(severity) {
  return ({ low: 5, medium: 12, high: 25, critical: 45 })[severity] || 0;
}

function securityAssessment(home) {
  const headers = home.headers || {};
  const checks = {
    strict_transport_security: Boolean(headers['strict-transport-security']),
    content_security_policy: Boolean(headers['content-security-policy']),
    x_content_type_options: /nosniff/i.test(headers['x-content-type-options'] || ''),
    frame_protection: Boolean(headers['x-frame-options']) || /frame-ancestors/i.test(headers['content-security-policy'] || ''),
    referrer_policy: Boolean(headers['referrer-policy']),
    permissions_policy: Boolean(headers['permissions-policy'])
  };
  return {
    https: true,
    tls: home.tls || { protocol: null, cipher: null, authorized: null },
    response_headers: checks,
    missing_recommended_headers: Object.entries(checks).filter(([, present]) => !present).map(([name]) => name),
    note: 'Header and negotiated-connection observation only; this is not a vulnerability scan or certificate-transparency audit.'
  };
}

function providerUnavailable(name, reason) {
  return { status: 'not_configured', provider: name, reason, items: [] };
}

export function validateMerchantScreeningRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'A JSON object is required.' };
  const allowedFields = new Set(['website_url', 'country_code', 'declared_merchant_name', 'declared_mcc', 'max_pages']);
  const unknownField = Object.keys(body).find((field) => !allowedFields.has(field));
  if (unknownField) return { error: `Unsupported field: ${unknownField}.` };
  let website;
  try { website = validatePublicHttpsUrl(body.website_url); } catch (error) { return { error: error.message }; }
  const countryCode = String(body.country_code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) return { error: 'country_code must be a two-letter ISO country code.' };
  if (body.declared_mcc != null && !/^\d{4}$/.test(String(body.declared_mcc))) return { error: 'declared_mcc must contain exactly four digits.' };
  const maxPages = body.max_pages == null ? 12 : body.max_pages;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) return { error: 'max_pages must be an integer between 1 and 20.' };
  return {
    value: {
      website_url: website.href,
      country_code: countryCode,
      declared_merchant_name: String(body.declared_merchant_name || '').trim().slice(0, 200) || null,
      declared_mcc: /^\d{4}$/.test(String(body.declared_mcc || '')) ? String(body.declared_mcc) : null,
      max_pages: maxPages
    }
  };
}

export function analyzeMerchantWebsite(request, collection, domainRegistration, providerResults = {}) {
  const evidence = collection.pages.map(pageEvidence);
  const evidenceByUrl = new Map(evidence.map((item) => [item.source_url, item.evidence_id]));
  const nodes = collection.pages.flatMap((page) => extractJsonLd(page.body).flatMap((value) => flattenJsonLd(value).map((node) => ({ node, page }))));
  const organizations = nodes.filter(({ node }) => types(node).some((type) => ['organization', 'corporation', 'localbusiness', 'store', 'onlinestore'].includes(type)));
  const people = nodes.filter(({ node }) => types(node).includes('person'));
  const links = collection.pages.flatMap(linkRecords);
  const start = new URL(request.website_url);
  const home = collection.pages[0];

  const names = unique([
    ...organizations.map(({ node }) => node.name),
    metaValue(home.body, 'og:site_name'),
    text((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(home.body) || [])[1] || '').split(/[|–—-]/)[0]
  ]);
  const addresses = unique(organizations.flatMap(({ node }) => Array.isArray(node.address) ? node.address.map(postalAddress) : [postalAddress(node.address)]));
  addresses.push(...unique(collection.pages.flatMap((page) => [...String(page.body).matchAll(/<address\b[^>]*>([\s\S]*?)<\/address>/gi)].map((match) => text(match[1])))));
  const phones = unique([
    ...organizations.flatMap(({ node }) => [node.telephone, ...(Array.isArray(node.contactPoint) ? node.contactPoint : [node.contactPoint]).filter(Boolean).map((point) => point.telephone)]),
    ...collection.pages.flatMap((page) => contactLinks(page.body, 'tel'))
  ]);
  const emails = unique([...organizations.map(({ node }) => node.email), ...collection.pages.flatMap((page) => contactLinks(page.body, 'mailto'))]);
  for (const page of collection.pages) {
    emails.push(...unique(text(page.body).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []));
  }

  const socialProfiles = unique(links.filter((item) => {
    try { return Boolean(socialNetwork(new URL(item.url).hostname)); } catch { return false; }
  }).map((item) => item.url)).map((url) => ({ network: socialNetwork(new URL(url).hostname), url, verification_status: 'linked_from_merchant_website' }));

  const policyMap = new Map();
  for (const link of links) {
    const type = policyType(link);
    if (type && !policyMap.has(type)) policyMap.set(type, { status: 'found', url: link.url, evidence_ids: [evidenceByUrl.get(link.source_url)].filter(Boolean) });
  }
  const policyPages = collection.pages.filter((page) => /privacy|terms|refund|return|shipping|delivery|contact|support/i.test(new URL(page.url).pathname));
  const allPolicyText = policyPages.map((page) => text(page.body)).join(' ');
  const policies = Object.fromEntries(['privacy', 'terms', 'returns', 'shipping', 'customer_support'].map((type) => [type, policyMap.get(type) || { status: 'not_found', url: null, evidence_ids: [] }]));
  policies.data_storage_and_retention = {
    status: /\b(retain|retention|storage period|stored for|data residency|data localisation|data localization|delete your data)\b/i.test(allPolicyText) ? 'language_found' : 'not_found',
    note: 'Presence check only; legal sufficiency and jurisdictional applicability require review.'
  };

  const structuredProducts = nodes.filter(({ node }) => types(node).includes('product'))
    .map(({ node, page }) => productFromNode(node, page.url, evidenceByUrl.get(page.url)))
    .filter((product) => product.name);
  const structuredProductUrls = new Set(structuredProducts.map((product) => product.url));
  const metaProducts = collection.pages.filter((page) => /product/i.test(metaValue(page.body, 'og:type')) && !structuredProductUrls.has(page.url)).map((page) => ({
    name: metaValue(page.body, 'og:title') || text((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(page.body) || [])[1] || ''),
    description: metaValue(page.body, 'og:description') || metaValue(page.body, 'description') || null,
    sku: null, brand: null,
    price: metaValue(page.body, 'product:price:amount') || null,
    currency: metaValue(page.body, 'product:price:currency') || null,
    url: page.url, evidence_ids: [evidenceByUrl.get(page.url)].filter(Boolean)
  })).filter((product) => product.name);
  const listedProductTargets = new Set(links.filter((item) => {
    try {
      const sourcePath = new URL(item.source_url).pathname.replace(/\/$/, '');
      const targetPath = new URL(item.url).pathname;
      return sourcePath === '/products' && (/^\/products\/[^/]+\/?$/.test(targetPath) || /\btool\b/i.test(item.label));
    } catch { return false; }
  }).map((item) => item.url.replace(/\/$/, '')));
  const knownProductUrls = new Set([...structuredProducts, ...metaProducts].map((product) => product.url.replace(/\/$/, '')));
  const listingProducts = collection.pages.filter((page) => listedProductTargets.has(page.url.replace(/\/$/, '')) && !knownProductUrls.has(page.url.replace(/\/$/, ''))).map((page) => ({
    name: text((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(page.body) || [])[1] || '').split('|')[0].trim(),
    description: metaValue(page.body, 'description') || metaValue(page.body, 'og:description') || null,
    sku: null, brand: null, price: null, currency: null,
    url: page.url, evidence_ids: [evidenceByUrl.get(page.url)].filter(Boolean)
  })).filter((product) => product.name);
  const products = [...structuredProducts, ...metaProducts, ...listingProducts].map(mapProductMcc);

  const outgoingGrouped = new Map();
  for (const item of links) {
    const url = new URL(item.url);
    const category = classifyOutgoing(url, start.hostname);
    if (category === 'first_party') continue;
    const matches = prohibitedMatches(`${url.hostname} ${url.pathname} ${item.label}`);
    const existing = outgoingGrouped.get(item.url) || {
      url: item.url, host: url.hostname, category, source_types: [], source_pages: [],
      prohibited_risk_signals: matches.map(({ category: matchCategory }) => matchCategory),
      risk_level: matches.some((match) => match.severity === 'critical') ? 'critical' : matches.length ? 'high' : 'unclassified',
      verification_status: matches.length ? 'keyword_signal_requires_destination_reputation_check' : 'not_reputation_checked'
    };
    existing.source_types.push(item.kind);
    existing.source_pages.push(item.source_url);
    outgoingGrouped.set(item.url, existing);
  }
  const outgoingLinks = [...outgoingGrouped.values()].map((item) => ({ ...item, source_types: unique(item.source_types), source_pages: unique(item.source_pages) }));

  const founderDetails = people.filter(({ node }) => /founder|co-founder/i.test(`${node.jobTitle || ''} ${node.description || ''}`)).map(({ node, page }) => ({
    name: node.name || null, role: node.jobTitle || 'Founder', source_url: page.url, evidence_ids: [evidenceByUrl.get(page.url)].filter(Boolean)
  }));
  const leadership = people.filter(({ node }) => /chief|ceo|cfo|coo|cto|president|director|managing/i.test(`${node.jobTitle || ''}`)).map(({ node, page }) => ({
    name: node.name || null, role: node.jobTitle || null, source_url: page.url, evidence_ids: [evidenceByUrl.get(page.url)].filter(Boolean)
  }));
  const publicClaims = [];
  for (const page of collection.pages) {
    const pageText = text(page.body);
    for (const match of pageText.matchAll(/[^.!?]{0,100}\b(partner(?:ship|ed)? with|official partner|sponsor(?:ed|ship)?)[^.!?]{0,180}[.!?]/gi)) {
      publicClaims.push({ claim: match[0].trim().slice(0, 300), source_url: page.url, evidence_ids: [evidenceByUrl.get(page.url)].filter(Boolean), verification_status: 'merchant_website_claim_only' });
      if (publicClaims.length >= 20) break;
    }
  }

  const security = securityAssessment(home);
  const countryPack = COUNTRY_POLICY_PACKS[request.country_code] || COUNTRY_POLICY_PACKS.DEFAULT;
  const missingPolicies = countryPack.expected.filter((type) => policies[type]?.status !== 'found');
  const findings = [];
  for (const type of missingPolicies) findings.push({ code: `policy_${type}_not_found`, severity: type === 'privacy' || type === 'terms' ? 'medium' : 'low', summary: `${type.replaceAll('_', ' ')} policy was not found in the bounded crawl.` });
  if (policies.data_storage_and_retention.status === 'not_found') findings.push({ code: 'data_retention_language_not_found', severity: 'low', summary: 'Data storage or retention language was not found in the policy pages crawled.' });
  for (const header of security.missing_recommended_headers) findings.push({ code: `security_header_${header}_missing`, severity: header === 'strict_transport_security' || header === 'content_security_policy' ? 'medium' : 'low', summary: `Recommended response header ${header} was not observed.` });
  for (const link of outgoingLinks.filter((item) => item.prohibited_risk_signals.length)) findings.push({ code: 'outgoing_link_prohibited_keyword_signal', severity: link.risk_level, summary: `An outgoing URL or its link label matched review keywords: ${link.prohibited_risk_signals.join(', ')}. This is a signal, not a confirmed prohibited destination.`, source_url: link.url });
  for (const product of products.filter((item) => ['high', 'critical'].includes(item.risk_level))) findings.push({ code: 'high_risk_product_candidate', severity: product.risk_level, summary: `Product “${product.name}” requires enhanced review.`, source_url: product.url });
  if (Number.isFinite(domainRegistration.age_days) && domainRegistration.age_days < 180) findings.push({
    code: 'recent_domain_registration', severity: domainRegistration.age_days < 30 ? 'high' : 'medium',
    summary: `The domain registration is approximately ${domainRegistration.age_days} days old. A recent domain is an age signal, not evidence of misconduct.`
  });
  if (request.declared_mcc && products.some((product) => product.candidate_mcc && product.candidate_mcc.code !== request.declared_mcc)) findings.push({ code: 'declared_mcc_product_mismatch', severity: 'medium', summary: 'At least one product candidate MCC differs from the declared merchant MCC.' });

  const policyScore = Math.min(20, findings.filter((finding) => finding.code.startsWith('policy_') || finding.code === 'data_retention_language_not_found').reduce((total, finding) => total + severityPoints(finding.severity), 0));
  const securityScore = Math.min(20, findings.filter((finding) => finding.code.startsWith('security_header_')).reduce((total, finding) => total + severityPoints(finding.severity), 0));
  const destinationScore = Math.min(60, findings.filter((finding) => finding.code === 'outgoing_link_prohibited_keyword_signal').reduce((maximum, finding) => Math.max(maximum, severityPoints(finding.severity)), 0));
  const productScore = Math.min(50, findings.filter((finding) => finding.code === 'high_risk_product_candidate').reduce((maximum, finding) => Math.max(maximum, severityPoints(finding.severity)), 0));
  const domainScore = Math.min(20, findings.filter((finding) => finding.code === 'recent_domain_registration').reduce((maximum, finding) => Math.max(maximum, severityPoints(finding.severity)), 0));
  const mismatchScore = findings.some((finding) => finding.code === 'declared_mcc_product_mismatch') ? 15 : 0;
  const score = Math.min(100, policyScore + securityScore + destinationScore + productScore + domainScore + mismatchScore);
  const hasCriticalSignal = findings.some((finding) => finding.severity === 'critical');
  const riskLevel = hasCriticalSignal ? 'critical' : score >= 60 ? 'high' : score >= 25 ? 'medium' : 'low';
  const screenshots = providerResults.screenshots || providerUnavailable('browser_worker', 'Rendered screenshots require an isolated browser worker with network egress controls.');
  const xMentions = providerResults.x_mentions || providerUnavailable('x_api', 'An approved X API or licensed data provider is required for the latest 20 mentions.');
  const destinationReputation = providerResults.destination_reputation || providerUnavailable('destination_reputation', 'A malware, phishing, and prohibited-business reputation provider is required to confirm external destinations.');
  const unavailable = [screenshots, xMentions, destinationReputation, domainRegistration].filter((item) => !['available', 'completed'].includes(item?.status)).length;

  return {
    screening_id: randomUUID(),
    status: unavailable ? 'partial' : 'completed',
    completed_at: new Date().toISOString(),
    request,
    merchant_identity: {
      names, addresses, phones: unique(phones), emails: unique(emails), social_profiles: socialProfiles,
      founders: founderDetails, senior_leadership: leadership,
      publicly_listed_partnerships: publicClaims.filter((item) => /partner/i.test(item.claim)),
      event_sponsorships: publicClaims.filter((item) => /sponsor/i.test(item.claim)),
      partnership_and_sponsorship_claims: publicClaims
    },
    domain: domainRegistration,
    policies: { country_pack: countryPack, missing_expected_items: missingPolicies, ...policies },
    products,
    outgoing_links: outgoingLinks,
    security,
    screenshots,
    social_mentions: { x: xMentions },
    destination_reputation: destinationReputation,
    crawl: { robots: collection.robots, pages_collected: collection.pages.length, page_errors: collection.errors, limits: collection.limits },
    findings,
    summary: {
      risk_score: score,
      risk_level: riskLevel,
      risk_dimensions: { policy: policyScore, security: securityScore, destination: destinationScore, product: productScore, domain_age: domainScore, declared_mcc_mismatch: mismatchScore },
      outcome: hasCriticalSignal ? 'enhanced_due_diligence' : unavailable ? 'manual_review' : 'review_complete',
      decision_eligible: unavailable === 0,
      confidence: collection.pages.length >= Math.min(5, request.max_pages) ? 'medium' : 'low',
      coverage: {
        website: 'available', domain_registration: domainRegistration.status,
        screenshots: screenshots.status, x_mentions: xMentions.status,
        destination_reputation: destinationReputation.status
      }
    },
    evidence,
    methodology: {
      version: 'merchant-screening-foundation-1',
      cost_ceiling_usd: 0.05,
      mcc_mapping: 'Candidate mapping based on product text; it is not a card-network or acquirer classification decision.',
      prohibited_link_detection: 'Keyword and destination classification signal only; reputation-feed confirmation is not yet configured.',
      crawl_scope: 'Bounded HTTPS same-origin crawl that respects robots.txt and blocks private/reserved network destinations.',
      api_data_storage: 'The foundation returns results synchronously and does not persist request or response data.'
    }
  };
}

export async function screenMerchantWebsite(request, {
  collectWebsite = collectMerchantWebsite,
  collectDomain = collectDomainRegistration,
  screenshotProvider,
  xMentionsProvider,
  destinationReputationProvider
} = {}) {
  const collection = await collectWebsite(request.website_url, { maxPages: request.max_pages });
  const hostname = new URL(request.website_url).hostname;
  const tasks = [
    collectDomain(hostname),
    screenshotProvider ? screenshotProvider(request, collection) : Promise.resolve(null),
    xMentionsProvider ? xMentionsProvider(request, collection) : Promise.resolve(null),
    destinationReputationProvider ? destinationReputationProvider(request, collection) : Promise.resolve(null)
  ];
  const settled = await Promise.allSettled(tasks);
  const valueOrUnavailable = (result, provider) => result.status === 'fulfilled'
    ? result.value
    : { status: 'unavailable', provider, reason: 'The provider request failed.', items: [] };
  const domain = valueOrUnavailable(settled[0], 'rdap') || { status: 'unavailable', provider: 'rdap' };
  const screenshots = valueOrUnavailable(settled[1], 'browser_worker');
  const rawXMentions = valueOrUnavailable(settled[2], 'x_api');
  const xMentions = rawXMentions?.items ? { ...rawXMentions, items: rawXMentions.items.slice(0, 20) } : rawXMentions;
  const destinationReputation = valueOrUnavailable(settled[3], 'destination_reputation');
  return analyzeMerchantWebsite(request, collection, domain, {
    screenshots: screenshots || undefined,
    x_mentions: xMentions || undefined,
    destination_reputation: destinationReputation || undefined
  });
}
