import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
const apiKey = 'ai7_adverse_test_key';
process.env.AI7_API_KEY_HASHES = createHash('sha256').update(apiKey).digest('hex');

const { createAppServer } = await import('../server.mjs');
const { EnvironmentStore } = await import('../lib/api-store.mjs');

const store = new EnvironmentStore();
await store.setMasterKey('adverse-media', 'private-search-key');

let app;
let appUrl;
const requests = [];

const indexedResult = {
  title: 'John Example charged in international fraud investigation',
  url: 'https://publisher.example/news/john-example?utm_source=test',
  description: 'Prosecutors charged John Example with fraud and money laundering after an investigation.',
  page_age: '2026-10-20T10:00:00Z',
  meta_url: { hostname: 'publisher.example' },
  extra_snippets: ['The criminal prosecution remains before the court.']
};

before(async () => {
  app = createAppServer({
    store,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      assert.equal(url.hostname, 'api.search.brave.com');
      assert.equal(options.headers['x-subscription-token'], 'private-search-key');
      assert.ok(url.searchParams.get('q').includes('John Example'));
      if (url.pathname.includes('/news/')) return Response.json({ results: [indexedResult] });
      return Response.json({ web: { results: [indexedResult] } });
    }
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${app.address().port}`;
});

after(async () => new Promise((resolve) => app.close(resolve)));

test('adverse media endpoint authenticates, searches, deduplicates, classifies, and reports cost usage', async () => {
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      entity_type: 'individual',
      name: 'John Example',
      aliases: ['J Example'],
      countries: ['AE'],
      languages: ['en'],
      date_from: '2025-01-01',
      max_results: 25
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'completed');
  assert.equal(body.entity.name, 'John Example');
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].legal_stage, 'charged');
  assert.ok(body.results[0].categories.includes('financial_crime'));
  assert.equal(body.results[0].url, 'https://publisher.example/news/john-example');
  assert.equal(body.results[0].review_required, true);
  assert.equal(body.usage.paid_search_queries, 3);
  assert.equal(body.usage.estimated_search_cost_usd, 0.015);
  assert.equal(body.usage.cost_guardrail_usd, 0.12);
  assert.equal(requests.length, 3);
});

test('identical checks reuse cached evidence without paid search calls', async () => {
  const beforeCount = requests.length;
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      entity_type: 'individual', name: 'John Example', aliases: ['J Example'], countries: ['AE'],
      languages: ['en'], date_from: '2025-01-01', max_results: 25
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.usage.cache_hit, true);
  assert.equal(body.usage.paid_search_queries, 0);
  assert.equal(requests.length, beforeCount);
});

test('adverse media endpoint validates credentials and input', async () => {
  const unauthorized = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity_type: 'business', name: 'Example LLC' })
  });
  assert.equal(unauthorized.status, 401);

  const invalid = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'person', name: 'A', languages: ['en', 'ar', 'fr', 'es', 'ru', 'hi'] })
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /entity_type|name|languages/);
});

test('public documentation exposes the complete route without provider or key details', async () => {
  const html = await (await fetch(`${appUrl}/adverse-media`)).text();
  const script = await (await fetch(`${appUrl}/adverse-media.js`)).text();
  const specText = await (await fetch(`${appUrl}/openapi.json`)).text();
  const spec = JSON.parse(specText);
  assert.ok(Object.hasOwn(spec.paths, '/service/adverse_media'));
  for (const field of ['entity_type', 'name', 'aliases', 'countries', 'languages', 'date_from', 'date_to', 'max_results']) {
    assert.ok(Object.hasOwn(spec.components.schemas.AdverseMediaRequest.properties, field));
    assert.ok(html.includes(field));
  }
  for (const publicAsset of [html, script, specText]) {
    assert.equal(publicAsset.toLowerCase().includes('brave'), false);
    assert.equal(publicAsset.includes('private-search-key'), false);
  }
});
