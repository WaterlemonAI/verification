import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedPublisherCount, approvedPublisherForUrl, selectApprovedPublishers } from '../lib/approved-publishers.mjs';
import { presentAdverseMediaResponse, screenAdverseMedia, validateAdverseMediaRequest } from '../lib/adverse-media.mjs';

test('approved catalog matches direct publisher article URLs only', () => {
  assert.equal(approvedPublisherCount, 1500);
  assert.equal(approvedPublisherForUrl('https://www.nytimes.com/2026/10/20/business/story.html')?.name, 'The New York Times');
  assert.equal(approvedPublisherForUrl('https://www.medianama.com/2024/12/signzy-data-leak/')?.name, 'MediaNama');
  for (const url of [
    'https://nytimes.com.evil.example/article',
    'http://nytimes.com/article',
    'https://nytimes.com/',
    'https://example.com/article'
  ]) assert.equal(approvedPublisherForUrl(url), null);
});

test('publisher selection prioritizes requested countries and excludes low-value entertainment categories', () => {
  const selected = selectApprovedPublishers({ countries: ['AE', 'IN'], limit: 20 });
  assert.equal(selected.length, 20);
  assert.ok(selected.every((publisher) => ['AE', 'IN'].includes(publisher.country_code)));
  assert.ok(selected.every((publisher) => !['sports', 'music', 'culture'].includes(publisher.category)));
  assert.ok(new Set(selected.map((publisher) => publisher.country_code)).size === 2);
});

test('deep-research retries only the missing search query after successful Brave results are checkpointed', async () => {
  const request = validateAdverseMediaRequest({
    entity_type: 'business', name: 'Checkpoint Entity 01', languages: ['en']
  });
  const saved = new Map();
  const checkpoint = {
    get: async (key) => saved.has(key) ? structuredClone(saved.get(key)) : null,
    save: async (key, value) => { saved.set(key, structuredClone(value)); }
  };
  const braveCalls = new Map();
  let failingUrl = '';
  let archiveCalls = 0;
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      const count = (braveCalls.get(url.href) || 0) + 1;
      braveCalls.set(url.href, count);
      if (!failingUrl && url.pathname.includes('/news/')) failingUrl = url.href;
      if (url.href === failingUrl && count <= 2) {
        return Response.json({ error: 'temporary' }, { status: 503 });
      }
      return Response.json(url.pathname.includes('/news/') ? { results: [] } : { web: { results: [] } });
    }
    if (url.hostname === 'api.gdeltproject.org') {
      archiveCalls += 1;
      return Response.json({ articles: [] });
    }
    throw new Error(`unexpected_network_call:${url.hostname}`);
  };
  const first = await screenAdverseMedia({ request, apiKey: 'test', fetchImpl, checkpoint });
  assert.equal(first.status, 'partial');
  assert.equal(first.coverage.source_status.global_news.failed, 1);
  const firstCalls = new Map(braveCalls);
  const second = await screenAdverseMedia({ request, apiKey: 'test', fetchImpl, checkpoint });
  assert.equal(second.coverage.source_status.global_news.failed, 0);
  assert.equal(second.usage.failed_search_queries, 0);
  assert.equal(archiveCalls, 1);
  for (const [url, count] of firstCalls) {
    assert.equal(braveCalls.get(url), count === 2 ? 3 : count, `unexpected repeated call: ${url}`);
  }
});

test('Brave payment failures are reported as missing coverage without redialing on retry', async () => {
  const request = validateAdverseMediaRequest({
    entity_type: 'business', name: 'Unfunded Provider Example 02', languages: ['en']
  });
  const saved = new Map();
  const checkpoint = {
    get: async (key) => saved.has(key) ? structuredClone(saved.get(key)) : null,
    save: async (key, value) => { saved.set(key, structuredClone(value)); }
  };
  let braveCalls = 0;
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      braveCalls += 1;
      return Response.json({ error: 'payment_required' }, { status: 402 });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    throw new Error(`unexpected_network_call:${url.hostname}`);
  };
  const first = await screenAdverseMedia({ request, apiKey: 'test', fetchImpl, checkpoint });
  const firstCalls = braveCalls;
  const second = await screenAdverseMedia({ request, apiKey: 'test', fetchImpl, checkpoint });
  assert.equal(first.status, 'partial');
  assert.equal(second.status, 'partial');
  assert.ok(firstCalls > 0);
  assert.equal(braveCalls, firstCalls);
  assert.equal(second.usage.paid_search_attempts, 0);
});

