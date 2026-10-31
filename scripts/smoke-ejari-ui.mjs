import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

process.env.NODE_ENV = 'test';
process.env.EJARI_PLATFORM_ENABLED = '1';
const { EnvironmentStore } = await import('../lib/api-store.mjs');
const { MemoryCustomerUsageStore, validateUsagePolicy, moneyMicros } = await import('../lib/customer-usage.mjs');
const { createPortalAccount, createPortalSession, PORTAL_COOKIE } = await import('../lib/portal-auth.mjs');
const { createAppServer } = await import('../server.mjs');

const store = new EnvironmentStore();
const usageStore = new MemoryCustomerUsageStore();
const issued = await store.createClient('Synthetic Ejari UI');
const workspaceId = issued.client.workspaceId;
await store.setCustomer({ id: workspaceId, name: 'Synthetic Ejari UI', status: 'active', usagePolicyVersion: 1 });
await store.saveEjariConfig({ enabled: true, ocr_model: 'gpt-6-luna', ocr_detail: 'high',
  openai_key: 'synthetic-openai', capsolver_key: 'synthetic-capsolver' });
await usageStore.configure(workspaceId, validateUsagePolicy({ mode: 'prepaid', currency: 'USD',
  allowed_modules: ['ejari-verification'], rates: { 'ejari-verification': [{ up_to: null, price: '0.10' }] }
}, new Set(['ejari-verification'])), true);
await usageStore.addCredit(workspaceId, moneyMicros('1.00'), true);
const signingKey = 'synthetic-ejari-ui-session';
await store.setPortalSessionKey(signingKey);
const account = createPortalAccount('ejari-ui@example.test', 'SyntheticPassword!234',
  { id: workspaceId, name: 'Synthetic Ejari UI' });
await store.setPortalUser(account);
const id = 'ejari_11111111-1111-4111-8111-111111111111';
const ejariStore = {
  async createJob() { return { job: { id, status: 'queued' }, reused: false }; },
  async getResult() { return { job: { status: 'verified' }, result: {
    schemaVersion: 'ejari-v1', status: 'verified', certificateAvailable: true,
    source: { checkedAt: '2026-10-31T12:00:00Z' }, contractNumber: '0120221004004205',
    dewaNumber: '128053950', comparison: { compared_fields: 2, different_fields: [] }
  } }; },
  async getCertificate() { return Buffer.from('%PDF-synthetic'); }
};
const server = createAppServer({ store, usageStore, ejariStore, startWorker: false,
  deepResearchQueue: null, formsQueue: null });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()) });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const cookie = createPortalSession(account, signingKey).token;
    await page.context().addCookies([{ name: PORTAL_COOKIE, value: cookie, url: base }]);
    await page.goto(`${base}/ejari-verification`, { waitUntil: 'networkidle' });
    assert.match(await page.title(), /Dubai Ejari Verification/);
    assert.equal(await page.locator('#ejari-form').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#ejari-api-key').fill(issued.apiKey);
    await page.locator('#ejari-contract').fill('0120221004004205');
    await page.locator('#ejari-dewa').fill('128053950');
    await page.locator('#ejari-submit').click();
    await page.locator('#ejari-summary').waitFor({ state: 'visible', timeout: 10_000 });
    assert.match(await page.locator('#ejari-summary').textContent(), /verified/);
    assert.equal(await page.locator('#ejari-download').isVisible(), true);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Ejari desktop and mobile tester smoke passed');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
