import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files = {
  '/api.css': ['api-site/api.css', 'text/css'],
  '/portal-auth.js': ['api-site/portal-auth.js', 'text/javascript'],
  '/account.js': ['api-site/account.js', 'text/javascript'],
  '/forms.js': ['api-site/forms.js', 'text/javascript'],
  '/flo.js': ['api-site/flo.js', 'text/javascript'],
  '/flo-review.js': ['api-site/flo-review.js', 'text/javascript'],
  '/flo.css': ['api-site/flo.css', 'text/css'],
  '/flo-workflows.css': ['api-site/flo-workflows.css', 'text/css'],
  '/flo-workflows.js': ['api-site/flo-workflows.js', 'text/javascript'],
  '/flo-builder.css': ['api-site/flo-builder.css', 'text/css'],
  '/flo-sortable.min.js': ['node_modules/sortablejs/Sortable.min.js', 'text/javascript'],
  '/assets/kycprobe-logo-white.png': ['api-site/assets/kycprobe-logo-white.png', 'image/png'],
  '/document-extraction-catalog.json': ['api-site/document-extraction-catalog.json', 'application/json']
};
const genericOcr = '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/api.css"><script src="/portal-auth.js" defer></script></head><body><header></header><main id="main-content"><h1>Document extraction</h1></main></body></html>';
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const page = ['/account', '/usage', '/api-keys'].includes(path) ? 'api-site/account.html'
    : path === '/forms' || /^\/forms\/[a-z0-9-]+$/.test(path) ? 'api-site/forms.html'
      : path === '/flo' ? 'api-site/flo.html'
        : path === '/flo-workflows' ? 'api-site/flo-workflows.html' : null;
  if (path.startsWith('/document-extraction/')) {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(genericOcr); return;
  }
  const entry = files[path] || (page && [page, 'text/html']);
  if (!entry) { res.writeHead(404); res.end(); return; }
  const bytes = readFileSync(join(root, entry[0]));
  res.writeHead(200, { 'content-type': entry[1], 'content-length': bytes.length }); res.end(bytes);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH
  || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : chromium.executablePath()) });
