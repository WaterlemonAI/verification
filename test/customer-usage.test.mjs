import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { AzureCustomerUsageStore, MemoryCustomerUsageStore, moneyMicros, validateUsagePolicy } from '../lib/customer-usage.mjs';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');

test('inclusive rate tiers, prepaid balance, and postpay usage stay consistent', async () => {
  const usage = new MemoryCustomerUsageStore();
  const id = '0123456789abcdef';
  const policy = validateUsagePolicy({ mode: 'prepaid', currency: 'USD', allowed_modules: ['company-search'], rates: {
    'company-search': [{ up_to: 2, price: '0.10' }, { up_to: 4, price: '0.08' }, { up_to: null, price: '0.05' }]
  } }, new Set(['company-search']));
  await usage.configure(id, policy, true);
  await usage.addCredit(id, moneyMicros('0.36'), true);
  const details = (n) => ({ transactionId: `tx-${n}`, moduleIds: ['company-search'], method: 'POST', path: '/service/company_search' });
  for (let n = 1; n <= 4; n++) {
    const admitted = await usage.admit(id, details(n), true);
    assert.equal(admitted.allowed, true);
    assert.equal(admitted.cost, n <= 2 ? '0.100000' : '0.080000');
    await usage.complete(id, admitted.logKey, n === 3 ? 500 : 200);
  }
  assert.equal((await usage.account(id, true)).balance, '0.000000');
  assert.equal((await usage.admit(id, details(5), true)).statusCode, 402);
  assert.equal((await usage.account(id, true)).counts['company-search'], 4);
  assert.equal((await usage.logs(id)).find((row) => row.transaction_id === 'tx-5').response_code, 402);
  await usage.configure(id, { ...policy, mode: 'postpay' }, true);
  const fifth = await usage.admit(id, details(6), true);
  assert.equal(fifth.allowed, true);
  assert.equal(fifth.cost, '0.050000');
  assert.equal((await usage.account(id, true)).balance, '0.000000');
});

test('large inclusive boundaries use the correct tier without making thousands of calls', async () => {
  const usage = new MemoryCustomerUsageStore();
  const id = 'aabbccddeeff0011';
  const policy = validateUsagePolicy({ mode: 'postpay', currency: 'AED', allowed_modules: ['company-search'], rates: {
    'company-search': [{ up_to: 10000, price: '0.150000' }, { up_to: 20000, price: '0.100001' }, { up_to: null, price: '0' }]
  } }, new Set(['company-search']));
  await usage.configure(id, policy, true);
  for (const [prior, expected] of [[0, '0.150000'], [9999, '0.150000'], [10000, '0.100001'], [19999, '0.100001'], [20000, '0.000000']]) {
    const account = usage.accounts.get(id);
    usage.accounts.set(id, { ...account, countsJson: JSON.stringify({ 'company-search': prior }) });
    const admitted = await usage.admit(id, { transactionId: `boundary-${prior}`, moduleIds: ['company-search'], method: 'POST', path: '/service/company_search' }, true);
    assert.equal(admitted.allowed, true);
    assert.equal(admitted.cost, expected);
    assert.equal((await usage.account(id, true)).counts['company-search'], prior + 1);
  }
  assert.equal((await usage.account(id, true)).spent, '0.500002');
});

test('credit adjustments are auditable and currency stays locked after funding', async () => {
  const usage = new MemoryCustomerUsageStore();
  const id = 'bbccddeeff001122';
  const base = validateUsagePolicy({ mode: 'prepaid', currency: 'AED', allowed_modules: [], rates: {} }, new Set());
  await usage.configure(id, base, true);
  await usage.addCredit(id, moneyMicros('0.000001'), true);
  assert.equal((await usage.account(id, true)).balance, '0.000001');
  const credits = await usage.credits(id);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].amount, '0.000001');
  assert.equal(credits[0].currency, 'AED');
  assert.match(credits[0].credited_at, /^\d{4}-\d\d-\d\dT/);
  await assert.rejects(usage.configure(id, { ...base, currency: 'USD' }, true), /Currency cannot change/);
  assert.throws(() => moneyMicros('0.0000001'), /six places/);
  assert.throws(() => moneyMicros('-1'), /non-negative/);
  await usage.addCredit(id, moneyMicros('0.50'), true, { idempotencyKey: 'credit-test-1', actor: 'admin@example.test' });
  await usage.addCredit(id, moneyMicros('0.50'), true, { idempotencyKey: 'credit-test-1', actor: 'admin@example.test' });
  assert.equal((await usage.account(id, true)).balance, '0.500001');
  assert.equal((await usage.credits(id)).length, 2);
  assert.equal((await usage.credits(id)).find((item) => item.amount === '0.500000').actor, 'admin@example.test');
  await assert.rejects(usage.addCredit(id, moneyMicros('0.51'), true, { idempotencyKey: 'credit-test-1' }), /different credit amount/);
});

