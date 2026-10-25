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
  const request = validateAdverseMediaRequest({ entity_type: 'individual', name: 'Alice Smith', aliases: ['A. Smith'], languages: ['en'] });
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
  const raw = await screenAdverseMedia({ request, apiKey: 'test', fetchImpl, approvedPublisherSearchEnabled: true });
  const response = presentAdverseMediaResponse(raw);
  assert.deepEqual(response.results.map((item) => item.url), ['https://www.nytimes.com/2026/10/20/business/fraud.html']);
  assert.equal(response.results[0].publisher, 'The New York Times');
  assert.ok(requestedHosts.every((host) => ['api.search.brave.com', 'api.gdeltproject.org'].includes(host)));
  assert.match(response.coverage.limitation, /every approved publisher is not individually searched/);
  assert.ok(raw.usage.reserved_provider_cost_upper_bound_usd <= 0.07);
  assert.equal(raw.usage.cost_guardrail_usd, 0.08);
});

test('association discovery runs when a supplied alias contains the full name', async () => {
  const queries = [];
  const request = validateAdverseMediaRequest({
    entity_type: 'individual', name: 'Prabhpreet Gill', aliases: ['Prabhpreet Singh Gill'], languages: ['en']
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
  const response = await screenAdverseMedia({ request, apiKey: 'test', aiApiKey: 'test', fetchImpl, approvedPublisherSearchEnabled: true });
  assert.ok(queries.some((query) => query.includes('Prabhpreet Singh Gill') && query.includes('"founder"')));
  assert.equal(response.methodology.entity_resolution.status, 'completed');
  assert.ok(response.usage.reserved_provider_cost_upper_bound_usd <= 0.07);
});
