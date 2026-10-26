import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeMerchantWebsite, merchantScreenshotAssets, screenMerchantWebsite, validateMerchantScreeningRequest } from '../lib/merchant-screening.mjs';
import { MemoryAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';
import { collectMerchantWebsite, isPublicIpAddress, validatePublicHttpsUrl } from '../lib/merchant-screening-network.mjs';
import { captureMerchantScreenshots, selectScreenshotTargets } from '../lib/merchant-screenshot.mjs';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');

test('merchant URL validation rejects SSRF-prone destinations and invalid request bounds', () => {
  assert.equal(isPublicIpAddress('127.0.0.1'), false);
  assert.equal(isPublicIpAddress('169.254.169.254'), false);
  assert.equal(isPublicIpAddress('10.20.30.40'), false);
  assert.equal(isPublicIpAddress('192.0.2.10'), false);
  assert.equal(isPublicIpAddress('1.1.1.1'), true);
  assert.throws(() => validatePublicHttpsUrl('http://example.com'), /public_https/);
  assert.throws(() => validatePublicHttpsUrl('https://127.0.0.1'), /public_hostname/);
  assert.equal(validateMerchantScreeningRequest({ website_url: 'https://shop.example.com', country_code: 'ae' }).value.country_code, 'AE');
  const reportRequest = validateMerchantScreeningRequest({
    website_url: 'https://shop.example.com', country_code: 'AE', get_pdf: true,
    customer_logo_url: 'https://assets.example.com/logo.png'
  });
  assert.equal(reportRequest.value.get_pdf, true);
  assert.equal(reportRequest.value.customer_logo_url, 'https://assets.example.com/logo.png');
  assert.equal(reportRequest.value.high_risk_threshold_percent, 60);
  assert.equal(reportRequest.value.review_threshold_percent, 25);
  assert.match(validateMerchantScreeningRequest({ website_url: 'https://shop.example.com', country_code: 'AE', max_pages: 21 }).error, /between 1 and 20/);
  assert.match(validateMerchantScreeningRequest({ website_url: 'https://shop.example.com', country_code: 'AE', declared_mcc: '123' }).error, /four digits/);
  assert.match(validateMerchantScreeningRequest({ website_url: 'https://shop.example.com', country_code: 'AE', get_pdf: 'yes' }).error, /boolean/);
  assert.match(validateMerchantScreeningRequest({ website_url: 'https://shop.example.com', country_code: 'AE', high_risk_threshold_percent: 101 }).error, /up to 100/);
  assert.match(validateMerchantScreeningRequest({ website_url: 'https://shop.example.com', country_code: 'AE', high_risk_threshold_percent: 40, review_threshold_percent: 50 }).error, /must not be higher/);
  assert.match(validateMerchantScreeningRequest({ website_url: 'https://shop.example.com', country_code: 'AE', customer_logo_url: 'http://assets.example.com/logo.png' }).error, /public HTTPS/);
  assert.match(validateMerchantScreeningRequest({ website_url: 'https://shop.example.com', country_code: 'AE', unexpected: true }).error, /Unsupported field/);
});

test('merchant crawl does not accept a later page redirected away from the merchant origin', async () => {
  const fetchResource = async (value) => {
    const url = String(value);
    if (url.endsWith('/robots.txt')) return { url, status: 404, headers: { 'content-type': 'text/plain' }, body: '', tls: {} };
    if (url === 'https://shop.example.com/') {
      return {
        url, status: 200, headers: { 'content-type': 'text/html' },
        body: '<a href="/redirect-away">External redirect</a>', tls: {}
      };
    }
    return {
      url: 'https://other.example.net/private', status: 200,
      headers: { 'content-type': 'text/html' }, body: '<title>Other origin</title>', tls: {}
    };
  };
  const result = await collectMerchantWebsite('https://shop.example.com/', { maxPages: 2, fetchResource });
  assert.equal(result.pages.length, 1);
  assert.equal(result.errors[0].error, 'cross_origin_redirect_blocked');
});

test('screenshot target selection is bounded to homepage, contact and product detail pages', () => {
  const request = { website_url: 'https://shop.example.com/' };
  const collection = { pages: [
    { url: 'https://shop.example.com/', body: '<html></html>' },
    { url: 'https://shop.example.com/about', body: '<html></html>' },
    { url: 'https://shop.example.com/contact-us', body: '<html><h1>Contact us</h1></html>' },
    { url: 'https://shop.example.com/support', body: '<html><h1>Support</h1></html>' },
    { url: 'https://shop.example.com/products/one', body: '<html></html>' },
    { url: 'https://shop.example.com/products/two', body: '<html></html>' },
    { url: 'https://shop.example.com/products/three', body: '<html></html>' }
  ] };
  assert.deepEqual(selectScreenshotTargets(request, collection, 2), [
    { url: 'https://shop.example.com/', page_type: 'homepage' },
    { url: 'https://shop.example.com/contact-us', page_type: 'contact' },
    { url: 'https://shop.example.com/products/one', page_type: 'product' },
    { url: 'https://shop.example.com/products/two', page_type: 'product' }
  ]);
});

test('screenshot cost guard refuses to launch a browser above its USD 0.02 allocation', async (context) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'ai7-screenshot-budget-test-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  let launched = false;
  const result = await captureMerchantScreenshots(
    { website_url: 'https://shop.example.com/' },
    { pages: [{ url: 'https://shop.example.com/', body: '<html></html>' }] },
    {
      outputRoot,
      estimatedCostPerCaptureUsd: 0.03,
      launchBrowser: async () => { launched = true; throw new Error('browser_must_not_launch'); }
    }
  );
  assert.equal(launched, false);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errors[0].error, 'screenshot_budget_exceeded');
  assert.equal(result.cost.api_ceiling_usd, 0.05);
  assert.equal(result.cost.screenshot_budget_usd, 0.02);
  assert.equal(result.cost.budget_enforced, true);
});

