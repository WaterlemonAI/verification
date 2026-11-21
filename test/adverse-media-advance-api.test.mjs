import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryCustomerUsageStore, validateUsagePolicy } from '../lib/customer-usage.mjs';
import { MemoryAdvanceAdmissionStore } from '../lib/adverse-media-advance-store.mjs';
import { MemoryAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';
import { MemoryAdverseMediaJsonStore } from '../lib/adverse-media-json-store.mjs';

process.env.NODE_ENV = 'test';
process.env.ADVERSE_MEDIA_ADVANCE_ENABLED = 'true';
process.env.GDELT_ARCHIVE_REVIEW_ENABLED = 'true';
process.env.ADVERSE_MEDIA_WORKER_ENABLED = 'true';
const { createAppServer } = await import('../server.mjs');

const store = new EnvironmentStore();
const usageStore = new MemoryCustomerUsageStore();
const admissionStore = new MemoryAdvanceAdmissionStore();
const reportStore = new MemoryAdverseMediaReportStore();
const jsonStore = new MemoryAdverseMediaJsonStore();
const jobs = [];
let issued;
let app;
let base;

before(async () => {
  issued = await store.createClient('Advance API test workspace');
  const policy = validateUsagePolicy({ mode: 'postpay', currency: 'USD',
    allowed_modules: ['adverse-media-advance'],
    rates: { 'adverse-media-advance': [{ up_to: null, price: '0.75' }] }
  }, new Set(['adverse-media-advance']));
  await usageStore.configure(issued.client.id, policy);
  app = createAppServer({ store, usageStore, advanceAdmissionStore: admissionStore,
    reportStore, jsonStore,
    deepResearchQueue: { async enqueue(job) { jobs.push(job); } },
    adverseArchiveReviewStep: async () => ({ status: 'completed' }), startWorker: false });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});

after(async () => new Promise((resolve) => app.close(resolve)));

const input = { entity_type: 'business', name: 'Example Trading LLC', languages: ['en', 'ar'],
  callback_url: 'https://example.com/webhook', policy_selection: 'all',
  identifiers: { registration_numbers: ['123456'] } };
const headers = (key) => ({ authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json',
  'idempotency-key': key });

test('Advance admission queues one Search+ archive job and replays without a second charge', async () => {
  const key = 'advance-api-primary-0001';
  const first = await fetch(`${base}/service/adverse_media_advance`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(input) });
  assert.equal(first.status, 202);
  const receipt = await first.json();
  assert.match(receipt.callback.signing_secret, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(receipt.callback.event, 'adverse_media.advance.completed');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].request.search_plus, true);
  assert.equal(jobs[0].request.archive_all_stored, true);
  assert.equal(jobs[0].archive_review_enabled, true);
  assert.equal(jobs[0].owner_id, `workspace-${issued.client.id}`);
  assert.equal(jobs[0].advance.policy_set.policies.length, 64);
  assert.deepEqual(jobs[0].advance.identifiers.registration_numbers, ['123456']);

  const queued = await fetch(`${base}/service/adverse_media_advance/jobs/${receipt.screening_id}`,
    { headers: { authorization: `Bearer ${issued.apiKey}` } });
  assert.equal(queued.status, 200);
  assert.equal((await queued.json()).status, 'queued');

  const replay = await fetch(`${base}/service/adverse_media_advance`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(input) });
  assert.equal(replay.status, 202);
  const replayReceipt = await replay.json();
  assert.equal(replayReceipt.screening_id, receipt.screening_id);
  assert.equal(replayReceipt.callback.signing_secret, undefined);
  assert.equal(jobs.length, 1);
  assert.equal((await usageStore.account(issued.client.id)).charged_calls, 1);

  const ownerId = `workspace-${issued.client.id}`;
  const result = { screening_id: receipt.screening_id, status: 'completed',
    summary: { profile_status: 'inconclusive' }, report: { report_id: jobs[0].report_id } };
  await jsonStore.save({ ownerId, screeningId: receipt.screening_id, response: result,
    input: input, transactionId: 'test-transaction' });
  await reportStore.saveDeepResearchState({ ownerId, screeningId: receipt.screening_id,
    state: { stage: 'finalized', response: result } });
  const completed = await fetch(`${base}/service/adverse_media_advance/jobs/${receipt.screening_id}`,
    { headers: { authorization: `Bearer ${issued.apiKey}` } });
  assert.equal(completed.status, 200);
  const completedBody = await completed.json();
  assert.equal(completedBody.status, 'completed');
  assert.equal(completedBody.callback_delivery, 'not_confirmed');
  assert.deepEqual(completedBody.result, result);
  const stranger = await store.createClient('Separate workspace');
  const isolated = await fetch(`${base}/service/adverse_media_advance/jobs/${receipt.screening_id}`,
    { headers: { authorization: `Bearer ${stranger.apiKey}` } });
  assert.equal(isolated.status, 403);
  const unauthenticated = await fetch(`${base}/service/adverse_media_advance/jobs/${receipt.screening_id}`);
  assert.equal(unauthenticated.status, 401);

  const conflict = await fetch(`${base}/service/adverse_media_advance`, {
    method: 'POST', headers: headers(key), body: JSON.stringify({ ...input, name: 'Different Trading LLC' }) });
  assert.equal(conflict.status, 409);
  assert.equal(jobs.length, 1);
});

test('Advance rejects caller provider controls and missing idempotency without queueing', async () => {
  const invalid = await fetch(`${base}/service/adverse_media_advance`, {
    method: 'POST', headers: headers('advance-api-invalid-0001'),
    body: JSON.stringify({ ...input, search_plus: false }) });
  assert.equal(invalid.status, 400);
  const missingKey = await fetch(`${base}/service/adverse_media_advance`, {
    method: 'POST', headers: { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(input) });
  assert.equal(missingKey.status, 400);
  assert.equal(jobs.length, 1);
});
