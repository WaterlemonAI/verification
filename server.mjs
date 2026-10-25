import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8080);
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 15 * 1024 * 1024);
const apiHosts = new Set((process.env.API_HOSTS || 'api.ai7uae.com,localhost,127.0.0.1').split(',').map((v) => v.trim().toLowerCase()));

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    ...extraHeaders
  });
  res.end(payload);
}

function securityHeaders(res) {
  res.setHeader('content-security-policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self' https://api.ai7uae.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] || '';
}

function configuredKeyHashes() {
  const raw = process.env.AI7_API_KEY_HASHES || '';
  return raw.split(',').map((value) => value.trim().toLowerCase()).filter((value) => /^[a-f0-9]{64}$/.test(value));
}

function validApiKey(token) {
  if (!token) return false;
  const presented = Buffer.from(createHash('sha256').update(token).digest('hex'));
  return configuredKeyHashes().some((hash) => timingSafeEqual(presented, Buffer.from(hash)));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('request_too_large');
      error.statusCode = 400;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function proxyTradeLicence(req, res) {
  if (!validApiKey(bearerToken(req))) {
    return json(res, 401, { status: 'Error', error: 'API key is missing or incorrect.' });
  }

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json') && !contentType.startsWith('multipart/form-data')) {
    return json(res, 400, { status: 'Error', error: 'Content-Type must be application/json or multipart/form-data.' });
  }

  const upstreamUrl = process.env.UAE_TLV_UPSTREAM_URL;
  const upstreamToken = process.env.UAE_TLV_UPSTREAM_TOKEN;
  if (!upstreamUrl || !upstreamToken) {
    return json(res, 500, { status: 'Error', error: 'The service is temporarily unavailable. Please try again shortly.' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    if (error.statusCode === 400) {
      return json(res, 400, { status: 'Error', error: 'The request body is too large.' });
    }
    throw error;
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${upstreamToken}`,
        'content-type': req.headers['content-type'],
        accept: 'application/json'
      },
      body,
      signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS || 120000))
    });
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'content-length': responseBody.length,
      'cache-control': 'no-store'
    });
    res.end(responseBody);
  } catch {
    json(res, 500, { status: 'Error', error: 'The service is temporarily unavailable. Please try again shortly.' });
  }
}

function safeAssetPath(directory, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const wanted = decoded === '/' ? '/index.html' : decoded;
  const candidate = normalize(join(directory, wanted));
  return candidate.startsWith(directory) ? candidate : null;
}

function serveStatic(res, directory, requestPath) {
  let filePath = safeAssetPath(directory, requestPath);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(directory, 'index.html');
  }
  const stat = statSync(filePath);
  res.writeHead(200, {
    'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600'
  });
  createReadStream(filePath).pipe(res);
}

export function createAppServer() {
  return createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url || '/', 'http://localhost');
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('ok\n');
    }

    if (url.pathname === '/service/uae_tlv') {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return json(res, 405, { status: 'Error', error: 'Method not allowed.' });
      }
      return proxyTradeLicence(req, res);
    }

    if (url.pathname === '/openapi.json') {
      const spec = readFileSync(join(root, 'api', 'openapi.json'));
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': spec.length,
        'cache-control': 'public, max-age=300'
      });
      return res.end(spec);
    }

    const directory = apiHosts.has(host) || url.pathname.startsWith('/docs')
      ? join(root, 'api-site')
      : join(root, 'site');
    return serveStatic(res, directory, url.pathname.replace(/^\/docs/, '') || '/');
  });
}

if (process.env.NODE_ENV !== 'test') {
  createAppServer().listen(port, '0.0.0.0', () => {
    console.log(`AI7 UAE service listening on port ${port}`);
  });
}
