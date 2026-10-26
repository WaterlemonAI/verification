import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium } from 'playwright-core';
import { isPublicIpAddress, validatePublicHttpsUrl } from './merchant-screening-network.mjs';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false },
  { name: 'mobile', width: 390, height: 844, isMobile: true }
];
const API_COST_CEILING_USD = 0.05;
const SCREENSHOT_BUDGET_USD = 0.02;

function browserExecutablePath(explicitPath = process.env.MERCHANT_SCREENSHOT_BROWSER_PATH) {
  if (explicitPath) return explicitPath;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return undefined;
}

function pageLooksLikeProduct(page) {
  const url = new URL(page.url);
  if (/\/(products?|shop|store)\/[^/]+\/?$/i.test(url.pathname)) return true;
  return /<meta\b[^>]*(?:property|name)=["']og:type["'][^>]*content=["']product["']/i.test(page.body)
    || /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?["']@type["']\s*:\s*["']Product["']/i.test(page.body);
}

function pageLooksLikeContact(page) {
  const url = new URL(page.url);
  if (/(?:^|\/)(?:contact(?:-us)?|customer-support|support|help)(?:\/|$)/i.test(url.pathname)) return true;
  return /<(?:title|h1)\b[^>]*>[^<]*(?:contact(?:\s+us)?|customer\s+support|support\s+centre)[^<]*<\//i.test(page.body);
}

export function selectScreenshotTargets(request, collection, maxProductPages = 5, maxContactPages = 1) {
  const targets = [];
  const seen = new Set();
  const add = (page, type) => {
    if (!page || seen.has(page.url)) return;
    seen.add(page.url);
    targets.push({ url: page.url, page_type: type });
  };
  add(collection.pages[0] || { url: request.website_url }, 'homepage');
  for (const page of collection.pages) {
    if (targets.filter((target) => target.page_type === 'contact').length >= maxContactPages) break;
    if (pageLooksLikeContact(page)) add(page, 'contact');
  }
  for (const page of collection.pages) {
    if (targets.filter((target) => target.page_type === 'product').length >= maxProductPages) break;
    if (pageLooksLikeProduct(page)) add(page, 'product');
  }
  return targets;
}

async function assertPublicBrowserUrl(rawUrl, resolver, validationCache) {
  const url = validatePublicHttpsUrl(rawUrl);
  const cached = validationCache.get(url.hostname);
  if (!cached || Date.now() - cached.checkedAt > 5_000) {
    const validation = resolver(url.hostname, { all: true, verbatim: true }).then((addresses) => {
      if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) throw new Error('blocked_non_public_browser_request');
      return true;
    });
    validationCache.set(url.hostname, { checkedAt: Date.now(), validation });
  }
  await validationCache.get(url.hostname).validation;
  return url;
}

function safeFilename(index, target, viewport) {
  const slug = basename(new URL(target.url).pathname) || target.page_type;
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || target.page_type;
  return `${String(index + 1).padStart(2, '0')}-${target.page_type}-${safeSlug}-${viewport.name}.png`;
}

async function settlePage(page) {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    const maximum = Math.min(document.documentElement.scrollHeight, 12_000);
    for (let position = 0; position < maximum; position += Math.max(window.innerHeight, 700)) {
      window.scrollTo(0, position);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(250);
}

async function captureOne(browser, target, viewport, index, batchId, outputDirectory, {
  resolver,
  validationCache,
  navigationTimeoutMs,
  maximumHeight,
  maximumScreenshotBytes
}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    screen: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: viewport.isMobile,
    hasTouch: viewport.isMobile,
    acceptDownloads: false,
    serviceWorkers: 'block',
    javaScriptEnabled: true,
    reducedMotion: 'reduce',
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai'
  });
  const blockedRequests = [];
  try {
    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (/^(data|blob|about):/i.test(requestUrl)) return route.continue();
      try {
        await assertPublicBrowserUrl(requestUrl, resolver, validationCache);
        return route.continue();
      } catch (error) {
        blockedRequests.push({ url: requestUrl.slice(0, 2048), reason: error.message });
        return route.abort('blockedbyclient');
      }
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(navigationTimeoutMs);
    page.setDefaultTimeout(Math.min(navigationTimeoutMs, 10_000));
    page.on('popup', (popup) => popup.close().catch(() => {}));
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    if (!response || response.status() >= 400) throw new Error(`screenshot_http_${response?.status() || 0}`);
    await page.waitForLoadState('networkidle', { timeout: Math.min(navigationTimeoutMs, 5_000) }).catch(() => {});
    await page.waitForTimeout(750);
    await settlePage(page);
    const dimensions = await page.evaluate(() => ({
      width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth),
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight)
    }));
    const captureWidth = Math.min(Math.max(dimensions.width, viewport.width), viewport.width);
    const captureHeight = Math.min(Math.max(dimensions.height, viewport.height), maximumHeight);
    const bytes = await page.screenshot({
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      clip: { x: 0, y: 0, width: captureWidth, height: captureHeight },
      timeout: navigationTimeoutMs
    });
    if (bytes.length > maximumScreenshotBytes) throw new Error('screenshot_too_large');
    const dom = await page.content();
    const filename = safeFilename(index, target, viewport);
    const localPath = join(outputDirectory, filename);
    await writeFile(localPath, bytes, { flag: 'wx', mode: 0o600 });
    return {
      status: 'captured',
      page_type: target.page_type,
      source_url: target.url,
      final_url: page.url(),
      http_status: response.status(),
      viewport: { name: viewport.name, width: viewport.width, height: viewport.height },
      captured_area: { width: captureWidth, height: captureHeight, truncated: dimensions.height > captureHeight },
      captured_at: new Date().toISOString(),
      content_type: 'image/png',
      byte_length: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      rendered_dom_sha256: createHash('sha256').update(dom).digest('hex'),
      download_path: `/service/merchant_screening/screenshots/${batchId}/${filename}`,
      blocked_request_count: blockedRequests.length
    };
  } finally {
    await context.close();
  }
}

