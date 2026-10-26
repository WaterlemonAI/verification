import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapacityError, createRequestCapacity } from '../lib/request-capacity.mjs';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryCustomerUsageStore, validateUsagePolicy } from '../lib/customer-usage.mjs';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');

test('bounded service lanes queue callers and release exactly once', async () => {
  const capacity = createRequestCapacity({ globalLimit: 2, defaultLaneLimit: 1, maximumWaiting: 2, maximumWaitMs: 1_000 });
  const first = await capacity.acquire('trade');
  const other = await capacity.acquire('iban');
  const next = capacity.acquire('trade');
  assert.deepEqual(capacity.snapshot(), { active: 2, waiting: 1, activeByLane: { trade: 1, iban: 1 } });
  other();
  assert.equal(capacity.snapshot().active, 1);
  first();
  const release = await next;
  first();
  assert.deepEqual(capacity.snapshot(), { active: 1, waiting: 0, activeByLane: { trade: 1 } });
  release();
  assert.equal(capacity.snapshot().active, 0);
});

test('a saturated lane does not block a free service and the waitlist is bounded', async () => {
  const capacity = createRequestCapacity({ globalLimit: 2, defaultLaneLimit: 1, maximumWaiting: 1, maximumWaitMs: 1_000 });
  const releaseTrade = await capacity.acquire('trade');
  const queuedTrade = capacity.acquire('trade');
  const releaseIban = await capacity.acquire('iban');
  await assert.rejects(capacity.acquire('trade'), (error) => error instanceof CapacityError && error.reason === 'capacity_queue_full');
  releaseTrade();
  (await queuedTrade)();
  releaseIban();
});

test('timed out or cancelled requests leave no active reservation', async () => {
  const capacity = createRequestCapacity({ globalLimit: 1, defaultLaneLimit: 1, maximumWaitMs: 15 });
  const release = await capacity.acquire('trade');
  await assert.rejects(capacity.acquire('trade'), (error) => error.reason === 'capacity_wait_timeout');
  const controller = new AbortController();
  const waiting = capacity.acquire('trade', { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, (error) => error.reason === 'request_cancelled');
  release();
  assert.deepEqual(capacity.snapshot(), { active: 0, waiting: 0, activeByLane: {} });
});

test('over-capacity API calls return a transaction ID and refund reserved credit without calling the supplier', async (t) => {
  const store = new EnvironmentStore();
  const usageStore = new MemoryCustomerUsageStore();
  await store.upsertIntegration({ id: 'company-search', name: 'Company Search', publicPath: '/service/company_search',
    method: 'POST', upstreamUrl: 'https://supplier.test/check', authType: 'none',
    acceptedContentTypes: ['application/json'], enabled: true }, '');
  const issued = await store.createClient('Capacity customer');
  const ownerId = issued.client.workspaceId;
  await store.setCustomer({ id: ownerId, name: 'Capacity customer', status: 'active', usagePolicyVersion: 1 });
  await usageStore.configure(ownerId, validateUsagePolicy({ mode: 'prepaid', currency: 'USD', allowed_modules: ['company-search'],
    rates: { 'company-search': [{ up_to: null, price: '0.10' }] } }, new Set(['company-search'])), true);
  await usageStore.addCredit(ownerId, 100_000, true);
  let supplierCalls = 0;
  const server = createAppServer({ store, usageStore, startWorker: false,
    requestCapacity: { acquire: async () => { throw new CapacityError('capacity_queue_full'); } },
    fetchImpl: async () => { supplierCalls += 1; return new Response('{}'); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/service/company_search`, {
    method: 'POST', headers: { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '5');
  const transactionId = response.headers.get('x-ai7-transaction-id');
  assert.match(transactionId, /^[a-f0-9-]{36}$/);
  assert.equal((await response.json()).reasonCode, 'CAPACITY_BUSY');
  assert.equal(supplierCalls, 0);
  for (let attempt = 0; attempt < 20 && !(await usageStore.logs(ownerId)).some((row) => row.response_code === 503); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const row = (await usageStore.logs(ownerId)).find((item) => item.transaction_id === transactionId);
  assert.equal(row.response_code, 503);
  assert.equal(row.cost, '0.000000');
  assert.equal(row.refund_amount, '0.100000');
});

test('a caller disconnecting while queued releases its credit reservation', async (t) => {
  const store = new EnvironmentStore();
  const usageStore = new MemoryCustomerUsageStore();
  await store.upsertIntegration({ id: 'company-search', name: 'Company Search', publicPath: '/service/company_search',
    method: 'POST', upstreamUrl: 'https://supplier.test/check', authType: 'none',
    acceptedContentTypes: ['application/json'], enabled: true }, '');
  const issued = await store.createClient('Capacity customer');
  const ownerId = issued.client.workspaceId;
  await store.setCustomer({ id: ownerId, name: 'Capacity customer', status: 'active', usagePolicyVersion: 1 });
  await usageStore.configure(ownerId, validateUsagePolicy({ mode: 'prepaid', currency: 'USD', allowed_modules: ['company-search'],
    rates: { 'company-search': [{ up_to: null, price: '0.10' }] } }, new Set(['company-search'])), true);
  await usageStore.addCredit(ownerId, 200_000, true);
  let supplierCalls = 0;
  let releaseSupplier;
  const supplierGate = new Promise((resolve) => { releaseSupplier = resolve; });
  const capacity = createRequestCapacity({ globalLimit: 1, defaultLaneLimit: 1, maximumWaitMs: 1_000 });
  const server = createAppServer({ store, usageStore, requestCapacity: capacity, startWorker: false,
    fetchImpl: async () => { supplierCalls += 1; await supplierGate; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/service/company_search`;
  const headers = { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' };
  const first = fetch(url, { method: 'POST', headers, body: '{}' });
  for (let attempt = 0; attempt < 30 && supplierCalls === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(supplierCalls, 1);
  const controller = new AbortController();
  const second = fetch(url, { method: 'POST', headers, body: '{}', signal: controller.signal });
  for (let attempt = 0; attempt < 30 && capacity.snapshot().waiting === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(capacity.snapshot().waiting, 1);
  controller.abort();
  await assert.rejects(second, /abort/i);
  for (let attempt = 0; attempt < 30 && !(await usageStore.logs(ownerId)).some((row) => row.response_code === 499); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(capacity.snapshot().waiting, 0);
  assert.equal(supplierCalls, 1);
  const cancelled = (await usageStore.logs(ownerId)).find((row) => row.response_code === 499);
  assert.equal(cancelled.cost, '0.000000');
  assert.equal(cancelled.refund_amount, '0.100000');
  releaseSupplier();
  assert.equal((await first).status, 200);
});
