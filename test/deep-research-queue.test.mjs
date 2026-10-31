import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepResearchCallbackHeaders, makeDeepResearchJob, startDeepResearchWorker } from '../lib/deep-research-queue.mjs';
import { MemoryAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryCustomerUsageStore } from '../lib/customer-usage.mjs';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');

const request = {
  entity_type: 'business', name: 'Example LLC', aliases: [], countries: ['AE'], languages: ['en', 'ar'],
  date_from: '', date_to: '', max_results: 25, risk_threshold: 0.65, deep_research: true,
  callback_url: 'https://example.com/webhook'
};

function messageFor(job) {
  return { messageId: 'message-1', popReceipt: 'receipt-1', messageText: JSON.stringify(job) };
}

test('deep-research callback sends optional Bearer key separately from its signature', () => {
  const event = { event: 'adverse_media.deep_research.completed', event_id: 'screening-1' };
  const job = makeDeepResearchJob(request, { callback_access_key: 'callback-token-123' });
  const headers = deepResearchCallbackHeaders(job, event, 'sha256=signed', 123);
  assert.equal(headers.authorization, 'Bearer callback-token-123');
  assert.equal(headers['x-ai7-signature'], 'sha256=signed');
  assert.equal(deepResearchCallbackHeaders(makeDeepResearchJob(request), event, 'sha256=signed', 123).authorization, undefined);
  assert.equal(JSON.stringify(job.request).includes('callback-token-123'), false);
});

test('worker pause rejects new deep-research submissions while API health remains available', async (t) => {
  const previousFlag = process.env.ADVERSE_MEDIA_WORKER_ENABLED;
  const previousQueueUrl = process.env.ADVERSE_MEDIA_QUEUE_URL;
  process.env.ADVERSE_MEDIA_WORKER_ENABLED = 'false';
  process.env.ADVERSE_MEDIA_QUEUE_URL = 'https://synthetic.queue.core.windows.net/adverse-media-deep-research';
  t.after(() => {
    if (previousFlag === undefined) delete process.env.ADVERSE_MEDIA_WORKER_ENABLED;
    else process.env.ADVERSE_MEDIA_WORKER_ENABLED = previousFlag;
    if (previousQueueUrl === undefined) delete process.env.ADVERSE_MEDIA_QUEUE_URL;
    else process.env.ADVERSE_MEDIA_QUEUE_URL = previousQueueUrl;
  });
  const store = new EnvironmentStore();
  const issued = await store.createClient('Synthetic customer');
  const app = createAppServer({ store, formsQueue: null, reportStore: new MemoryAdverseMediaReportStore(),
    usageStore: new MemoryCustomerUsageStore(), startWorker: false });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const response = await fetch(`${base}/service/adverse_media`, {
    method: 'POST', headers: { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'business', name: 'Synthetic LLC', languages: ['en'],
      deep_research: true, callback_url: 'https://example.com/webhook' })
  });
  assert.equal(response.status, 503);
});

test('deep research worker delivers a final partial result instead of silently waiting forever', async () => {
  const job = makeDeepResearchJob(request, { owner_id: 'synthetic-owner' });
  let deliveredResult;
  let released = false;
  let controller;
  const done = new Promise((resolve) => {
    const queue = {
      receive: async () => messageFor(job),
      complete: async () => { controller.stop(); resolve(); },
      release: async () => { released = true; }
    };
    controller = startDeepResearchWorker({
      queue,
      store: { getMasterKey: async () => 'configured' },
      resultStore: new MemoryAdverseMediaReportStore(),
      screen: async () => ({ status: 'partial', summary: { decision_eligible: false } }),
      present: (result) => ({ status: result.status, screening_id: result.screening_id, summary: result.summary }),
      finalize: async ({ response }) => ({ ...response, report: { report_id: 'report-partial', retention: 'permanent' } }),
      deliver: async (_job, result) => { deliveredResult = result; }
    });
  });
  await done;
  assert.equal(released, false);
  assert.equal(deliveredResult.status, 'partial');
  assert.equal(deliveredResult.summary.decision_eligible, false);
  assert.equal(deliveredResult.report.retention, 'permanent');
});

