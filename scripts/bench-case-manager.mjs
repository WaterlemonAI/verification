import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryCustomerUsageStore, validateCasePolicy } from '../lib/customer-usage.mjs';
import { MemoryCaseManagerStore } from '../lib/case-manager-store.mjs';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');
const peakQpm = Number(process.argv[2] || 100);
const seconds = Number(process.argv[3] || 10);
if (!Number.isFinite(peakQpm) || peakQpm < 1 || !Number.isFinite(seconds) || seconds < 1) {
  throw new Error('Usage: node scripts/bench-case-manager.mjs [peak-qpm] [seconds]');
}
const targetQpm = peakQpm * 2;
const intervalMs = 60_000 / targetQpm;
const count = Math.ceil(seconds * targetQpm / 60);
const store = new EnvironmentStore();
await store.upsertIntegration({ id: 'synthetic-benchmark', name: 'Synthetic Benchmark', publicPath: '/service/synthetic_benchmark',
  method: 'POST', upstreamUrl: 'https://synthetic.invalid/check', authType: 'none',
  acceptedContentTypes: ['application/json'], enabled: true }, '');
const issued = await store.createClient('Synthetic Benchmark Workspace');
const workspaceId = issued.client.workspaceId;
const usageStore = new MemoryCustomerUsageStore();
const caseStore = new MemoryCaseManagerStore();
const response = { status: 'partial', result: { name: 'Synthetic subject', evidence: Array.from({ length: 20 }, (_, i) => ({
  code: `SYNTHETIC_${i}`, notes: 'Synthetic data only. '.repeat(8)
})) } };
const server = createAppServer({ store, usageStore, caseStore, startWorker: false,
  deepResearchQueue: null, formsQueue: null,
  fetchImpl: async () => { await delay(30); return new Response(JSON.stringify(response), {
    status: 200, headers: { 'content-type': 'application/json' }
  }); } });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/service/synthetic_benchmark`;
const percentile = (values, p) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))];

async function run(enabled) {
  if (enabled) {
    await usageStore.updateCasePolicy(workspaceId, validateCasePolicy({ version: 0, enabled: true, ttl_days: 45 }));
    process.env.CASE_MANAGER_ENABLED = 'true';
  } else delete process.env.CASE_MANAGER_ENABLED;
  const startMemory = process.memoryUsage().heapUsed;
  const start = performance.now();
  const calls = Array.from({ length: count }, (_, index) => (async () => {
    const due = start + index * intervalMs;
    if (due > performance.now()) await delay(due - performance.now());
    const callStart = performance.now();
    const result = await fetch(endpoint, { method: 'POST', headers: {
      authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json'
    }, body: '{}' });
    const actual = await result.json();
    if (result.status !== 200 || actual.result.evidence.length !== 20) throw new Error('benchmark_response_mismatch');
    return performance.now() - callStart;
  })());
  const latencies = (await Promise.all(calls)).sort((a, b) => a - b);
  const elapsedSeconds = (performance.now() - start) / 1000;
  const bytes = [...caseStore.payloads.values()].reduce((sum, payload) => sum + payload.length, 0);
  return { requests: count, target_qpm: targetQpm, observed_qpm: Math.round(count * 60 / elapsedSeconds),
    latency_ms: { p50: Math.round(percentile(latencies, 0.5)), p95: Math.round(percentile(latencies, 0.95)),
      max: Math.round(latencies.at(-1)) }, heap_delta_bytes: process.memoryUsage().heapUsed - startMemory,
    cases: caseStore.rows.size, encrypted_blob_bytes: bytes, encrypted_bytes_per_case: caseStore.rows.size ? Math.round(bytes / caseStore.rows.size) : 0 };
}

try {
  const off = await run(false);
  const on = await run(true);
  const burstStart = performance.now();
  const burst = await Promise.all(Array.from({ length: 32 }, async () => {
    const result = await fetch(endpoint, { method: 'POST', headers: {
      authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json'
    }, body: '{}' });
    if (result.status !== 200) throw new Error('benchmark_burst_failed');
    await result.arrayBuffer();
  }));
  if (burst.length !== 32 || caseStore.rows.size !== on.cases + 32) throw new Error('benchmark_concurrent_write_failed');
  const page = await caseStore.listCases(workspaceId, { serviceId: 'synthetic-benchmark', outcome: 'unclassified', limit: 10 });
  if (page.cases.length !== 10 || !page.next_cursor) throw new Error('benchmark_pagination_failed');
  console.log(JSON.stringify({ synthetic: true, provisional_peak_qpm: peakQpm, duration_per_mode_seconds: seconds,
    feature_off: off, feature_on: on, concurrent_write_burst: { requests: burst.length,
      elapsed_ms: Math.round(performance.now() - burstStart) }, filtered_page_size: page.cases.length }, null, 2));
} finally {
  delete process.env.CASE_MANAGER_ENABLED;
  await new Promise((resolve) => server.close(resolve));
}
