import test from 'node:test';
import assert from 'node:assert/strict';
import { AzureCustomerUsageStore, MemoryCustomerUsageStore, validateCasePolicy } from '../lib/customer-usage.mjs';

test('policy is off by default, validates TTL, and admission keeps its snapshot', async () => {
  const usage = new MemoryCustomerUsageStore();
  const workspace = 'case-policy-test';
  assert.deepEqual(await usage.casePolicy(workspace), { version: 0, visible_from_version: 0, enabled: false, ttl_days: null });
  for (const ttl_days of [0, 1.5, 46, undefined]) assert.throws(() => validateCasePolicy({ version: 0, enabled: true, ttl_days }));
  const enabled = await usage.updateCasePolicy(workspace, validateCasePolicy({ version: 0, enabled: true, ttl_days: 45 }));
  assert.deepEqual(enabled, { version: 1, visible_from_version: 1, enabled: true, ttl_days: 45 });
  const first = await usage.admit(workspace, { transactionId: 'one', moduleIds: ['service'], method: 'POST', path: '/service/example' });
  assert.deepEqual(first.casePolicy, enabled);
  assert.deepEqual(JSON.parse(usage.rows.get('one').casePolicyJson), enabled);
  await usage.updateCasePolicy(workspace, validateCasePolicy({ version: 1, enabled: false }));
  assert.equal(first.casePolicy.enabled, true);
  assert.equal((await usage.admit(workspace, { transactionId: 'two', moduleIds: ['service'], method: 'POST', path: '/service/example' })).casePolicy.enabled, false);
  await assert.rejects(usage.updateCasePolicy(workspace, validateCasePolicy({ version: 1, enabled: true, ttl_days: 30 })), /changed/);
  assert.equal((await usage.account(workspace)).charged_calls, 2);
});

test('Azure policy update uses the account ETag and rejects stale versions', async () => {
  const entities = new Map();
  const tableClient = {
    async getEntity(partitionKey, rowKey) {
      const item = entities.get(`${partitionKey}/${rowKey}`);
      if (!item) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return structuredClone(item);
    },
    async createEntity(item) { entities.set(`${item.partitionKey}/${item.rowKey}`, { ...structuredClone(item), etag: '1' }); },
    async submitTransaction(actions) {
      const [verb, item, , options] = actions[0];
      assert.equal(verb, 'update');
      const key = `${item.partitionKey}/${item.rowKey}`;
      const current = entities.get(key);
      if (options.etag !== current.etag) throw Object.assign(new Error('stale'), { statusCode: 412 });
      entities.set(key, { ...structuredClone(item), etag: String(Number(current.etag) + 1) });
    }
  };
  const usage = new AzureCustomerUsageStore({ tableClient });
  assert.deepEqual(await usage.updateCasePolicy('workspace-a', validateCasePolicy({ version: 0, enabled: true, ttl_days: 1 })),
    { version: 1, visible_from_version: 1, enabled: true, ttl_days: 1 });
  await assert.rejects(usage.updateCasePolicy('workspace-a', validateCasePolicy({ version: 0, enabled: false })), /changed/);
  assert.equal((await usage.casePolicy('workspace-a')).ttl_days, 1);
});
