import assert from 'node:assert/strict';
import test from 'node:test';
import { screenAdverseMedia, validateAdverseMediaRequest } from '../lib/adverse-media.mjs';

test('Search+ reserves every allowed language and publisher queries with association searches', async () => {
  const request = validateAdverseMediaRequest({ entity_type: 'individual', name: 'Ada Beth Chen',
    languages: ['en', 'ar', 'fr', 'es', 'id'], search_plus: true });
  const paidQueries = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      const query = url.searchParams.get('q');
      paidQueries.push(query);
      const discovery = query.includes('"also known as"') && query.includes('"founder"');
      const results = discovery ? [{ title: 'Ada Beth Chen — Cobalt Holdings',
        description: 'Ada Beth Chen is founder of Cobalt Holdings.',
        url: 'https://example.org/people/ada-beth-chen' }] : [];
      return Response.json(url.pathname.includes('/news/') ? { results } : { web: { results } });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    throw new Error(`Unexpected search provider: ${url.hostname}`);
  };
  const result = await screenAdverseMedia({ request, apiKey: 'synthetic', fetchImpl,
    aiClassifier: async (results) => ({ status: 'not_needed', results, candidates: 0,
      inputTokens: 0, outputTokens: 0, cost: 0 }) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.coverage.languages_not_searched, []);
  assert.ok(result.coverage.search_plus.publisher_batches_attempted >= 1);
  assert.ok(result.coverage.search_plus.publishers_attempted > 0);
  assert.ok(paidQueries.some((query) => query.includes('"Cobalt Holdings"')));
  assert.ok(paidQueries.length <= 20);
});

test('Search+ adds publisher queries without removing any base Brave query', async () => {
  const observed = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    observed.push({ path: url.pathname, query: url.searchParams.get('q') });
    return Response.json(url.pathname.includes('/news/') ? { results: [] } : { web: { results: [] } });
  };
  const run = async (searchPlus) => {
    observed.length = 0;
    const request = validateAdverseMediaRequest({ entity_type: 'business', name: 'Example Group',
      countries: ['AE'], languages: ['en', 'ar'], search_plus: searchPlus });
    await screenAdverseMedia({ request, apiKey: 'test', fetchImpl,
      archiveSearch: async () => ({ results: [], complete: true, origin: 'local', state: null }) });
    return [...observed];
  };
  const standard = await run(false);
  const plus = await run(true);
  assert.ok(standard.length > 0);
  assert.ok(plus.length > standard.length);
  for (const query of standard) assert.ok(plus.some((candidate) => candidate.path === query.path
    && candidate.query === query.query), query.query);
  assert.ok(plus.some((query) => query.query.includes('site:')));
});
