import { chromium } from 'playwright-core';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { createAdminAccount } from '../lib/admin-auth.mjs';
import { createPortalAccount } from '../lib/portal-auth.mjs';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');
const store = new EnvironmentStore();
const sent = [];
const mailer = { configured: true, sendLoginCode: async (message) => { sent.push(message); } };
await store.setPortalSessionKey('synthetic-portal-session-key');
await store.setAdminSessionKey('synthetic-admin-session-key');
await store.setPortalUser(createPortalAccount('portal@example.test', 'PortalPass!234',
  { id: 'synthetic-otp-workspace', name: 'Synthetic OTP workspace' }));
await store.setAdminAccount(createAdminAccount('admin@example.test', 'AdminPass!234'));
const server = createAppServer({ store, mailer, startWorker: false, deepResearchQueue: null, formsQueue: null });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()) });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const portal = await browser.newContext({ viewport });
    const page = await portal.newPage();
    await page.goto(`${base}/login?next=%2Faccount`);
    await page.locator('#login-email').fill('portal@example.test');
    await page.locator('#login-password').fill('PortalPass!234');
    await page.locator('#login-form button[type="submit"]').click();
    await page.locator('#code-form').waitFor({ state: 'visible' });
    if ((await portal.request.get(`${base}/portal/api/auth/session`)).status() !== 401) {
      throw new Error('Portal session was issued before email verification');
    }
    const portalCode = sent.at(-1)?.code;
    if (sent.at(-1)?.to !== 'portal@example.test' || !/^\d{8}$/.test(portalCode || '')) {
      throw new Error('Portal email code was not sent to the account address');
    }
    await page.locator('#login-code').fill(portalCode);
    await page.locator('#code-form button[type="submit"]').click();
    await page.waitForURL(`${base}/account`);
    if ((await portal.request.get(`${base}/portal/api/auth/session`)).status() !== 200) {
      throw new Error('Portal session was not issued after email verification');
    }
    await portal.close();

    const admin = await browser.newContext({ viewport });
    const adminPage = await admin.newPage();
    await adminPage.goto(`${base}/admin`);
    await adminPage.locator('#admin-email').fill('admin@example.test');
    await adminPage.locator('#admin-password').fill('AdminPass!234');
    await adminPage.locator('#login-form button[type="submit"]').click();
    await adminPage.locator('#code-card').waitFor({ state: 'visible' });
    if ((await admin.request.get(`${base}/admin/api/auth/session`)).status() !== 401) {
      throw new Error('Admin session was issued before email verification');
    }
    const adminCode = sent.at(-1)?.code;
    if (sent.at(-1)?.to !== 'admin@example.test' || !/^\d{8}$/.test(adminCode || '')) {
      throw new Error('Admin email code was not sent to the account address');
    }
    await adminPage.locator('#admin-code').fill(adminCode);
    await adminPage.locator('#code-form button[type="submit"]').click();
    await adminPage.locator('#app-view').waitFor({ state: 'visible' });
    if ((await admin.request.get(`${base}/admin/api/auth/session`)).status() !== 200) {
      throw new Error('Admin session was not issued after email verification');
    }
    await admin.close();
    console.log(`Email OTP browser journeys passed at ${viewport.width}px`);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
