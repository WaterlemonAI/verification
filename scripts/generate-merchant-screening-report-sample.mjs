import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { merchantScreenshotAssets, screenMerchantWebsite, validateMerchantScreeningRequest } from '../lib/merchant-screening.mjs';
import { createMerchantScreeningAuditPdf } from '../lib/merchant-screening-report.mjs';
import { captureMerchantScreenshots } from '../lib/merchant-screenshot.mjs';

const outputPath = resolve('output/pdf/merchant-screening-sample.pdf');
const screenshotRoot = resolve('tmp/pdfs/merchant-sample-screenshots');
await rm(screenshotRoot, { recursive: true, force: true });
await mkdir(screenshotRoot, { recursive: true });
await mkdir(resolve('output/pdf'), { recursive: true });

const validation = validateMerchantScreeningRequest({
  website_url: 'https://example.com/', country_code: 'AE', declared_merchant_name: 'Example Domain',
  max_pages: 1, get_pdf: true
});
if (validation.error) throw new Error(validation.error);

const result = await screenMerchantWebsite(validation.value, {
  screenshotProvider: (request, collection) => captureMerchantScreenshots(request, collection, {
    outputRoot: screenshotRoot,
    maximumCaptures: 2,
    maximumHeight: 900,
    navigationTimeoutMs: 20_000
  })
});
const report = await createMerchantScreeningAuditPdf({
  request: validation.value,
  response: result,
  screenshots: result[merchantScreenshotAssets] || [],
  origin: {
    received_at: new Date(Date.now() - 5_000).toISOString(),
    network_origin: '203.0.113.10 (sample documentation address)',
    processing_location: 'Microsoft Azure UAE North'
  }
});
await writeFile(outputPath, report.bytes);
process.stdout.write(`${outputPath}\n${report.sha256}\n${result.screenshots.status}\n${result.screenshots.items.length}\n`);
