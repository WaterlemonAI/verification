import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.GDELT_PUBLIC_FALLBACK_ENABLED = 'false';
process.env.API_PUBLIC_BASE_URL = 'https://api.ai7uae.com';
const apiKey = 'ai7_archive_route_test_key';
process.env.AI7_API_KEY_HASHES = createHash('sha256').update(apiKey).digest('hex');

const { createAppServer } = await import('../server.mjs');
const { EnvironmentStore } = await import('../lib/api-store.mjs');
const { globalArchiveSearch } = await import('../lib/adverse-media.mjs');
const { searchLocalGdeltIndex } = await import('../lib/gdelt-local-index.mjs');

const store = new EnvironmentStore();
await store.setMasterKey('adverse-media', 'test-search-key');
await store.setMasterKey('adverse-media-ai', 'test-ai-key');
const state = {
  coverage_start: '2026-10-22T21:15:00Z',
  coverage_end: new Date(Date.now() - 60 * 60_000).toISOString(),
  last_successful_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  files_processed: 2610,
  entity_mentions_indexed: 36940000
};
const archiveRequests = [];
const externalCalls = [];
const tableFilters = [];
let app;
let baseUrl;

before(async () => {
  app = createAppServer({ store, startWorker: false,
    adverseArchiveSearch: (request, fetchImpl) => globalArchiveSearch(request, fetchImpl, async (input) => {
      archiveRequests.push({ name: input.name, date_from: input.date_from, date_to: input.date_to,
        all_stored: input.archive_all_stored });
      return searchLocalGdeltIndex(input, {
        state,
        clients: { table: { async *listEntities({ queryOptions }) {
          tableFilters.push(String(queryOptions.filter));
        } } }
      });
    }),
    fetchImpl: async (input) => {
      const url = new URL(input);
      externalCalls.push(url);
      assert.equal(url.hostname, 'api.search.brave.com', `Unexpected external provider: ${url.hostname}`);
      if (url.pathname.includes('/news/')) return Response.json({ results: [] });
      return Response.json({ web: { results: [] } });
    }
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${app.address().port}`;
});

after(async () => {
  if (app) await new Promise((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
});

const cases = [
  { name: 'DP World', date_from: '2024-07-15', expected: 'partial' },
  { name: 'Emirates NBD', date_from: '2025-06-01', expected: 'partial' },
  { name: 'Etihad Airways', date_from: '2026-10-21', expected: 'partial' },
  { name: 'DP World', date_from: '2026-10-24', expected: 'completed' },
  { name: 'Emirates NBD', date_from: '2026-10-24', expected: 'completed' },
  { name: 'Etihad Airways', date_from: '2026-10-24', expected: 'completed' }
];

for (const scenario of cases) {
  test(`full HTTP screening and report: ${scenario.name} from ${scenario.date_from}`, async () => {
    const beforeArchive = archiveRequests.length;
    const beforeCalls = externalCalls.length;
    const response = await fetch(`${baseUrl}/service/adverse_media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ entity_type: 'business', name: scenario.name,
        countries: ['AE'], languages: ['en'], date_from: scenario.date_from,
        max_results: 5 })
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.entity.name, scenario.name);
    assert.equal(body.status, scenario.expected);
    assert.equal(body.coverage.complete, scenario.expected === 'completed');
    assert.equal(body.coverage.archive_origin,
      scenario.expected === 'completed' ? 'local_index' : 'local_index_partial');
    assert.equal(body.coverage.archive_reason_code,
      scenario.expected === 'completed' ? null : 'requested_window_not_covered');
    assert.equal(body.coverage.archive_scan.truncated, false);
    assert.equal(body.coverage.archive_scan.rows_scanned, 0);
    assert.equal(body.summary.decision_eligible, scenario.expected === 'completed');
    assert.equal(archiveRequests.length, beforeArchive + 1);
    assert.equal(archiveRequests.at(-1).date_from, scenario.date_from);
    assert.ok(externalCalls.length > beforeCalls);
    assert.ok(externalCalls.slice(beforeCalls).every((url) => url.hostname === 'api.search.brave.com'));
    const report = await fetch(`${baseUrl}${new URL(body.report.download_url).pathname}`);
    assert.equal(report.status, 200);
    assert.equal(report.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await report.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.match(body.report.sha256, /^[0-9a-f]{64}$/);
  });
}

test('the archive adapter used date-bounded Azure Table RowKey filters', () => {
  assert.ok(tableFilters.length >= cases.length * 2);
  assert.ok(tableFilters.every((filter) => filter.includes('RowKey ge') && filter.includes('RowKey lt')));
});
