import test from 'node:test';
import assert from 'node:assert/strict';
import { screenAdverseMedia, validateAdverseMediaRequest } from '../lib/adverse-media.mjs';

test('repeated discovery snippets do not create bogus associations or make an organization-only article a high-risk person match', async () => {
  const searchQueries = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      const query = url.searchParams.get('q') || '';
      searchQueries.push(query);
      const result = query.includes('"founder"')
        ? {
          title: 'Samuel Bankman-Fried founder of FTX Trading',
          description: 'Samuel Bankman-Fried founder of FTX Trading',
          url: 'https://example.org/profile'
        }
        : {
          title: 'FTX Trading charged with fraud',
          description: 'FTX Trading charged with fraud investigation',
          url: 'https://example.org/ftx'
        };
      return new Response(JSON.stringify({ results: [result], web: { results: [result] } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ articles: [] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const request = validateAdverseMediaRequest({
    entity_type: 'individual', name: 'Samuel Bankman-Fried', countries: ['US'], languages: ['en']
  });
  const result = await screenAdverseMedia({ request, apiKey: 'test-only', fetchImpl });
  const associationQueries = searchQueries.filter((query) => query.includes('"FTX Trading"'));

  assert.equal(associationQueries.length, 2);
  assert.ok(associationQueries.every((query) => !query.includes('FTX Trading Samuel')));
  const associationOnly = result.results.find((item) => item.url === 'https://example.org/ftx');
  assert.ok(associationOnly);
  assert.equal(associationOnly.identity_match_type, 'associated_entity');
  assert.ok(associationOnly.risk_score < 0.9);
});