test('deep research worker delivers and removes a completed decision-eligible screening', async () => {
  const job = makeDeepResearchJob(request, { owner_id: 'synthetic-owner' });
  let released = false;
  let deliveredResult;
  let controller;
  const done = new Promise((resolve) => {
    const queue = {
      receive: async () => messageFor(job),
      release: async () => { released = true; },
      complete: async () => { controller.stop(); resolve(); }
    };
    controller = startDeepResearchWorker({
      queue,
      store: { getMasterKey: async () => 'configured' },
      resultStore: new MemoryAdverseMediaReportStore(),
      screen: async () => ({ status: 'completed', summary: { decision_eligible: true }, usage: { paid_search_queries: 3 } }),
      present: (result) => ({ status: result.status, screening_id: result.screening_id }),
      finalize: async ({ response }) => ({ ...response, report: { report_id: 'report-1', retention: 'permanent' } }),
      deliver: async (_job, result) => { deliveredResult = result; }
    });
  });
  await done;
  assert.equal(released, false);
  assert.equal(deliveredResult.screening_id, job.screening_id);
  assert.equal(deliveredResult.report.retention, 'permanent');
  assert.equal(deliveredResult.usage, undefined);
});

test('failed callbacks reuse the saved screening and make zero additional Brave calls', async () => {
  const job = makeDeepResearchJob(request, { owner_id: 'synthetic-owner' });
  const resultStore = new MemoryAdverseMediaReportStore();
  let available = true;
  let dequeueCount = 0;
  let screenCalls = 0;
  let braveCalls = 0;
  let deliveries = 0;
  let finalCaptures = 0;
  const callbackTimestamps = [];
  let releases = 0;
  let controller;
  const message = messageFor(job);
  const done = new Promise((resolve) => {
    const queue = {
      async receive() {
        if (!available) return null;
        available = false;
        message.dequeueCount = ++dequeueCount;
        return message;
      },
      async release(_message, nextJob) { releases += 1; message.messageText = JSON.stringify(nextJob); available = true; },
      async complete() { controller.stop(); resolve(); }
    };
    controller = startDeepResearchWorker({
      queue, resultStore,
      store: { getMasterKey: async () => 'configured' },
      fetchImpl: async () => { braveCalls += 1; return Response.json({ results: [] }); },
      screen: async ({ costGuard }) => {
        screenCalls += 1;
        await costGuard.fetch('https://api.search.brave.com/res/v1/news/search?q=synthetic');
        await costGuard.fetch('https://api.search.brave.com/res/v1/web/search?q=synthetic');
        return { status: 'completed', summary: { decision_eligible: true } };
      },
      finalize: async ({ response }) => ({ ...response, report: { report_id: 'saved-once' } }),
      onFinal: async (_job, response) => {
        assert.equal(response.report.report_id, 'saved-once');
        finalCaptures += 1;
      },
      deliver: async (deliveryJob) => {
        assert.ok(finalCaptures >= 1);
        deliveries += 1;
        callbackTimestamps.push(deliveryJob.callback_completed_at);
        if (deliveries < 3) throw new Error('callback_failed_503');
      }
    });
  });
  await done;
  assert.equal(screenCalls, 1);
  assert.equal(braveCalls, 2);
  assert.equal(deliveries, 3);
  assert.equal(finalCaptures, 3);
  assert.equal(new Set(callbackTimestamps).size, 1);
  assert.equal(releases, 2);
  assert.equal((await resultStore.getDeepResearchUsage({ ownerId: job.owner_id, screeningId: job.screening_id })).providerCalls.brave, 2);
  const terminal = await resultStore.getDeepResearchState({ ownerId: job.owner_id, screeningId: job.screening_id });
  assert.equal(terminal.stage, 'delivered');
  assert.equal(terminal.response, undefined);
});

test('incomplete screening retries missing components and sends one final callback', async () => {
  const job = makeDeepResearchJob(request, { owner_id: 'synthetic-owner' });
  const resultStore = new MemoryAdverseMediaReportStore();
  const message = messageFor(job);
  let available = true;
  let dequeueCount = 0;
  let screenCalls = 0;
  let braveCalls = 0;
  let deliveries = 0;
  let deliveredResult;
  let controller;
  const done = new Promise((resolve) => {
    controller = startDeepResearchWorker({
      queue: {
        async receive() {
          if (!available) return null;
          available = false;
          message.dequeueCount = ++dequeueCount;
          return message;
        },
        async release(_message, nextJob) { message.messageText = JSON.stringify(nextJob); available = true; },
        async complete() { controller.stop(); setImmediate(resolve); }
      },
      resultStore,
      store: { getMasterKey: async () => 'configured' },
      screen: async ({ checkpoint }) => {
        screenCalls += 1;
        if (!await checkpoint.get('brave:successful-query')) {
          braveCalls += 1;
          await checkpoint.save('brave:successful-query', { results: [{ url: 'https://example.com/article' }] });
        }
        return { status: screenCalls === 1 ? 'partial' : 'completed', coverage: { complete: screenCalls > 1 } };
      },
      deliver: async (_job, result) => { deliveries += 1; deliveredResult = result; }
    });
  });
  await done;
  assert.equal(screenCalls, 2);
  assert.equal(braveCalls, 1);
  assert.equal(deliveries, 1);
  assert.equal(deliveredResult.status, 'completed');
  assert.equal(await resultStore.getDeepResearchComponent({ ownerId: job.owner_id,
    screeningId: job.screening_id, componentKey: 'brave:successful-query' }), null);
});