const form = { id: 'vendor-onboarding', name: 'Vendor onboarding verification', description: 'Check one vendor.',
  services: [{ id: 'company-search', name: 'Company Search' }], fields: [] };
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    let modules = ['*'];
    let role = 'org_admin';
    let formsMode = 'normal';
    let ocrMode = 'normal';
    const calls = [];
    await context.route('**/portal/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      calls.push(path);
      const response = path === '/portal/api/auth/session' ? { account: { client_name: 'Test workspace',
        email: 'review@example.test', role }, csrf_token: 'csrf' }
        : path === '/portal/api/entitlements' ? { allowed_modules: modules,
          available_modules: ['flo', 'forms', 'uae-trade-licence', 'iban-verification',
            'uae-trade-license-ocr', 'passport-icao-ocr', 'company-search'] }
          : path === '/portal/api/flo/status' ? { enabled: true, workflow_platform_enabled: true }
            : path === '/portal/api/case-manager/settings' ? { available: true,
              policy: { enabled: false, ttl_days: 30, version: 1 } }
              : path === '/portal/api/team' ? { created: false, name: 'Test workspace', domain: 'example.test',
                role: 'org_admin', members: [], invitations: [] }
                : path === '/portal/api/health' ? { status: 'api_reachable', checked_at: new Date().toISOString(),
                  upstream_probe: 'not_performed', checks: [] }
                  : path === '/portal/api/keys' ? { keys: [] }
                    : path === '/portal/api/usage' ? { account: { mode: 'postpay', currency: 'USD',
                      balance: '0', charged_calls: 1, spent: '3.00',
                      rates: { flo: [{ up_to: null, price: '3.00' }] } }, logs: [] }
                      : path === '/portal/api/flo/flows' ? { flows: [] }
                        : path === '/portal/api/flo/cases' ? { cases: [], counts: {}, next_cursor: null } : {};
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
    });
    await context.route('**/forms.json', async (route) => {
      if (formsMode === 'failed') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ forms: formsMode === 'empty' ? [] : formsMode === 'long'
          ? Array.from({ length: 25 }, (_, index) => ({ ...form, id: 'form-' + index,
            name: 'International vendor and banking verification ' + index }))
          : [form, { ...form, id: 'long-form',
            name: 'Very long international vendor and banking verification Form' }] }) });
    });
    await context.route('**/document-extraction-catalog.json', async (route) => {
      if (ocrMode === 'failed') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: ocrMode === 'empty' ? '[]' : readFileSync(join(root,
          'api-site/document-extraction-catalog.json'), 'utf8') });
    });
    await context.route('**/forms/vendor-onboarding/schema', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ form }) }));
    const page = await context.newPage();
    await page.goto(base + '/account');
    await page.locator('body.portal-ready').waitFor();
    const groupNames = await page.locator('.portal-group-toggle').allTextContents();
    if (groupNames.join('|') !== 'Flo|Verification API|OCR|Forms')
      throw new Error('Group order differs at ' + width + ': ' + groupNames.join('|'));
    const directNames = await page.locator('.portal-nav-direct a').allTextContents();
    if (directNames.join('|') !== 'API Case Manager|Account Settings|Usage & Billing|API Keys')
      throw new Error('Direct link order differs at ' + width);
    if (!(await page.locator('.portal-nav-direct a[href="/account"]').getAttribute('aria-current')))
      throw new Error('Account route is not current.');
    if (await page.locator('[data-account-view="usage"]:visible').count()
      || await page.locator('[data-account-view="api-keys"]:visible').count())
      throw new Error('Account route exposes another view.');
    if (calls.includes('/portal/api/usage') || calls.includes('/portal/api/keys'))
      throw new Error('Account Settings loaded usage or keys.');
    if (width < 760) {
      const menu = page.locator('#portal-menu');
      await menu.click();
      if (await menu.getAttribute('aria-expanded') !== 'true'
        || !await page.locator('main').evaluate((node) => node.inert))
        throw new Error('Mobile drawer did not block background focus.');
      await page.keyboard.press('Escape');
      if (await menu.getAttribute('aria-expanded') !== 'false'
        || !await menu.evaluate((node) => node === document.activeElement))
        throw new Error('Escape did not close and restore focus.');
      await menu.click();
      await page.locator('.portal-overlay').click({ position: { x: width - 5, y: 100 } });
      if (await menu.getAttribute('aria-expanded') !== 'false')
        throw new Error('Overlay did not close drawer.');
    }
    await page.goto(base + '/usage');
    await page.locator('body.portal-ready').waitFor();
    if (!(await page.locator('[data-account-view="usage"]').isVisible())
      || await page.locator('[data-account-view="account"]:visible').count()
      || !(await page.locator('#usage-rate-card').textContent()).includes('3.00'))
      throw new Error('Usage view did not isolate and show rates.');
    await page.goto(base + '/api-keys');
    await page.locator('body.portal-ready').waitFor();
    if (!(await page.locator('[data-account-view="api-keys"]').first().isVisible())
      || await page.locator('[data-account-view="usage"]:visible').count())
      throw new Error('API Keys view did not isolate.');
    await page.goto(base + '/forms/vendor-onboarding');
    await page.locator('body.portal-ready').waitFor();
    await page.locator('#form-detail').waitFor({ state: 'visible' });
    if (await page.locator('.portal-sidebar a[aria-current="page"]').textContent() !== form.name
      || await page.locator('.portal-context strong').textContent() !== form.name)
      throw new Error('Form detail did not synchronize navigation.');
    await page.goto(base + '/document-extraction/uae-trade-license-ocr');
    await page.locator('body.portal-ready').waitFor();
    if (!(await page.locator('.portal-sidebar a[aria-current="page"]').getAttribute('href'))
      .includes('uae-trade-license-ocr')) throw new Error('OCR deep link not active.');
    ocrMode = 'failed';
    await page.goto(base + '/account');
    await page.locator('body.portal-ready').waitFor();
    if (!(await page.locator('.portal-nav-group[data-group="ocr"] .portal-nav-note').textContent())
      .includes('could not be loaded')) throw new Error('Failed OCR catalog has no fallback.');
    ocrMode = 'normal';
    if (width < 760) await page.locator('#portal-menu').click();
    if (await page.locator('.portal-nav-group[data-group="ocr"] .portal-group-toggle').getAttribute('aria-expanded') !== 'true')
      await page.locator('.portal-nav-group[data-group="ocr"] .portal-group-toggle').click();
    await page.locator('.portal-nav-group[data-group="ocr"] .portal-catalog-retry').click();
    await page.locator('.portal-nav-group[data-group="ocr"] a').first().waitFor();
    await page.goto(base + '/flo#new-application');
    await page.locator('body.portal-ready').waitFor();
    if (await page.locator('.portal-sidebar a[aria-current="page"]').textContent() !== 'Create onboarding link'
      || !(await page.locator('#new-application').count())) throw new Error('Flo creation anchor missing.');
    formsMode = 'long';
    await page.goto(base + '/forms');
    await page.locator('body.portal-ready').waitFor();
    const longMenu = page.locator('.portal-nav-group[data-group="forms"] .portal-submenu');
    if (await longMenu.locator('a').count() !== 26
      || !await longMenu.evaluate((node) => node.scrollHeight > node.clientHeight))
      throw new Error('Long Forms catalog is not bounded and scrollable.');
    formsMode = 'empty';
    await page.goto(base + '/forms');
    await page.locator('body.portal-ready').waitFor();
    if (!(await page.locator('#forms-status').textContent()).includes('No Forms are enabled'))
      throw new Error('Empty Forms state is unclear.');
    formsMode = 'failed';
    await page.reload();
    await page.locator('body.portal-ready').waitFor();
    if (!(await page.locator('#forms-status').textContent()).includes('could not be loaded')
      || !(await page.locator('#forms-retry').isVisible())) throw new Error('Failed Forms state has no retry.');
    formsMode = 'normal';
    await page.locator('#forms-retry').click();
    await page.getByText('2 Forms available.').waitFor();
    modules = ['forms'];
    await page.goto(base + '/account');
    await page.locator('body.portal-ready').waitFor();
    if (await page.locator('.portal-group-toggle').allTextContents().then((names) => names.join('|')) !== 'Forms')
      throw new Error('Entitlement filtering exposed unavailable groups.');
    modules = ['*']; role = 'member';
    await page.reload();
    await page.locator('body.portal-ready').waitFor();
    if (await page.locator('.portal-nav-group[data-group="flo"]').count())
      throw new Error('Flo administration was shown to a workspace member.');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 1) throw new Error('Navigation page overflows ' + width + 'px by ' + overflow);
    console.log('Portal navigation passed at ' + width + 'px');
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