test('request-time search returns adverse article URLs about an alias from approved publishers without visiting publishers', async () => {
  const requestedHosts = [];
  const requestedQueries = [];
  const request = validateAdverseMediaRequest({ entity_type: 'individual', name: 'Alice Smith', aliases: ['A. Smith'], languages: ['en'], search_plus: true });
  const adverseResult = (url, title) => ({ url, title, description: 'A. Smith was charged with fraud.', page_age: '2026-10-20T10:00:00Z' });
  const fetchImpl = async (input) => {
    const url = new URL(input);
    requestedHosts.push(url.hostname);
    if (url.hostname === 'api.search.brave.com') {
      requestedQueries.push(url.searchParams.get('q'));
      assert.match(url.searchParams.get('q'), /A\. Smith/);
      const results = [
        adverseResult('https://www.nytimes.com/2026/10/20/business/fraud.html', 'A. Smith charged with fraud'),
        adverseResult('https://nytimes.com.evil.example/story', 'A. Smith charged with fraud'),
        adverseResult('https://example.com/story', 'A. Smith charged with fraud'),
        adverseResult('https://www.nytimes.com/', 'A. Smith charged with fraud'),
        { url: 'https://www.nytimes.com/2026/10/20/business/benign.html', title: 'A. Smith speaks at conference', description: 'A. Smith attended a conference.' }
      ];
      return Response.json(url.pathname.includes('/news/') ? { results } : { web: { results } });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    throw new Error(`unexpected_network_call:${url.hostname}`);
  };
  const raw = await screenAdverseMedia({ request, apiKey: 'test', fetchImpl });
  const response = presentAdverseMediaResponse(raw);
  assert.ok(response.results.some((item) => item.url === 'https://www.nytimes.com/2026/10/20/business/fraud.html' && item.search_plus_match));
  assert.ok(response.results.some((item) => item.url === 'https://example.com/story' && !item.search_plus_match));
  assert.equal(response.results.find((item) => item.search_plus_match).publisher, 'The New York Times');
  assert.equal(response.results.find((item) => item.search_plus_match).identity_match.type, 'exact_alias');
  assert.equal(response.results.find((item) => item.search_plus_match).risk_level, 'high');
  assert.equal(response.coverage.search_plus.publisher_catalog_size, 1500);
  assert.ok(response.coverage.search_plus.publishers_screened.length >= 30);
  assert.equal(response.coverage.search_plus.publishers_attempted, response.coverage.search_plus.publishers_screened.length);
  assert.deepEqual(response.coverage.search_plus.publishers_not_completed, []);
  assert.equal(response.coverage.search_plus.publisher_batches_attempted, response.coverage.search_plus.publisher_batches_completed);
  assert.ok(response.coverage.search_plus.matched_results >= 1);
  assert.ok(response.coverage.search_plus.matched_publishers.some((publisher) => publisher.domain === 'nytimes.com'));
  assert.equal(response.coverage.search_plus.exhaustive, false);
  assert.ok(requestedHosts.every((host) => ['api.search.brave.com', 'api.gdeltproject.org'].includes(host)));
  const publisherQueries = requestedHosts.length && raw.methodology ? raw.coverage.source_status.publisher_search : null;
  assert.ok(publisherQueries.attempted >= 3);
  assert.equal(publisherQueries.failed, 0);
  const publisherQueryText = requestedQueries.filter((query) => query.includes('site:')).join(' ');
  assert.ok(response.coverage.search_plus.publishers_screened.every((publisher) => publisherQueryText.includes(`site:${publisher.domain}`)));
  assert.ok(publisherQueryText.includes('site:nytimes.com'));
  assert.match(response.coverage.limitation, /site-restricted index queries/);
  assert.ok(raw.usage.reserved_provider_cost_upper_bound_usd <= 0.14);
  assert.equal(raw.usage.cost_guardrail_usd, 0.15);
});

test('results found only by a publisher-targeted query retain their publisher-search provenance', async () => {
  const request = validateAdverseMediaRequest({
    entity_type: 'individual', name: 'Alice Smith', languages: ['en'], search_plus: true
  });
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      const query = url.searchParams.get('q');
      const results = query.includes('site:nytimes.com')
        ? [{
            url: 'https://www.nytimes.com/2026/10/20/business/fraud.html',
            title: 'Alice Smith charged in fraud case',
            description: 'Alice Smith was charged with fraud.',
            page_age: '2026-10-20T10:00:00Z'
          }]
        : [];
      return Response.json(url.pathname.includes('/news/') ? { results } : { web: { results } });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    throw new Error(`unexpected_network_call:${url.hostname}`);
  };

  const response = presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey: 'test', fetchImpl }));
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].source_type, 'publisher_search');
  assert.equal(response.results[0].publisher, 'The New York Times');
  assert.ok(response.coverage.search_plus.matched_publishers.some((publisher) => publisher.domain === 'nytimes.com'));
});

