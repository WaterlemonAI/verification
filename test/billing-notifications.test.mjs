import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBillingNotifications } from '../lib/billing-notifications.mjs';
import { MemoryCustomerUsageStore, moneyMicros, validateUsagePolicy } from '../lib/customer-usage.mjs';

test('billing notices go to the active administrator once, with settled API charges for the previous Dubai day', async () => {
  const usageStore = new MemoryCustomerUsageStore();
  const customer = { id: 'billing-workspace', status: 'active', adminEmail: 'owner@example.test' };
  const store = { listCustomers: async () => [customer, { id: 'inactive', status: 'invited', adminEmail: 'other@example.test' }] };
  const policy = validateUsagePolicy({ mode: 'prepaid', currency: 'USD', allowed_modules: ['company-search'], rates: {
    'company-search': [{ up_to: null, price: '0.10' }]
  } }, new Set(['company-search']));
  await usageStore.configure(customer.id, policy, true);
  await usageStore.addCredit(customer.id, moneyMicros('1'), true, { idempotencyKey: 'billing-credit-1' });
  await usageStore.addCredit(customer.id, moneyMicros('1'), true, { idempotencyKey: 'billing-credit-1' });
  const admitted = await usageStore.admit(customer.id, { transactionId: 'charge-1', moduleIds: ['company-search'],
    method: 'POST', path: '/service/company_search' }, true);
  await usageStore.complete(customer.id, admitted.logKey, 200);
  const refunded = await usageStore.admit(customer.id, { transactionId: 'refund-1', moduleIds: ['company-search'],
    method: 'POST', path: '/service/company_search' }, true);
  await usageStore.complete(customer.id, refunded.logKey, 500);
  for (const row of usageStore.rows.values()) row.startedAt = '2026-11-02T20:10:00.000Z';
  const sent = [];
  const mailer = { configured: true, sendLowCredit: async (value) => sent.push(['low', value]),
    sendCreditAdded: async (value) => sent.push(['credit', value]),
    sendDailyUsage: async (value) => sent.push(['daily', value]) };
  const at = new Date('2026-11-03T21:05:00.000Z');
  await runBillingNotifications({ store, usageStore, mailer, at });
  await runBillingNotifications({ store, usageStore, mailer, at });
  assert.deepEqual(sent.map(([kind]) => kind).sort(), ['credit', 'daily', 'low']);
  assert.ok(sent.every(([, value]) => value.to === customer.adminEmail));
  assert.equal(sent.find(([kind]) => kind === 'credit')[1].amount, '1.000000');
  assert.deepEqual(sent.find(([kind]) => kind === 'daily')[1].usage, { date: '2026-11-03', currency: 'USD',
    total: '0.100000', services: [{ service_id: 'company-search', calls: 1, cost: '0.100000' }] });
});

test('failed delivery is retried and AED prepaid threshold uses the USD 5 equivalent', async () => {
  const usageStore = new MemoryCustomerUsageStore();
  const customer = { id: 'aed-workspace', status: 'active', adminEmail: 'aed@example.test' };
  const store = { listCustomers: async () => [customer] };
  await usageStore.configure(customer.id, validateUsagePolicy({ mode: 'prepaid', currency: 'AED',
    allowed_modules: [], rates: {} }, new Set()), true);
  await usageStore.addCredit(customer.id, moneyMicros('18.35'), true);
  let attempts = 0;
  const mailer = { configured: true,
    sendCreditAdded: async () => {}, sendDailyUsage: async () => {},
    sendLowCredit: async () => { if (++attempts === 1) throw new Error('smtp_down'); } };
  const at = new Date('2026-11-03T08:00:00.000Z');
  const first = await runBillingNotifications({ store, usageStore, mailer, at });
  const second = await runBillingNotifications({ store, usageStore, mailer, at });
  assert.equal(first.failed, 1);
  assert.equal(second.failed, 0);
  assert.equal(attempts, 2);
  assert.equal((await usageStore.pendingNotifications(customer.id)).length, 0);
});