test('isolated worker can explicitly use the Container App as its Chromium isolation boundary', async (context) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'ai7-screenshot-sandbox-test-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  let launchOptions;
  let evaluateCalls = 0;
  const page = {
    setDefaultNavigationTimeout() {}, setDefaultTimeout() {}, on() {},
    goto: async () => ({ status: () => 200 }),
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
    evaluate: async () => (++evaluateCalls === 1 ? undefined : { width: 1440, height: 900 }),
    screenshot: async () => Buffer.from('rendered-image'), content: async () => '<html></html>',
    url: () => 'https://shop.example.com/'
  };
  const browser = {
    newContext: async () => ({ route: async () => {}, newPage: async () => page, close: async () => {} }),
    close: async () => {}
  };
  const result = await captureMerchantScreenshots(
    { website_url: 'https://shop.example.com/' },
    { pages: [{ url: 'https://shop.example.com/', body: '<html></html>' }] },
    {
      outputRoot, maximumCaptures: 1, chromiumSandbox: false,
      resolver: async () => [{ address: '1.1.1.1', family: 4 }],
      launchBrowser: async (options) => { launchOptions = options; return browser; }
    }
  );
  assert.equal(launchOptions.chromiumSandbox, false);
  assert.equal(result.status, 'completed');
  assert.equal(result.items.length, 1);
});

