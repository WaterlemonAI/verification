import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMerchantScreenshots } from './lib/merchant-screenshot.mjs';
import { validateMerchantScreeningRequest } from './lib/merchant-screening.mjs';

const port = Number(process.env.PORT || 8081);
const maximumBodyBytes = 2 * 1024 * 1024;

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumBodyBytes) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validatePages(request, pages) {
  if (!Array.isArray(pages) || !pages.length || pages.length > request.max_pages) throw new Error('invalid_pages');
  const origin = new URL(pages[0].url).origin;
  return pages.map((page) => {
    const url = new URL(String(page.url || ''));
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('invalid_page_origin');
    return { url: url.href, body: String(page.body || '').slice(0, 20_000) };
  });
}

async function capture(req, res) {
  let batchId;
  try {
    const body = await readJson(req);
    const validation = validateMerchantScreeningRequest(body.request);
    if (validation.error) return json(res, 400, { status: 'Error', error: 'invalid_request' });
    const pages = validatePages(validation.value, body.pages);
    const result = await captureMerchantScreenshots(validation.value, { pages });
    batchId = result.batch_id;
    return json(res, 200, {
      ...result,
      provider: 'ai7_rendered_capture',
      local_only: false,
      items: result.items.map(({ __image_bytes, download_path: _downloadPath, ...item }) => ({
        ...item,
        image_base64: __image_bytes.toString('base64')
      }))
    });
  } catch {
    return json(res, 503, { status: 'Error', error: 'capture_unavailable' });
  } finally {
    if (batchId) {
      const outputRoot = process.env.MERCHANT_SCREENSHOT_OUTPUT_DIR || join(tmpdir(), 'ai7-merchant-screenshots');
      await rm(join(outputRoot, batchId), { recursive: true, force: true }).catch(() => {});
    }
  }
}

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('ok\n');
  }
  if (req.method === 'POST' && req.url === '/capture') return capture(req, res);
  return json(res, 404, { status: 'Error', error: 'not_found' });
}).listen(port, '0.0.0.0', () => console.log(`Merchant screenshot worker listening on port ${port}`));
