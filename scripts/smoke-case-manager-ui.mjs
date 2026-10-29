import { chromium } from 'playwright-core';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryCustomerUsageStore, validateCasePolicy } from '../lib/customer-usage.mjs';
import { MemoryCaseManagerStore } from '../lib/case-manager-store.mjs';
import { createPortalAccount, createPortalSession, PORTAL_COOKIE } from '../lib/portal-auth.mjs';

process.env.NODE_ENV = 'test';
process.env.CASE_MANAGER_ENABLED = 'true';
const { createAppServer } = await import('../server.mjs');
const workspaceId = 'synthetic-ui-workspace';
const signingKey = 'synthetic-ui-signing-key';
const store = new EnvironmentStore();
const usageStore = new MemoryCustomerUsageStore();
const caseStore = new MemoryCaseManagerStore();
await store.setPortalSessionKey(signingKey);
const account = createPortalAccount('ui@example.test', 'SyntheticPassword!234', { id: workspaceId, name: 'Synthetic UI' });
await store.setPortalUser(account);
await usageStore.updateCasePolicy(workspaceId, validateCasePolicy({ version: 0, enabled: true, ttl_days: 45 }));
const intent = await caseStore.createIntent({ workspaceId, serviceId: 'synthetic-service', transactionId: 'synthetic-ui-tx',
  acceptedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
await caseStore.captureFinal(workspaceId, intent.id, { response: {
  status: 'partial', subject: '<img src=x onerror=window.__caseXss=1>',
  nested: { rows: Array.from({ length: 30 }, (_, index) => ({ index, note: 'Synthetic evidence '.repeat(10) })) }
}, contentType: 'application/json', httpStatus: 200, outcome: 'review_required', reasonCodes: ['PARTIAL'] });
const ocr = await caseStore.createIntent({ workspaceId, serviceId: 'passport-icao-ocr', transactionId: 'synthetic-ocr-tx',
  acceptedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
await caseStore.captureFinal(workspaceId, ocr.id, { response: { status: 'completed', data: { document_number: 'SYNTHETIC' } },
  contentType: 'application/json', httpStatus: 200, outcome: 'extracted' });
const server = createAppServer({ store, usageStore, caseStore, startWorker: false, deepResearchQueue: null, formsQueue: null });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  const results = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    await context.addCookies([{ name: PORTAL_COOKIE,
      value: encodeURIComponent(createPortalSession(account, signingKey).token), url: base }]);
    const page = await context.newPage();
    await page.goto(`${base}/cases`);
    await page.locator('.case-list-item').first().waitFor();
    await page.locator('.case-list-item', { hasText: 'synthetic-service' }).click();
    await page.locator('.case-result').getByText('<img src=x onerror=window.__caseXss=1>').waitFor();
    await page.locator('.case-summary').getByText('Review required').waitFor();
    await page.getByRole('button', { name: 'Final response JSON' }).click();
    await page.locator('.case-json').waitFor();
    const result = await page.evaluate(() => ({ viewport: innerWidth,
      scroll_width: document.documentElement.scrollWidth,
      xss_executed: Boolean(window.__caseXss), injected_image: Boolean(document.querySelector('img[src="x"]')),
      raw_json_visible: Boolean(document.querySelector('.case-json')?.textContent.includes('Synthetic evidence')) }));
    if (result.scroll_width > result.viewport + 1 || result.xss_executed || result.injected_image || !result.raw_json_visible) {
      throw new Error(`Case Manager UI smoke failed: ${JSON.stringify(result)}`);
    }
    await page.locator('.case-list-item', { hasText: 'passport-icao-ocr' }).click();
    await page.locator('.case-summary').getByText('Extraction status').waitFor();
    await page.locator('.case-summary').getByText('1', { exact: true }).waitFor();
    results.push(result);
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  delete process.env.CASE_MANAGER_ENABLED;
}