test('local screenshot download is authenticated and disabled outside local mode', async (context) => {
  const previousMode = process.env.MERCHANT_SCREENSHOT_MODE;
  const previousOutput = process.env.MERCHANT_SCREENSHOT_OUTPUT_DIR;
  const outputRoot = await mkdtemp(join(tmpdir(), 'ai7-screenshot-download-test-'));
  const batchId = '11111111-1111-4111-8111-111111111111';
  const filename = '01-homepage-homepage-desktop.png';
  await mkdir(join(outputRoot, batchId));
  await writeFile(join(outputRoot, batchId, filename), Buffer.from('test-png'));
  process.env.MERCHANT_SCREENSHOT_MODE = 'local';
  process.env.MERCHANT_SCREENSHOT_OUTPUT_DIR = outputRoot;
  context.after(async () => {
    if (previousMode === undefined) delete process.env.MERCHANT_SCREENSHOT_MODE;
    else process.env.MERCHANT_SCREENSHOT_MODE = previousMode;
    if (previousOutput === undefined) delete process.env.MERCHANT_SCREENSHOT_OUTPUT_DIR;
    else process.env.MERCHANT_SCREENSHOT_OUTPUT_DIR = previousOutput;
    await rm(outputRoot, { recursive: true, force: true });
  });

  const app = createAppServer({ store: { isClientKey: async (value) => value === 'test-key' }, startWorker: false });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => app.close(resolve)));
  const screenshotUrl = `http://127.0.0.1:${app.address().port}/service/merchant_screening/screenshots/${batchId}/${filename}`;

  assert.equal((await fetch(screenshotUrl)).status, 401);
  const response = await fetch(screenshotUrl, { headers: { authorization: 'Bearer test-key' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(await response.text(), 'test-png');

  process.env.MERCHANT_SCREENSHOT_MODE = 'off';
  assert.equal((await fetch(screenshotUrl, { headers: { authorization: 'Bearer test-key' } })).status, 404);
});

test('analyzer extracts merchant evidence, product MCC candidates and risk signals', () => {
  const home = `<!doctype html><html><head>
    <title>Example Trading | Home</title><meta property="og:site_name" content="Example Trading LLC">
    <script type="application/ld+json">{
      "@context":"https://schema.org","@graph":[
        {"@type":"Organization","name":"Example Trading LLC","address":{"@type":"PostalAddress","streetAddress":"1 Market Street","addressLocality":"Dubai","addressCountry":"AE"},"telephone":"+97140000000","email":"support@example.com"},
        {"@type":"Person","name":"Amina Example","jobTitle":"Founder and CEO"},
        {"@type":"Product","name":"Reserve Whisky Bottle","description":"A limited edition whisky","sku":"W-1","offers":{"price":"250","priceCurrency":"AED"}}
      ]
    }</script></head><body>
      <a href="/privacy">Privacy Policy</a><a href="/terms">Terms and Conditions</a>
      <a href="/returns">Returns</a><a href="/contact">Customer Support</a>
      <a href="https://instagram.com/example">Instagram</a>
      <a href="https://online-casino.invalid/poker">Play poker</a>
      <p>We are an official partner with Example Expo and sponsor its annual event.</p>
    </body></html>`;
  const policy = '<html><body>We retain account data for the storage period required by law, then delete your data.</body></html>';
  const pages = [
    { url: 'https://shop.example.com/', status: 200, headers: { 'content-type': 'text/html', 'strict-transport-security': 'max-age=31536000' }, body: home, tls: { protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', authorized: true } },
    { url: 'https://shop.example.com/privacy', status: 200, headers: { 'content-type': 'text/html' }, body: policy, tls: {} }
  ];
  const request = { website_url: 'https://shop.example.com/', country_code: 'AE', declared_merchant_name: 'Example Trading LLC', declared_mcc: '5921', max_pages: 12 };
  const result = analyzeMerchantWebsite(request, { pages, robots: { status: 'respected' }, errors: [], limits: { maximum_pages: 12 } }, {
    status: 'available', domain: 'example.com', created_at: '2020-01-01T00:00:00Z', age_days: 2000
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.summary.decision_eligible, false);
  assert.equal(result.merchant_identity.names.includes('Example Trading LLC'), true);
  assert.equal(result.merchant_identity.addresses[0], '1 Market Street, Dubai, AE');
  assert.equal(result.merchant_identity.social_profiles[0].network, 'instagram');
  assert.equal(result.merchant_identity.founders[0].name, 'Amina Example');
  assert.equal(result.products[0].candidate_mcc.code, '5921');
  assert.equal(result.products[0].risk_level, 'high');
  assert.equal(result.outgoing_links.some((link) => link.prohibited_risk_signals.includes('gambling')), true);
  assert.equal(result.policies.data_storage_and_retention.status, 'language_found');
  assert.equal(result.security.tls.protocol, 'TLSv1.3');
  assert.equal(result.screenshots.status, 'not_configured');
  assert.equal(result.social_mentions.x.status, 'not_configured');
  assert.equal(result.destination_reputation.status, 'not_configured');
  assert.equal(Object.hasOwn(result, 'company_registry'), false);
  assert.equal(result.evidence.length, 2);
});

test('optional provider failures produce explicit partial coverage instead of failing the screening', async () => {
  const request = { website_url: 'https://shop.example.com/', country_code: 'AE', declared_merchant_name: null, declared_mcc: null, max_pages: 1 };
  const result = await screenMerchantWebsite(request, {
    collectWebsite: async () => ({
      pages: [{ url: request.website_url, status: 200, headers: { 'content-type': 'text/html' }, body: '<html><title>Shop</title></html>', tls: {} }],
      robots: { status: 'unavailable' }, errors: [], limits: { maximum_pages: 1 }
    }),
    collectDomain: async () => { throw new Error('rdap failed'); },
    xMentionsProvider: async () => { throw new Error('rate limited'); }
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.domain.status, 'unavailable');
  assert.equal(result.social_mentions.x.status, 'unavailable');
  assert.equal(result.summary.decision_eligible, false);
});

test('customer thresholds control the risk band without hiding partial coverage', () => {
  const request = {
    website_url: 'https://shop.example.com/', country_code: 'AE', declared_merchant_name: null,
    declared_mcc: null, max_pages: 1, high_risk_threshold_percent: 100, review_threshold_percent: 99
  };
  const result = analyzeMerchantWebsite(request, {
    pages: [{ url: request.website_url, status: 200, headers: { 'content-type': 'text/html' }, body: '<html><title>Shop</title></html>', tls: {} }],
    robots: { status: 'respected' }, errors: [], limits: { maximum_pages: 1 }
  }, { status: 'available', domain: 'example.com', age_days: 1000 });
  assert.equal(result.summary.risk_level, 'safe');
  assert.deepEqual(result.summary.thresholds, { high_risk_percent: 100, review_percent: 99, safe_below_percent: 99 });
  assert.equal(result.status, 'partial');
  assert.equal(result.summary.decision_eligible, false);
  assert.equal(result.summary.human_review_required, true);
  assert.equal(result.summary.threshold_status, 'safe');
});

test('screenshot bytes stay private while report assets remain available to the API process', async () => {
  const screenshotBytes = Buffer.from('private-image-bytes');
  const request = { website_url: 'https://shop.example.com/', country_code: 'AE', declared_merchant_name: null, declared_mcc: null, max_pages: 1, get_pdf: true, customer_logo_url: null };
  const result = await screenMerchantWebsite(request, {
    collectWebsite: async () => ({
      pages: [{ url: request.website_url, status: 200, headers: { 'content-type': 'text/html' }, body: '<html><title>Shop</title></html>', tls: {} }],
      robots: { status: 'respected' }, errors: [], limits: { maximum_pages: 1 }
    }),
    collectDomain: async () => ({ status: 'available', domain: 'example.com' }),
    screenshotProvider: async () => ({
      status: 'completed', provider: 'ai7_rendered_capture', items: [{
        page_type: 'homepage', source_url: request.website_url, final_url: request.website_url,
        viewport: { name: 'desktop', width: 1440, height: 900 }, content_type: 'image/png',
        captured_at: '2026-10-26T10:00:00.000Z', sha256: 'a'.repeat(64), __image_bytes: screenshotBytes
      }]
    })
  });
  assert.equal(JSON.stringify(result).includes('private-image-bytes'), false);
  assert.equal(Object.hasOwn(result.screenshots.items[0], '__image_bytes'), false);
  assert.deepEqual(result[merchantScreenshotAssets][0].bytes, screenshotBytes);
});

test('merchant screening route preserves API-key auth and supports an injected local screener', async (context) => {
  const calls = [];
  const app = createAppServer({
    store: {
      isClientKey: async (value) => value === 'test-key',
      getIntegration: async () => null
    },
    merchantScreener: async (request) => {
      calls.push(request);
      return { screening_id: 'local-screening', status: 'partial', request };
    },
    startWorker: false
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => app.close(resolve)));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;

  const unauthorized = await fetch(`${baseUrl}/service/merchant_screening`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ website_url: 'https://example.com', country_code: 'AE' })
  });
  assert.equal(unauthorized.status, 401);

  const invalid = await fetch(`${baseUrl}/service/merchant_screening`, {
    method: 'POST', headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify({ website_url: 'http://example.com', country_code: 'AE' })
  });
  assert.equal(invalid.status, 400);

  const response = await fetch(`${baseUrl}/service/merchant_screening`, {
    method: 'POST', headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify({ website_url: 'https://example.com', country_code: 'ae', max_pages: 5 })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.screening_id, 'local-screening');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].country_code, 'AE');
  assert.equal(calls[0].max_pages, 5);
  assert.equal(calls[0].high_risk_threshold_percent, 60);
  assert.equal(calls[0].review_threshold_percent, 25);

  const portal = await fetch(`${baseUrl}/merchant-screening`, { headers: { host: 'api.ai7uae.com' } });
  const html = await portal.text();
  assert.equal(portal.status, 200);
  assert.match(html, /Merchant Website Screening/);
  assert.match(html, /merchant-screening\.js\?v=2/);
  assert.match(html, /Copy JSON/);
  assert.match(html, /id="get-pdf"/);
  assert.match(html, /id="customer-logo-url"/);
  assert.match(html, /id="download-report"/);
  assert.match(html, /id="high-risk-threshold"/);
  assert.match(html, /id="review-threshold"/);

  const script = await (await fetch(`${baseUrl}/merchant-screening.js`, { headers: { host: 'api.ai7uae.com' } })).text();
  assert.match(script, /fetch\('\/service\/merchant_screening'/);
  assert.match(script, /navigator\.clipboard\.writeText/);
  assert.match(script, /get_pdf: getPdf\.checked/);
  assert.match(script, /report\?\.download_url/);
  assert.match(script, /high_risk_threshold_percent: highRiskThresholdPercent/);
});

test('merchant screening can create and publicly download a permanent typed PDF report', async (context) => {
  const reportStore = new MemoryAdverseMediaReportStore();
  const merchantScreener = async (request) => ({
    screening_id: '8f5f868e-4894-4ef5-80fd-4728910ce3e3', status: 'partial', completed_at: '2026-10-26T10:05:00.000Z',
    request, merchant_identity: { names: ['Example Merchant LLC'], addresses: [], phones: [], emails: [], social_profiles: [], founders: [], senior_leadership: [], partnership_and_sponsorship_claims: [] },
    domain: { status: 'available', domain: 'example.com' },
    policies: { country_pack: { name: 'United Arab Emirates' }, missing_expected_items: [], privacy: { status: 'found', url: 'https://example.com/privacy' } },
    products: [], outgoing_links: [], security: { tls: { protocol: 'TLSv1.3', authorized: true }, missing_recommended_headers: [] },
    screenshots: { status: 'completed', items: [] }, social_mentions: { x: { status: 'not_configured' } }, destination_reputation: { status: 'not_configured' },
    crawl: { robots: { status: 'respected' }, pages_collected: 1, page_errors: [], limits: { maximum_pages: request.max_pages } },
    findings: [], summary: { risk_score: 0, risk_level: 'low', outcome: 'manual_review', confidence: 'low', decision_eligible: false, coverage: { website: 'available', screenshots: 'completed', x_mentions: 'not_configured', destination_reputation: 'not_configured' } },
    evidence: [], methodology: { version: 'merchant-screening-foundation-1', cost_ceiling_usd: 0.05 }
  });
  const app = createAppServer({
    store: { isClientKey: async (value) => value === 'test-key', getIntegration: async () => null },
    reportStore, merchantScreener, startWorker: false
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => app.close(resolve)));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  const created = await fetch(`${baseUrl}/service/merchant_screening`, {
    method: 'POST', headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify({ website_url: 'https://example.com', country_code: 'AE', declared_merchant_name: 'Example Merchant LLC', get_pdf: true })
  });
  assert.equal(created.status, 200);
  const body = await created.json();
  assert.match(body.report.report_id, /^[0-9a-f-]{36}$/);
  assert.match(body.report.sha256, /^[0-9a-f]{64}$/);
  assert.equal(body.report.retention, 'permanent');

  const downloaded = await fetch(new URL(body.report.download_url, baseUrl));
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'application/pdf');
  assert.match(downloaded.headers.get('content-disposition'), /ai7-merchant-screening-example-merchant-llc/);
  assert.equal(downloaded.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(Buffer.from(await downloaded.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await fetch(`${baseUrl}/service/adverse_media/reports/${body.report.report_id}.pdf`)).status, 404);
});
