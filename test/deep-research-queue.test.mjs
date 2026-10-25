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

test('deep research worker retains incomplete screenings for a later retry', async () => {
  const job = makeDeepResearchJob(request);
  let delivered = false;
  let completed = false;
  let controller;
  const done = new Promise((resolve) => {
    const queue = {
      receive: async () => messageFor(job),
      complete: async () => { completed = true; },
      release: async (_message, releasedJob, seconds) => {
        assert.equal(releasedJob.screening_id, job.screening_id);
        assert.equal(seconds, 15 * 60);
        controller.stop();
        resolve();
      }
    };
    controller = startDeepResearchWorker({
      queue,
      store: { getMasterKey: async () => 'configured' },
      screen: async () => ({ status: 'partial', summary: { decision_eligible: false } }),
      deliver: async () => { delivered = true; }
    });
  });
  await done;
  assert.equal(delivered, false);
  assert.equal(completed, false);
});

test('deep research worker delivers and removes only a completed decision-eligible screening', async () => {
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
      deliver: async (_job, result) => { deliveredResult = result; }
    });
  });
  await done;
  assert.equal(released, false);
  assert.equal(deliveredResult.screening_id, job.screening_id);
  assert.equal(deliveredResult.usage, undefined);
});
