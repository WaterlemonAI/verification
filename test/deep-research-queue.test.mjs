import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDeepResearchJob, startDeepResearchWorker } from '../lib/deep-research-queue.mjs';

const request = {
  entity_type: 'business', name: 'Example LLC', aliases: [], countries: ['AE'], languages: ['en', 'ar'],
  date_from: '', date_to: '', max_results: 25, risk_threshold: 0.65, deep_research: true,
  callback_url: 'https://example.com/webhook'
};

function messageFor(job) {
  return { messageId: 'message-1', popReceipt: 'receipt-1', messageText: JSON.stringify(job) };
}

test('deep research worker delivers a final partial result instead of silently waiting forever', async () => {
  const job = makeDeepResearchJob(request);
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
  const job = makeDeepResearchJob(request);
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
