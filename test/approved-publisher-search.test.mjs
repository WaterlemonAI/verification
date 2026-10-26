import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedPublisherCount, approvedPublisherForUrl } from '../lib/approved-publishers.mjs';
import { presentAdverseMediaResponse, screenAdverseMedia, validateAdverseMediaRequest } from '../lib/adverse-media.mjs';

test('approved catalog matches direct publisher article URLs only', () => {
  assert.equal(approvedPublisherCount, 1499);
  assert.equal(approvedPublisherForUrl('https://www.nytimes.com/2026/10/20/business/story.html')?.name, 'The New York Times');
  for (const url of [
    'https://nytimes.com.evil.example/article',
    'http://nytimes.com/article',
    'https://nytimes.com/',
    'https://example.com/article'
  ]) assert.equal(approvedPublisherForUrl(url), null);
});

test('request-time search returns adverse article URLs about an alias from approved publishers without visiting publishers', async () => {
  const requestedHosts = [];
  const request = validateAdverseMediaRequest({ entity_type: 'individual', name: 'Alice Smith', aliases: ['A. Smith'], languages: ['en'], search_plus: true });
  const adverseResult = (url, title) => ({ url, title, description: 'A. Smith was charged with fraud.', page_age: '2026-10-20T10:00:00Z' });
  const fetchImpl = async (input) => {
    const url = new URL(input);
    requestedHosts.push(url.hostname);
    if (url.hostname === 'api.search.brave.com') {
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
  assert.equal(response.coverage.search_plus.publisher_catalog_size, 1499);
  assert.ok(response.coverage.search_plus.matched_results >= 1);
  assert.equal(response.coverage.search_plus.exhaustive, false);
  assert.ok(requestedHosts.every((host) => ['api.search.brave.com', 'api.gdeltproject.org'].includes(host)));
  assert.match(response.coverage.limitation, /every approved publisher is not individually queried/);
  assert.ok(raw.usage.reserved_provider_cost_upper_bound_usd <= 0.14);
  assert.equal(raw.usage.cost_guardrail_usd, 0.15);
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
  assert.equal(near.results[0].risk_level, 'intermediate');
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
