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
    await page.goto(`${base}/login?next=%2Fusage`);
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
    await page.waitForURL(`${base}/usage`);
    if ((await portal.request.get(`${base}/portal/api/auth/session`)).status() !== 200) {
      throw new Error('Portal session was not issued after email verification');
    }
    await portal.close();

    const initialId = viewport.width === 390 ? 'aaaaaaaaaaaaaaab' : 'aaaaaaaaaaaaaaaa';
    const initialEmail = `first-${viewport.width}@example.test`;
    await store.setCustomer({ id: initialId, name: 'First login workspace', status: 'active' });
    await store.setPortalUser({ ...createPortalAccount(initialEmail, 'FirstLogin!234',
      { id: initialId, name: 'First login workspace' }), initial_key_pending: true });
    const firstContext = await browser.newContext({ viewport });
    const firstPage = await firstContext.newPage();
    await firstPage.goto(`${base}/login?next=%2Faccount`);
    await firstPage.locator('#login-email').fill(initialEmail);
    await firstPage.locator('#login-password').fill('FirstLogin!234');
    await firstPage.locator('#login-form button[type="submit"]').click();
    await firstPage.locator('#code-form').waitFor({ state: 'visible' });
    await firstPage.locator('#login-code').fill(sent.at(-1).code);
    await firstPage.locator('#code-form button[type="submit"]').click();
    await firstPage.waitForURL(`${base}/api-keys`);
    await firstPage.locator('#new-key-panel').waitFor({ state: 'visible' });
    const revealed = await firstPage.locator('#new-key-value').textContent();
    if (!revealed || revealed.length < 20) throw new Error('Initial key was not revealed on API Keys.');
    await firstPage.reload();
    if (await firstPage.locator('#new-key-panel').isVisible()
      || (await firstPage.locator('#new-key-value').textContent()) === revealed)
      throw new Error('Initial key was revealed again after reload.');
    await firstContext.close();

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
