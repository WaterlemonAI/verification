import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

function ipv4Number(address) {
  return address.split('.').reduce((value, octet) => (value * 256) + Number(octet), 0) >>> 0;
}

function inV4Range(address, network, prefix) {
  const bits = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & bits) === (ipv4Number(network) & bits);
}

export function isPublicIpAddress(address) {
  if (isIP(address) === 4) {
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return !blocked.some(([network, prefix]) => inV4Range(address, network, prefix));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return isPublicIpAddress(normalized.slice(7));
    return normalized !== '::' && normalized !== '::1'
      && !normalized.startsWith('fc') && !normalized.startsWith('fd')
      && !/^fe[89ab]/.test(normalized) && !normalized.startsWith('ff')
      && !normalized.startsWith('2001:db8:');
  }
  return false;
}

export function validatePublicHttpsUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { throw new Error('invalid_website_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('website_url_must_be_public_https');
  }
  if (!url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || isIP(url.hostname)) {
    throw new Error('website_url_must_use_a_public_hostname');
  }
  url.hash = '';
  return url;
}

async function publicAddresses(hostname, resolver = dnsLookup) {
  const addresses = await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error('destination_is_not_public');
  }
  return addresses;
}

function headersObject(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value || '')]));
}

export async function fetchPublicResource(rawUrl, {
  resolver = dnsLookup,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_PAGE_BYTES,
  redirects = 4,
  accept = 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5'
} = {}) {
  const url = validatePublicHttpsUrl(rawUrl);
  const addresses = await publicAddresses(url.hostname, resolver);
  const pinned = addresses[0];

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const request = httpsRequest(url, {
      method: 'GET',
      timeout: timeoutMs,
      servername: url.hostname,
      headers: {
        accept,
        'accept-encoding': 'identity',
        'user-agent': 'AI7MerchantScreening/1.0 (+https://api.ai7uae.com)'
      },
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      }
    }, (response) => {
      const status = Number(response.statusCode || 0);
      const location = response.headers.location;
      const responseSocket = response.socket;
      const responseCipher = responseSocket?.getCipher?.();
      const tls = {
        protocol: responseSocket?.getProtocol?.() || null,
        cipher: responseCipher?.standardName || responseCipher?.name || null,
        authorized: responseSocket ? Boolean(responseSocket.authorized) : null,
        authorization_error: responseSocket?.authorizationError || null
      };
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.resume();
        if (redirects <= 0) return finish(new Error('too_many_redirects'));
        const next = new URL(location, url);
        return fetchPublicResource(next, { resolver, timeoutMs, maxBytes, redirects: redirects - 1, accept })
          .then((value) => finish(null, value), finish);
      }

      const declaredLength = Number(response.headers['content-length'] || 0);
      if (declaredLength > maxBytes) {
        response.resume();
        return finish(new Error('response_too_large'));
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) request.destroy(new Error('response_too_large'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        finish(null, {
          url: url.href,
          status,
          headers: headersObject(response.headers),
          body: Buffer.concat(chunks).toString('utf8'),
          tls
        });
      });
      response.on('error', finish);
    });
    request.on('timeout', () => request.destroy(new Error('request_timeout')));
    request.on('error', finish);
    request.end();
  });
}

function hrefs(html, baseUrl) {
  const found = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of String(html).matchAll(pattern)) {
    try { found.push(new URL(match[1], baseUrl)); } catch { /* malformed link */ }
  }
  return found;
}

