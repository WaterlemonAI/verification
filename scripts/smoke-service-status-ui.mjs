import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = new URL('../api-site/', import.meta.url).pathname;
const pages = [
  ['/', 'index.html', 'trade-licence', { uae_tl_verification: { license_status: 'active' } }, 'Licence data returned'],
  ['/iban', 'iban.html', 'iban', { data: { results: { result: 'partial match', bank: 'Example Bank' } } }, 'Provider match result'],
  ['/entity-search', 'entity-search.html', 'entity-search', { profiles_success: false, apc_success: true }, 'Coverage incomplete'],
  ['/adverse-media', 'adverse-media.html', 'adverse-media', { status: 'partial', coverage: { complete: false } }, 'Review required'],
  ['/merchant-screening', 'merchant-screening.html', 'merchant-screening', { findings: [{ title: 'Review item' }] }, 'Findings to review'],
  ['/bank-statement-analysis', 'bank-statement-analysis.html', 'bank-statement-analysis', { status: 'completed', decisionEligible: false }, 'Analysis complete'],
  ['/ejari-verification', 'ejari-verification.html', 'ejari', { status: 'verified' }, 'Provider result received'],
  ['/document-extraction/uae-trade-license-ocr', 'document-extraction.html', 'ocr', { status: 'completed', data: { name: 'Synthetic' } }, 'Extraction result'],
  ['/forms', 'forms.html', 'forms', { submission_id: 'synthetic-receipt', callback_signing_secret: 'DO_NOT_SHOW' }, 'Submission receipt']
];
const mime = (file) => ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png' })[extname(file)] || 'application/octet-stream';
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const page = pages.find((item) => item[0] === path)?.[1];
  const file = page || (path === '/forms.json' ? 'forms.json' : path.replace(/^\//, ''));
  if (!/^[a-zA-Z0-9/_-]+\.(html|js|css|json|png)$/.test(file) || file.includes('..')) {
    res.writeHead(404); res.end(); return;
  }
  try { const bytes = readFileSync(join(root, file)); res.writeHead(200,
    { 'content-type': mime(file), 'content-length': bytes.length }); res.end(bytes); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH
  || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : chromium.executablePath()) });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    await context.route('**/portal/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = path.endsWith('/auth/session') ? { account: { role: 'org_admin', client_name: 'Synthetic workspace' }, csrf_token: 'test' }
        : path.endsWith('/entitlements') ? { allowed_modules: ['*'], available_modules: ['flo', 'forms', 'uae-trade-licence', 'iban-verification'] }
          : path.endsWith('/flo/status') ? { enabled: true, workflow_platform_enabled: true }
            : path.endsWith('/case-manager/settings') ? { available: false } : {};
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await context.route('**/forms.json', (route) => route.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ forms: [] }) }));
    const page = await context.newPage();
    const chargeable = [];
    const coverageCases = {
      'entity-search': [
        [{ data: { profiles: [] } }, 'Coverage unknown'],
        [{ profiles_success: true, data: { profiles: [] } }, 'Coverage unknown'],
        [{ profiles_success: true, apc_success: true, data: { profiles: [] } }, 'No candidates in completed coverage']
      ],
      'adverse-media': [
        [{ status: 'completed', results: [] }, 'Coverage unknown'],
        [{ status: 'completed', coverage: { complete: true }, results: [] }, 'Coverage unknown'],
        [{ status: 'completed', coverage: { complete: true }, summary: { decision_eligible: true }, results: [] }, 'No material findings in completed coverage']
      ],
      'merchant-screening': [
        [{ status: 'completed', findings: [] }, 'Coverage unknown'],
        [{ status: 'completed', summary: { decision_eligible: true }, findings: [] }, 'No material findings in completed coverage']
      ]
    };
    page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/service/')) chargeable.push(request.url()); });
    for (const [path, , service, result, expected] of pages) {
      await page.goto(base + path);
      if (path === '/forms') await page.locator('#form-detail').evaluate((node) => { node.hidden = false; });
      await page.locator('#check-state').waitFor();
      const ids = path === '/ejari-verification' ? ['ejari-status', 'ejari-json'] : ['response-status', 'response-json'];
      await page.evaluate(({ ids, result }) => {
        document.getElementById(ids[0]).textContent = 'HTTP 200';
        document.getElementById(ids[1]).textContent = JSON.stringify(result);
      }, { ids, result });
      await page.locator('#check-state strong').getByText(expected).waitFor();
      const panel = page.locator('#check-state');
      if (await panel.getAttribute('aria-live') !== 'polite'
        || /verified match|verification passed/i.test(await panel.textContent())
        || (await panel.textContent()).includes('DO_NOT_SHOW'))
        throw new Error(`Unsafe result wording or secret leak on ${path}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (overflow > 1) throw new Error(`${path} overflows ${width}px by ${overflow}`);
      for (const [coverageResult, label] of coverageCases[service] || []) {
        await page.evaluate(({ id, value }) => { document.getElementById(id).textContent = JSON.stringify(value); },
          { id: ids[1], value: coverageResult });
        await page.locator('#check-state strong').getByText(label).waitFor();
      }
    }
    if (chargeable.length) throw new Error('Service status smoke sent a chargeable request.');
    console.log(`Service status wording passed at ${width}px`);
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