export async function captureMerchantScreenshots(request, collection, {
  executablePath,
  outputRoot = process.env.MERCHANT_SCREENSHOT_OUTPUT_DIR || join(tmpdir(), 'ai7-merchant-screenshots'),
  resolver = dnsLookup,
  navigationTimeoutMs = 20_000,
  maximumHeight = 12_000,
  maximumScreenshotBytes = 10 * 1024 * 1024,
  maxProductPages = 2,
  maxContactPages = 1,
  estimatedCostPerCaptureUsd = Number(process.env.MERCHANT_SCREENSHOT_ESTIMATED_COST_PER_CAPTURE_USD || 0),
  launchBrowser = (options) => chromium.launch(options)
} = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('local_screenshot_provider_disabled_in_production');
  if (!Number.isFinite(estimatedCostPerCaptureUsd) || estimatedCostPerCaptureUsd < 0) {
    throw new Error('invalid_screenshot_cost_rate');
  }
  const batchId = randomUUID();
  const outputDirectory = join(outputRoot, batchId);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const targets = selectScreenshotTargets(request, collection, maxProductPages, maxContactPages);
  const capturePlan = targets.flatMap((target) => VIEWPORTS.map((viewport) => ({ target, viewport })));
  const affordableCaptures = estimatedCostPerCaptureUsd === 0
    ? capturePlan.length
    : Math.floor((SCREENSHOT_BUDGET_USD + Number.EPSILON) / estimatedCostPerCaptureUsd);
  const approvedCapturePlan = capturePlan.slice(0, affordableCaptures);
  const items = [];
  const errors = [];
  if (approvedCapturePlan.length < capturePlan.length) {
    errors.push({
      error: 'screenshot_budget_exceeded',
      skipped_capture_count: capturePlan.length - approvedCapturePlan.length
    });
  }
  if (!approvedCapturePlan.length) {
    return {
      status: 'unavailable', provider: 'playwright_local', local_only: true, batch_id: batchId, items, errors,
      limits: {
        maximum_product_pages: maxProductPages,
        maximum_contact_pages: maxContactPages,
        maximum_captures: (maxProductPages + maxContactPages + 1) * VIEWPORTS.length,
        planned_captures: capturePlan.length,
        executed_render_attempts: 0,
        maximum_height: maximumHeight,
        maximum_screenshot_bytes: maximumScreenshotBytes
      },
      cost: {
        api_ceiling_usd: API_COST_CEILING_USD,
        screenshot_budget_usd: SCREENSHOT_BUDGET_USD,
        estimated_cost_per_capture_usd: estimatedCostPerCaptureUsd,
        estimated_render_cost_usd: 0,
        remaining_api_budget_usd: API_COST_CEILING_USD,
        budget_enforced: true
      }
    };
  }
  const browser = await launchBrowser({
    executablePath: browserExecutablePath(executablePath),
    headless: true,
    chromiumSandbox: true,
    downloadsPath: outputDirectory
  });
  try {
    const validationCache = new Map();
    for (const [index, { target, viewport }] of approvedCapturePlan.entries()) {
      try {
        items.push(await captureOne(browser, target, viewport, index, batchId, outputDirectory, {
          resolver, validationCache, navigationTimeoutMs, maximumHeight, maximumScreenshotBytes
        }));
      } catch (error) {
        errors.push({ source_url: target.url, viewport: viewport.name, error: error.message });
      }
    }
  } finally {
    await browser.close();
  }
  const estimatedRenderCostUsd = Number((approvedCapturePlan.length * estimatedCostPerCaptureUsd).toFixed(6));
  return {
    status: items.length === capturePlan.length ? 'completed' : items.length ? 'partial' : 'unavailable',
    provider: 'playwright_local',
    local_only: true,
    batch_id: batchId,
    items,
    errors,
    limits: {
      maximum_product_pages: maxProductPages,
      maximum_contact_pages: maxContactPages,
      maximum_captures: (maxProductPages + maxContactPages + 1) * VIEWPORTS.length,
      planned_captures: capturePlan.length,
      executed_render_attempts: approvedCapturePlan.length,
      maximum_height: maximumHeight,
      maximum_screenshot_bytes: maximumScreenshotBytes
    },
    cost: {
      api_ceiling_usd: API_COST_CEILING_USD,
      screenshot_budget_usd: SCREENSHOT_BUDGET_USD,
      estimated_cost_per_capture_usd: estimatedCostPerCaptureUsd,
      estimated_render_cost_usd: estimatedRenderCostUsd,
      remaining_api_budget_usd: Number((API_COST_CEILING_USD - estimatedRenderCostUsd).toFixed(6)),
      budget_enforced: true,
      note: 'The local Chromium default has no external provider charge. A configured non-zero render rate is checked before browser launch and cannot exceed the screenshot allocation.'
    }
  };
}
