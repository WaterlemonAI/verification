import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeMerchantWebsite, screenMerchantWebsite, validateMerchantScreeningRequest } from '../lib/merchant-screening.mjs';
import { isPublicIpAddress, validatePublicHttpsUrl } from '../lib/merchant-screening-network.mjs';
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
  assert.match(validateMerchantScreeningRequest({ website_url: 'https://shop.example.com', country_code: 'AE', max_pages: 21 }).error, /between 1 and 20/);
  assert.match(validateMerchantScreeningRequest({ website_url: 'https://shop.example.com', country_code: 'AE', declared_mcc: '123' }).error, /four digits/);
  assert.match(validateMerchantScreeningRequest({ website_url: 'https://shop.example.com', country_code: 'AE', unexpected: true }).error, /Unsupported field/);
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

test('merchant screening route preserves API-key auth and supports an injected local screener', async (context) => {
  const calls = [];
  const app = createAppServer({
    store: { isClientKey: async (value) => value === 'test-key' },
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
});