test('Signzy data-leak coverage targets MediaNama and retains the exact cyber incident', async () => {
  const articleUrl = 'https://www.medianama.com/2024/12/223-signzy-customer-data-leak-exposes-growing-cybersecurity-gaps-in-india/';
  const queries = [];
  const request = validateAdverseMediaRequest({
    entity_type: 'business', name: 'Signzy', countries: ['IN'], languages: ['en', 'hi'], search_plus: true, max_results: 50
  });
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      const query = url.searchParams.get('q');
      queries.push(query);
      const results = query.includes('site:medianama.com') && query.includes('"data leak"')
        ? [{
            url: articleUrl,
            title: 'Signzy Customer Data Leak Exposes Growing Cybersecurity Gaps',
            description: 'Online ID verification services provider Signzy suffered a cyberattack that exposed customer data online.',
            page_age: '2024-12-04T08:00:00Z'
          }]
        : [];
      return Response.json(url.pathname.includes('/news/') ? { results } : { web: { results } });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    throw new Error(`unexpected_network_call:${url.hostname}`);
  };

  const response = presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey: 'test', fetchImpl }));
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].url, articleUrl.replace(/\/$/, ''));
  assert.equal(response.results[0].publisher, 'MediaNama');
  assert.equal(response.results[0].source_type, 'publisher_search');
  assert.equal(response.results[0].risk_level, 'high');
  assert.ok(response.results[0].categories.includes('cybersecurity_and_data_protection'));
  assert.ok(response.coverage.search_plus.publishers_screened.some((publisher) => publisher.domain === 'medianama.com'));
  assert.ok(response.coverage.search_plus.matched_publishers.some((publisher) => publisher.domain === 'medianama.com'));
  assert.ok(queries.some((query) => query.includes('"data breach"') || query.includes('"data leak"')));
});

test('corporate event vocabulary detects misconduct, founder disputes, layoffs, and financial distress', async () => {
  const queries = [];
  const request = validateAdverseMediaRequest({
    entity_type: 'business', name: 'Acme Holdings', countries: ['US'], languages: ['en'], max_results: 20
  });
  const evidence = [
    ['accounting', 'Acme Holdings faces accounting fraud allegations over falsified accounts'],
    ['founders', "Acme Holdings founder's breakup triggers a boardroom battle"],
    ['layoffs', 'Acme Holdings announces mass layoffs and workforce reduction'],
    ['liquidity', 'Acme Holdings misses debt payment amid liquidity crisis and cash crunch']
  ].map(([slug, title]) => ({
    url: `https://business.example/${slug}`,
    title,
    description: title,
    page_age: '2026-10-20T10:00:00Z'
  }));
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      queries.push(url.searchParams.get('q'));
      return Response.json(url.pathname.includes('/news/') ? { results: evidence } : { web: { results: evidence } });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    throw new Error(`unexpected_network_call:${url.hostname}`);
  };

  const response = presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey: 'test', fetchImpl }));
  const categoriesBySlug = Object.fromEntries(response.results.map((result) => [result.url.split('/').at(-1), result.categories]));
  assert.ok(categoriesBySlug.accounting.includes('corporate_misconduct'));
  assert.ok(categoriesBySlug.founders.includes('governance_and_leadership_dispute'));
  assert.ok(categoriesBySlug.layoffs.includes('workforce_and_restructuring'));
  assert.ok(categoriesBySlug.liquidity.includes('financial_distress'));
  assert.ok(queries.some((query) => query.includes('"founder dispute"') && query.includes('"layoffs"') && query.includes('"debt default"')));
});