function robotsRules(body) {
  let applies = false;
  const disallowed = [];
  for (const sourceLine of String(body).split(/\r?\n/)) {
    const line = sourceLine.replace(/#.*$/, '').trim();
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') applies = value === '*' || value.toLowerCase().includes('ai7merchantscreening');
    if (field === 'disallow' && applies && value) disallowed.push(value);
  }
  return disallowed;
}

function allowedByRobots(url, disallowed) {
  return !disallowed.some((rule) => rule === '/' || url.pathname.startsWith(rule));
}

function crawlPriority(url) {
  const value = `${url.pathname} ${url.search}`.toLowerCase();
  if (/privacy|terms|refund|return|shipping|contact|support|about/.test(value)) return 0;
  if (/product|shop|store|catalog|collection/.test(value)) return 1;
  return 2;
}

export async function collectMerchantWebsite(websiteUrl, { maxPages = 12, fetchResource = fetchPublicResource } = {}) {
  const start = validatePublicHttpsUrl(websiteUrl);
  const origin = start.origin;
  let crawlOrigin = origin;
  let disallowed = [];
  let robots = { status: 'unavailable', url: new URL('/robots.txt', origin).href, disallowed: [] };
  try {
    const result = await fetchResource(robots.url, { maxBytes: 256 * 1024, accept: 'text/plain' });
    if (result.status === 200) {
      disallowed = robotsRules(result.body);
      robots = { status: 'respected', url: result.url, disallowed };
    } else robots = { ...robots, http_status: result.status };
  } catch (error) {
    robots = { ...robots, error: error.message };
  }

  if (!allowedByRobots(start, disallowed)) throw new Error('crawl_disallowed_by_robots');
  const queue = [start];
  const queued = new Set([start.href]);
  const pages = [];
  const errors = [];
  while (queue.length && pages.length < maxPages) {
    const current = queue.shift();
    try {
      const page = await fetchResource(current);
      if (page.status >= 200 && page.status < 400 && /^text\/html|application\/xhtml\+xml/i.test(page.headers['content-type'] || 'text/html')) {
        const finalUrl = new URL(page.url);
        if (!pages.length && finalUrl.origin !== crawlOrigin) {
          crawlOrigin = finalUrl.origin;
          const redirectedRobotsUrl = new URL('/robots.txt', crawlOrigin).href;
          try {
            const redirectedRobots = await fetchResource(redirectedRobotsUrl, { maxBytes: 256 * 1024, accept: 'text/plain' });
            disallowed = redirectedRobots.status === 200 ? robotsRules(redirectedRobots.body) : [];
            robots = redirectedRobots.status === 200
              ? { status: 'respected', url: redirectedRobots.url, disallowed }
              : { status: 'unavailable', url: redirectedRobots.url, http_status: redirectedRobots.status, disallowed: [] };
          } catch (error) {
            disallowed = [];
            robots = { status: 'unavailable', url: redirectedRobotsUrl, error: error.message, disallowed: [] };
          }
          if (!allowedByRobots(finalUrl, disallowed)) throw new Error('crawl_disallowed_by_robots');
        }
        if (finalUrl.origin !== crawlOrigin) {
          errors.push({ url: current.href, error: 'cross_origin_redirect_blocked' });
          continue;
        }
        pages.push(page);
        const discoveredOnPage = new Set();
        const candidates = hrefs(page.body, page.url)
          .filter((url) => url.origin === crawlOrigin && url.protocol === 'https:' && allowedByRobots(url, disallowed))
          .map((url) => { url.hash = ''; return url; })
          .filter((url) => {
            if (queued.has(url.href) || discoveredOnPage.has(url.href)) return false;
            discoveredOnPage.add(url.href);
            return true;
          })
          .sort((a, b) => crawlPriority(a) - crawlPriority(b));
        for (const candidate of candidates) {
          queued.add(candidate.href);
          if (queue.length < maxPages * 4) queue.push(candidate);
        }
      } else errors.push({ url: current.href, error: `http_${page.status}` });
    } catch (error) {
      errors.push({ url: current.href, error: error.message });
    }
  }
  if (!pages.length) throw new Error(errors[0]?.error || 'website_unavailable');
  return { pages, robots, errors, limits: { maximum_pages: maxPages, maximum_page_bytes: MAX_PAGE_BYTES } };
}

export async function collectDomainRegistration(hostname, { fetchResource = fetchPublicResource } = {}) {
  const domain = hostname.replace(/^www\./i, '').toLowerCase();
  try {
    const response = await fetchResource(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      maxBytes: 1024 * 1024,
      accept: 'application/rdap+json,application/json'
    });
    if (response.status !== 200) return { status: 'unavailable', domain, http_status: response.status };
    const data = JSON.parse(response.body);
    const registration = (data.events || []).find((event) => ['registration', 'registered'].includes(String(event.eventAction).toLowerCase()));
    const createdAt = registration?.eventDate || null;
    return {
      status: createdAt ? 'available' : 'partial',
      domain,
      created_at: createdAt,
      age_days: createdAt ? Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 86_400_000)) : null,
      source_url: response.url,
      rdap_status: Array.isArray(data.status) ? data.status : []
    };
  } catch (error) {
    return { status: 'unavailable', domain, error: error.message };
  }
}