test('unavailable components produce one final partial callback after bounded retries', async () => {
  const job = makeDeepResearchJob(request, { owner_id: 'synthetic-owner' });
  const resultStore = new MemoryAdverseMediaReportStore();
  const message = messageFor(job);
  let available = true;
  let attempts = 0;
  let deliveries = 0;
  let finalResult;
  let controller;
  const done = new Promise((resolve) => {
    controller = startDeepResearchWorker({
      queue: {
        async receive() {
          if (!available) return null;
          available = false;
          message.dequeueCount = ++attempts;
          return message;
        },
        async release(_message, nextJob) { message.messageText = JSON.stringify(nextJob); available = true; },
        async complete() { controller.stop(); resolve(); }
      },
      resultStore,
      store: { getMasterKey: async () => 'configured' },
      screen: async ({ checkpoint }) => {
        if (!await checkpoint.get('brave:completed-query')) {
          await checkpoint.save('brave:completed-query', { results: [{ url: 'https://example.com/article' }] });
        }
        return { status: 'partial', coverage: { complete: false },
          summary: { decision_eligible: false }, results: [{ url: 'https://example.com/article' }] };
      },
      deliver: async (_job, result) => { deliveries += 1; finalResult = result; }
    });
  });
  await done;
  assert.equal(attempts, 2);
  assert.equal(deliveries, 1);
  assert.equal(finalResult.status, 'partial');
  assert.equal(finalResult.summary.decision_eligible, false);
  assert.equal(finalResult.results.length, 1);
});

test('callback attempts are bounded and exhausted jobs move to the dead-letter queue', async () => {
  const job = makeDeepResearchJob(request, { owner_id: 'synthetic-owner' });
  const resultStore = new MemoryAdverseMediaReportStore();
  let available = true;
  let dequeueCount = 0;
  let screenCalls = 0;
  let deliveries = 0;
  let deadLettered;
  let controller;
  const message = messageFor(job);
  const done = new Promise((resolve) => {
    const queue = {
      async receive() {
        if (!available) return null;
        available = false;
        message.dequeueCount = ++dequeueCount;
        return message;
      },
      async release(_message, nextJob) { message.messageText = JSON.stringify(nextJob); available = true; },
      async deadLetter(_message, nextJob, reason) { deadLettered = { job: nextJob, reason }; },
      async complete() { controller.stop(); resolve(); }
    };
    controller = startDeepResearchWorker({
      queue, resultStore,
      store: { getMasterKey: async () => 'configured' },
      screen: async () => { screenCalls += 1; return { status: 'completed' }; },
      deliver: async () => { deliveries += 1; throw new Error('callback_failed_503'); }
    });
  });
  await done;
  assert.equal(screenCalls, 1);
  assert.equal(deliveries, 5);
  assert.equal(deadLettered.reason, 'callback_failed_503');
  assert.equal(deadLettered.job.callback_attempts, 5);
  assert.equal((await resultStore.getDeepResearchState({ ownerId: job.owner_id, screeningId: job.screening_id })).stage, 'finalized');
});

test('queue acknowledgement retry does not redeliver a completed callback or rerun screening', async () => {
  const job = makeDeepResearchJob(request, { owner_id: 'synthetic-owner' });
  const resultStore = new MemoryAdverseMediaReportStore();
  const message = messageFor(job);
  let dequeueCount = 0;
  let available = true;
  let screenings = 0;
  let deliveries = 0;
  let acknowledgements = 0;
  let controller;
  const done = new Promise((resolve) => {
    controller = startDeepResearchWorker({
      queue: {
        async receive() {
          if (!available) return null;
          available = false;
          message.dequeueCount = ++dequeueCount;
          return message;
        },
        async release(_message, nextJob) { message.messageText = JSON.stringify(nextJob); available = true; },
        async complete() {
          acknowledgements += 1;
          if (acknowledgements === 1) throw new Error('queue_ack_unavailable');
          controller.stop();
          resolve();
        }
      },
      resultStore,
      store: { getMasterKey: async () => 'configured' },
      screen: async () => { screenings += 1; return { status: 'completed' }; },
      deliver: async () => { deliveries += 1; }
    });
  });
  await done;
  assert.equal(screenings, 1);
  assert.equal(deliveries, 1);
  assert.equal(acknowledgements, 2);
});