test('Form admission reserves each selected module once and rejects missing access atomically', async () => {
  const usage = new MemoryCustomerUsageStore();
  const id = 'fedcba9876543210';
  const policy = validateUsagePolicy({ mode: 'prepaid', currency: 'AED', allowed_modules: ['forms', 'adverse-media', 'merchant-screening'], rates: {
    forms: [{ up_to: null, price: '0.01' }],
    'adverse-media': [{ up_to: null, price: '0.20' }],
    'merchant-screening': [{ up_to: null, price: '0.09' }]
  } }, new Set(['forms', 'adverse-media', 'merchant-screening', 'entity-search']));
  await usage.configure(id, policy, true);
  await usage.addCredit(id, moneyMicros('0.30'), true);
  const base = { method: 'POST', path: '/forms/vendor/submissions' };
  const denied = await usage.admit(id, { ...base, transactionId: 'form-denied', moduleIds: ['forms', 'entity-search'] }, true);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual((await usage.account(id, true)).counts, {});
  const accepted = await usage.admit(id, { ...base, transactionId: 'form-accepted', moduleIds: ['forms', 'adverse-media', 'merchant-screening'] }, true);
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.cost, '0.300000');
  assert.equal((await usage.account(id, true)).balance, '0.000000');
  assert.deepEqual((await usage.account(id, true)).counts, { forms: 1, 'adverse-media': 1, 'merchant-screening': 1 });
});

test('Azure account and log batch admits only one concurrent request against one credit', async () => {
  const entities = new Map();
  let version = 0;
  const key = (entity) => `${entity.partitionKey}/${entity.rowKey}`;
  const fail = (statusCode) => Object.assign(new Error('table_conflict'), { statusCode });
  const tableClient = {
    async getEntity(partitionKey, rowKey) {
      const value = entities.get(`${partitionKey}/${rowKey}`);
      if (!value) throw fail(404);
      return { ...value };
    },
    async createEntity(entity) {
      if (entities.has(key(entity))) throw fail(409);
      entities.set(key(entity), { ...entity, etag: String(++version) });
    },
    async submitTransaction(actions) {
      const [update, create] = actions;
      const current = entities.get(key(update[1]));
      if (current.etag !== update[3].etag) throw fail(412);
      if (create && entities.has(key(create[1]))) throw fail(409);
      entities.set(key(update[1]), { ...update[1], etag: String(++version) });
      if (create) entities.set(key(create[1]), { ...create[1], etag: String(++version) });
    }
  };
  const usage = new AzureCustomerUsageStore({ tableClient });
  const id = '1122334455667788';
  const policy = validateUsagePolicy({ mode: 'prepaid', currency: 'USD', allowed_modules: ['entity-search'], rates: {
    'entity-search': [{ up_to: null, price: '1.00' }]
  } }, new Set(['entity-search']));
  await usage.configure(id, policy, true);
  await usage.addCredit(id, moneyMicros('1.00'), true);
  const attempts = await Promise.all(['first', 'second'].map((transactionId) => usage.admit(id, {
    transactionId, moduleIds: ['entity-search'], method: 'POST', path: '/service/entity_search'
  }, true)));
  assert.equal(attempts.filter((item) => item.allowed).length, 1);
  assert.equal(attempts.filter((item) => item.statusCode === 402).length, 1);
  assert.equal((await usage.account(id, true)).balance, '0.000000');
  assert.equal((await usage.account(id, true)).counts['entity-search'], 1);
});

