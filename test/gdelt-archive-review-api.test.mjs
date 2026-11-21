import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../server.mjs';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryAdverseMediaReportStore, reportOwnerId } from '../lib/adverse-media-report-store.mjs';

test('archive evidence route is owner scoped, bounded and never public', async (t) => {
  const store = new EnvironmentStore();
  const first = await store.createClient('Archive reviewer one');
  const second = await store.createClient('Archive reviewer two');
  const reports = new MemoryAdverseMediaReportStore();
  const reviewId = 'a'.repeat(32);
  const ownerId = reportOwnerId(first.apiKey);
  await reports.saveArchiveReview({ ownerId, reviewId, state: {
    review_id: reviewId, status: 'inconclusive', expected_postings: 1,
    postings_scanned: 1, unique_articles: 1, adverse: 0, unresolved: 1,
    snapshot: { coverage_start: '2026-11-20T01:00:00.000Z', coverage_end: '2026-11-20T01:15:00.000Z' }
  } });
  await reports.saveArchiveReviewItem({ ownerId, reviewId, articleId: 'b'.repeat(64), item: {
    url: 'https://publisher.example/article', status: 'unresolved', reason: 'article_evidence_unavailable'
  } });
  for (let index = 0; index < 100; index += 1) {
    await reports.saveArchiveReviewItem({ ownerId, reviewId,
      articleId: index.toString(16).padStart(64, '0'), item: {
        url: `https://publisher.example/other-${index}`, status: 'unresolved', reason: 'article_evidence_unavailable'
      } });
  }
  const app = createAppServer({ store, reportStore: reports, startWorker: false });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.address().port}/service/adverse_media/reviews/${reviewId}/evidence`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${second.apiKey}` } })).status, 404);
  const response = await fetch(url, { headers: { authorization: `Bearer ${first.apiKey}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const body = await response.json();
  assert.equal(body.counts.postings_scanned, 1);
  assert.equal(body.items.length, 100);
  assert.equal(body.items[0].status, 'unresolved');
  assert.ok(body.next_cursor);
  const next = await fetch(`${url}?cursor=${encodeURIComponent(body.next_cursor)}`,
    { headers: { authorization: `Bearer ${first.apiKey}` } });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).items.length, 1);
  assert.equal((await fetch(`${url}?cursor=%0A`, { headers: { authorization: `Bearer ${first.apiKey}` } })).status, 400);
});