test('a late duplicate receipt sees the delivered tombstone and makes no provider or callback call', async () => {
  const job = makeDeepResearchJob(request, { owner_id: 'synthetic-owner' });
  const resultStore = new MemoryAdverseMediaReportStore();
  await resultStore.saveDeepResearchState({ ownerId: job.owner_id, screeningId: job.screening_id,
    state: { stage: 'delivered', report_id: job.report_id, delivered_at: '2026-10-27T00:00:00.000Z' } });
  let screened = false;
  let delivered = false;
  let controller;
  const done = new Promise((resolve) => {
    controller = startDeepResearchWorker({
      queue: {
        receive: async () => messageFor(job),
        complete: async () => { controller.stop(); resolve(); }
      },
      resultStore,
      store: { getMasterKey: async () => 'configured' },
      screen: async () => { screened = true; },
      deliver: async () => { delivered = true; }
    });
  });
  await done;
  assert.equal(screened, false);
  assert.equal(delivered, false);
});

test('report-finalization failures retry from saved screening and are dead-lettered after three attempts', async () => {
  const job = makeDeepResearchJob(request, { owner_id: 'synthetic-owner' });
  const resultStore = new MemoryAdverseMediaReportStore();
  let available = true;
  let dequeueCount = 0;
  let screenings = 0;
  let finalizations = 0;
  let deadLetterReason;
  let controller;
  const message = messageFor(job);
  const done = new Promise((resolve) => {
    controller = startDeepResearchWorker({
      queue: {
        async receive() {
          if (!available) return null;
          available = false;
          message.dequeueCount = ++dequeueCount;
          return message;
        },
        async release(_message, nextJob) { message.messageText = JSON.stringify(nextJob); available = true; },
        async deadLetter(_message, _job, reason) { deadLetterReason = reason; },
        async complete() { controller.stop(); resolve(); }
      },
      resultStore,
      store: { getMasterKey: async () => 'configured' },
      screen: async () => { screenings += 1; return { status: 'completed' }; },
      finalize: async () => { finalizations += 1; throw new Error('report_service_unavailable'); }
    });
  });
  await done;
  assert.equal(screenings, 1);
  assert.equal(finalizations, 3);
  assert.equal(deadLetterReason, 'report_service_unavailable');
  assert.equal((await resultStore.getDeepResearchState({ ownerId: job.owner_id, screeningId: job.screening_id })).stage, 'screened');
});

test('incomplete screenings stop after two attempts and dead-letter without an unbounded search loop', async () => {
  const job = makeDeepResearchJob(request, { owner_id: 'synthetic-owner' });
  const resultStore = new MemoryAdverseMediaReportStore();
  let available = true;
  let dequeueCount = 0;
  let screenings = 0;
  let braveCalls = 0;
  let deadLetterReason;
  let controller;
  const message = messageFor(job);
  const done = new Promise((resolve) => {
    controller = startDeepResearchWorker({
      queue: {
        async receive() {
          if (!available) return null;
          available = false;
          message.dequeueCount = ++dequeueCount;
          return message;
        },
        async release(_message, nextJob) { message.messageText = JSON.stringify(nextJob); available = true; },
        async deadLetter(_message, _job, reason) { deadLetterReason = reason; },
        async complete() { controller.stop(); resolve(); }
      },
      resultStore,
      store: { getMasterKey: async () => 'configured' },
      fetchImpl: async () => { braveCalls += 1; return Response.json({}); },
      screen: async ({ costGuard }) => {
        screenings += 1;
        await costGuard.fetch('https://api.search.brave.com/res/v1/news/search?q=synthetic');
        throw new Error('search_provider_unavailable');
      }
    });
  });
  await done;
  assert.equal(screenings, 2);
  assert.equal(braveCalls, 2);
  assert.equal(deadLetterReason, 'search_provider_unavailable');
  assert.equal((await resultStore.getDeepResearchUsage({ ownerId: job.owner_id, screeningId: job.screening_id })).providerCalls.brave, 2);
});

test('legacy queued jobs are quarantined before any provider call', async () => {
  const job = { ...makeDeepResearchJob(request, { owner_id: 'synthetic-owner' }), version: 1 };
  let screened = false;
  let reason;
  let controller;
  const done = new Promise((resolve) => {
    controller = startDeepResearchWorker({
      queue: {
        receive: async () => messageFor(job),
        deadLetter: async (_message, _job, value) => { reason = value; },
        complete: async () => { controller.stop(); resolve(); }
      },
      resultStore: new MemoryAdverseMediaReportStore(),
      store: { getMasterKey: async () => 'configured' },
      screen: async () => { screened = true; }
    });
  });
  await done;
  assert.equal(reason, 'legacy_job_requires_review');
  assert.equal(screened, false);
});
