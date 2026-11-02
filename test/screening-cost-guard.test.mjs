import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreeningCostGuard, MAX_PROVIDER_COST_USD, MAX_SCREENING_COST_USD } from '../lib/screening-cost-guard.mjs';
import { createAdverseMediaNarrative } from '../lib/adverse-media-report.mjs';
import { MemoryAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';

test('each paid search attempt, including retries, is admitted before dialing', async () => {
  let dialed = 0;
  const guard = createScreeningCostGuard(async () => { dialed += 1; return new Response(null, { status: 503 }); });
  const url = 'https://api.search.brave.com/res/v1/news/search?q=test';
  for (let attempt = 0; attempt < 28; attempt += 1) await guard.fetch(url);
  assert.equal(guard.reservedProviderCostUsd, MAX_PROVIDER_COST_USD);
  await assert.rejects(guard.fetch(url), /screening_cost_limit/);
  assert.equal(dialed, 28);
  assert.equal(Math.round((MAX_SCREENING_COST_USD - MAX_PROVIDER_COST_USD) * 100), 1);
});

test('a restarted job cannot reset its lifetime provider allowance', async () => {
  const resultStore = new MemoryAdverseMediaReportStore();
  const job = { ownerId: 'synthetic-owner', screeningId: 'synthetic-screening' };
  let dialed = 0;
  const reserve = ({ costMicroUsd, provider, maxMicroUsd }) =>
    resultStore.reserveDeepResearchCost({ ...job, costMicroUsd, provider, maxMicroUsd });
  const url = 'https://api.search.brave.com/res/v1/news/search?q=synthetic';
  const firstAttempt = createScreeningCostGuard(async () => { dialed += 1; return Response.json({}); }, { reserve });
  for (let index = 0; index < 20; index++) await firstAttempt.fetch(url);
  const retryAttempt = createScreeningCostGuard(async () => { dialed += 1; return Response.json({}); }, { reserve });
  for (let index = 0; index < 8; index++) await retryAttempt.fetch(url);
  await assert.rejects(retryAttempt.fetch(url), /screening_cost_limit/);
  assert.equal(dialed, 28);
  const usage = await resultStore.getDeepResearchUsage(job);
  assert.equal(usage.reservedMicroUsd, 140_000);
  assert.equal(usage.providerCalls.brave, 28);
});

test('model input and maximum output are reserved before a paid call', async () => {
  let dialed = 0;
  const guard = createScreeningCostGuard(async () => { dialed += 1; return Response.json({}); });
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';
  const options = { method: 'POST', body: JSON.stringify({ contents: [{ parts: [{ text: 'x'.repeat(1000) }] }],
    generationConfig: { maxOutputTokens: 2048 } }) };
  await guard.fetch(url, options);
  assert.ok(guard.reservedProviderCostUsd > 0.005);
  assert.equal(dialed, 1);
  await assert.rejects(guard.fetch(url, { method: 'POST', body: JSON.stringify({ contents: [{ parts: [{ text: 'x'.repeat(500_000) }] }],
    generationConfig: { maxOutputTokens: 2048 } }) }), /screening_cost_limit/);
  assert.equal(dialed, 1);
});

test('GPT-5 mini Azure calls reserve a bounded cost before dialing', async () => {
  let dialed = 0;
  const guard = createScreeningCostGuard(async () => { dialed += 1; return Response.json({ status: 'completed' }); });
  const url = 'https://aoai-ai7uae-uaen-001.openai.azure.com/openai/v1/responses';
  const request = (input) => ({ method: 'POST', body: JSON.stringify({
    model: 'ai7uae-gpt-5-mini', input, max_output_tokens: 4096
  }) });
  await guard.fetch(url, request('synthetic evidence'));
  assert.equal(guard.providerCalls.azure_openai, 1);
  assert.ok(guard.reservedProviderCostUsd >= 0.008);
  assert.equal(dialed, 1);
  await assert.rejects(guard.fetch(url, request('x'.repeat(600_000))), /screening_cost_limit/);
  await assert.rejects(guard.fetch(url, { method: 'POST', body: JSON.stringify({
    model: 'unknown-deployment', input: 'test', max_output_tokens: 4096
  }) }), /screening_cost_unknown_ai_request/);
  assert.equal(dialed, 1);
});

test('the report narrative falls back without dialing Gemini when the shared request allowance is exhausted', async () => {
  const hosts = [];
  const guard = createScreeningCostGuard(async (input) => { hosts.push(new URL(input).hostname); return Response.json({}); });
  for (let attempt = 0; attempt < 28; attempt += 1) {
    await guard.fetch('https://api.search.brave.com/res/v1/news/search?q=test');
  }
  const narrative = await createAdverseMediaNarrative({
    response: { status: 'partial', summary: { outcome: 'inconclusive', potentially_relevant_results: 0 },
      coverage: { complete: false }, results: [] },
    apiKey: 'test', fetchImpl: guard.fetch
  });
  assert.match(narrative.summary, /Inconclusive/);
  assert.equal(guard.reservedProviderCostUsd, 0.14);
  assert.deepEqual(new Set(hosts), new Set(['api.search.brave.com']));
});