test('association discovery runs when a supplied alias contains the full name', async () => {
  const queries = [];
  const request = validateAdverseMediaRequest({
    entity_type: 'individual', name: 'Prabhpreet Gill', aliases: ['Prabhpreet Singh Gill'], languages: ['en'], search_plus: true
  });
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      queries.push(url.searchParams.get('q'));
      return Response.json(url.pathname.includes('/news/') ? { results: [] } : { web: { results: [] } });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    throw new Error(`unexpected_network_call:${url.hostname}`);
  };
  const response = await screenAdverseMedia({ request, apiKey: 'test', aiApiKey: 'test', fetchImpl });
  assert.ok(queries.some((query) => query.includes('Prabhpreet Singh Gill') && query.includes('"founder"')));
  assert.equal(response.methodology.entity_resolution.status, 'completed');
  assert.ok(response.usage.reserved_provider_cost_upper_bound_usd <= 0.14);
});

test('publisher coverage separates completed batches from batches that exhaust retries', async () => {
  const request = validateAdverseMediaRequest({
    entity_type: 'business', name: 'Coverage Example', countries: ['AE'], languages: ['en'], search_plus: true
  });
  let failedPublisherQuery = '';
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      const query = url.searchParams.get('q');
      if (query.includes('site:gulfnews.com') && (!failedPublisherQuery || query === failedPublisherQuery)) {
        failedPublisherQuery ||= query;
        return Response.json({ error: 'temporary' }, { status: 503 });
      }
      return Response.json(url.pathname.includes('/news/') ? { results: [] } : { web: { results: [] } });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    throw new Error(`unexpected_network_call:${url.hostname}`);
  };

  const response = presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey: 'test', fetchImpl }));
  assert.ok(response.coverage.search_plus.publishers_screened.length > 0);
  assert.ok(response.coverage.search_plus.publishers_not_completed.length > 0);
  assert.equal(response.coverage.search_plus.publisher_batches_failed, 1);
  assert.ok(response.coverage.sources.some((source) => source.source === 'publisher_search' && source.status === 'partial'));
  assert.ok(response.coverage.reason_codes.includes('publisher_search_partial'));
});

test('identity scoring separates expanded full names from typo-like near matches', async () => {
  const run = async (evidenceName) => {
    const request = validateAdverseMediaRequest({ entity_type: 'individual', name: 'Arbaz Uddin', languages: ['en'] });
    const fetchImpl = async (input) => {
      const url = new URL(input);
      if (url.hostname === 'api.search.brave.com') {
        const result = { url: `https://example.com/${evidenceName.replaceAll(' ', '-')}`, title: `${evidenceName} charged in fraud case`, description: `${evidenceName} was charged with fraud.` };
        return Response.json(url.pathname.includes('/news/') ? { results: [result] } : { web: { results: [result] } });
      }
      if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
      throw new Error(`unexpected_network_call:${url.hostname}`);
    };
    return presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey: 'test', fetchImpl }));
  };

  const expanded = await run('Arbaz Siddiqui Uddin');
  assert.equal(expanded.results[0].identity_match.type, 'expanded_full_name');
  assert.equal(expanded.results[0].identity_match.score, 1);
  assert.equal(expanded.results[0].risk_level, 'high');
  assert.ok(expanded.results[0].risk_score >= 0.9);

  const near = await run('Arban Uddin');
  assert.equal(near.results[0].identity_match.type, 'near_match');
  assert.ok(near.results[0].identity_match.score < 0.9);
  assert.equal(near.results[0].risk_level, 'review');
  assert.ok(near.results[0].risk_score < 0.9);
});

test('identity scoring recognizes unsegmented CJK names inside headlines', async () => {
  const request = validateAdverseMediaRequest({ entity_type: 'business', name: '华信科技', languages: ['zh'] });
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      const result = { url: 'https://example.cn/case', title: '华信科技因欺诈被立案调查', description: '监管机构已立案调查。' };
      return Response.json(url.pathname.includes('/news/') ? { results: [result] } : { web: { results: [result] } });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    throw new Error(`unexpected_network_call:${url.hostname}`);
  };
  const response = presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey: 'test', fetchImpl }));
  assert.equal(response.results[0].identity_match.type, 'exact_name');
  assert.equal(response.results[0].identity_match.score, 1);
  assert.equal(response.results[0].risk_level, 'high');
});