test('Azure credit adjustment retries are atomic and idempotent', async () => {
  const entities = new Map();
  let version = 0;
  const key = (entity) => `${entity.partitionKey}/${entity.rowKey}`;
  const fail = (statusCode) => Object.assign(new Error('table_conflict'), { statusCode });
  const tableClient = {
    async getEntity(partitionKey, rowKey) {
      const value = entities.get(`${partitionKey}/${rowKey}`);
      if (!value) throw fail(404);
      return { ...value };
    },
    async createEntity(entity) {
      if (entities.has(key(entity))) throw fail(409);
      entities.set(key(entity), { ...entity, etag: String(++version) });
    },
    async submitTransaction(actions) {
      const [update, create] = actions;
      const current = entities.get(key(update[1]));
      if (current.etag !== update[3].etag || entities.has(key(create[1]))) throw fail(412);
      entities.set(key(update[1]), { ...update[1], etag: String(++version) });
      entities.set(key(create[1]), { ...create[1], etag: String(++version) });
    }
  };
  const usage = new AzureCustomerUsageStore({ tableClient });
  const id = 'eeff001122334455';
  const options = { idempotencyKey: 'stable-credit-request', actor: 'admin@example.test' };
  const results = await Promise.all([
    usage.addCredit(id, moneyMicros('1.25'), true, options),
    usage.addCredit(id, moneyMicros('1.25'), true, options)
  ]);
  assert.deepEqual(results.map((item) => item.balance), ['1.250000', '1.250000']);
  assert.equal([...entities.values()].filter((item) => item.rowKey.startsWith('credit-')).length, 1);
  assert.equal((await usage.account(id, true)).balance, '1.250000');
  await assert.rejects(usage.addCredit(id, moneyMicros('1.26'), true, options), /different credit amount/);
});

test('API admission enforces modules and credit before upstream, preserves response body, and logs HTTP codes', async (t) => {
  const store = new EnvironmentStore();
  const usageStore = new MemoryCustomerUsageStore();
  const adminKey = 'usage-admin-key';
  process.env.AI7_ADMIN_KEY_HASHES = createHash('sha256').update(adminKey).digest('hex');
  await store.upsertIntegration({ id: 'company-search', name: 'Company Search', publicPath: '/service/company_search',
    method: 'POST', upstreamUrl: 'https://supplier.test/check', authType: 'none', acceptedContentTypes: ['application/json'], enabled: true }, '');
  const issued = await store.createClient('Bank A');
  const id = issued.client.workspaceId;
  await store.setCustomer({ id, name: 'Bank A', status: 'active', usagePolicyVersion: 1 });
  let upstreamCalls = 0;
  const server = createAppServer({ store, usageStore, startWorker: false, fetchImpl: async () => {
    upstreamCalls++;
    return new Response('{"supplier":"unchanged"}', { status: 422, headers: { 'content-type': 'application/json' } });
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json' };
  const hiddenPage = await fetch(`${base}/merchant-screening.html`, { redirect: 'manual', headers: { accept: 'text/html' } });
  assert.equal(hiddenPage.status, 302);
  const call = (method = 'POST') => fetch(`${base}/service/company_search`, { method, headers: auth, ...(method === 'POST' ? { body: '{}' } : {}) });
  const disabled = await call();
  assert.equal(disabled.status, 403); assert.equal(upstreamCalls, 0);
  const wrongMethod = await call('GET');
  assert.equal(wrongMethod.status, 405); assert.equal(upstreamCalls, 0);
  const policy = { mode: 'prepaid', currency: 'USD', allowed_modules: ['company-search'], rates: {
    'company-search': [{ up_to: 1, price: '0.12' }, { up_to: null, price: '0.08' }]
  } };
  const configured = await fetch(`${base}/admin/api/customers/${id}/usage`, { method: 'PUT', headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' }, body: JSON.stringify(policy) });
  assert.equal(configured.status, 200);
  const noCredit = await call(); assert.equal(noCredit.status, 402); assert.equal(upstreamCalls, 0);
  const credit = await fetch(`${base}/admin/api/customers/${id}/credit`, { method: 'POST', headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ amount: '0.12' }) });
  assert.equal(credit.status, 200);
  const success = await call();
  assert.equal(success.status, 422);
  assert.deepEqual(await success.json(), { supplier: 'unchanged' });
  assert.match(success.headers.get('x-ai7-transaction-id'), /^[a-f0-9-]{36}$/);
  assert.equal(upstreamCalls, 1);
  const noSecondCredit = await call(); assert.equal(noSecondCredit.status, 402); assert.equal(upstreamCalls, 1);
  const adminUsage = await fetch(`${base}/admin/api/customers/${id}/usage`, { headers: { authorization: `Bearer ${adminKey}` } });
  const ledger = await adminUsage.json();
  assert.equal(ledger.account.balance, '0.000000');
  assert.equal(ledger.account.counts['company-search'], 1);
  assert.equal(ledger.logs.find((row) => row.transaction_id === success.headers.get('x-ai7-transaction-id')).response_code, 422);
  assert.equal(ledger.logs.find((row) => row.transaction_id === success.headers.get('x-ai7-transaction-id')).cost, '0.120000');
  assert.deepEqual(new Set(ledger.logs.map((row) => row.response_code)), new Set([402, 405, 403, 422]));
});
