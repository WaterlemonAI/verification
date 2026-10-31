import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.BSA_LOCAL_ENABLED = '1';
process.env.BSA_DATA_KEY_HEX = '11'.repeat(32);
const key = 'ai7_local_bsa_demo_test';
const otherKey = 'ai7_local_bsa_other_test';
const adminKey = 'ai7_local_bsa_admin_test';
process.env.AI7_API_KEY_HASHES = [key, otherKey].map((value) => createHash('sha256').update(value).digest('hex')).join(',');
process.env.AI7_ADMIN_KEY_HASHES = createHash('sha256').update(adminKey).digest('hex');
const { createAppServer } = await import('../server.mjs');
const { encryptBsa } = await import('../lib/bsa-crypto.mjs');

let directory;
let server;
let url;
let pdf;
let adminCookie;
let adminCsrf;
const codes = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ai7-bsa-'));
  process.env.BSA_DATA_DIR = directory;
  pdf = await readFile(new URL('./fixtures/bsa-synthetic-combined.pdf', import.meta.url));
  await writeFile(join(directory, 'worker-capabilities.json'), JSON.stringify({ native: 'ready', rapidocr: 'ready', paddleocr: 'ready', azureLayout: 'configured' }));
  server = createAppServer({ startWorker: false, mailer: { configured: true,
    sendLoginCode: async (value) => { codes.push(value); } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  const setup = await fetch(`${url}/admin/api/auth/setup`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'analysis-admin@example.com', password: 'StrongAnalysis!123' })
  });
  assert.equal(setup.status, 201);
  const login = await fetch(`${url}/admin/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'analysis-admin@example.com', password: 'StrongAnalysis!123' }) });
  assert.equal(login.status, 202);
  const verify = await fetch(`${url}/admin/api/auth/verify-code`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'analysis-admin@example.com',
      challenge_id: (await login.json()).challenge_id, code: codes.at(-1).code }) });
  assert.equal(verify.status, 200);
  adminCookie = verify.headers.get('set-cookie').split(';')[0];
  adminCsrf = (await verify.json()).csrf_token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

function form(file = pdf) {
  const body = new FormData();
  body.append('statement_file', new Blob([file], { type: 'application/pdf' }), 'synthetic.pdf');
  body.append('country_code', 'AE');
  body.append('entity_type', 'individual');
  return body;
}

test('authenticated upload, idempotency, tenant isolation and result retrieval', async () => {
  const headers = { authorization: `Bearer ${key}`, 'idempotency-key': 'bsa-demo-key-001' };
  const first = await fetch(`${url}/service/bank_statement_analysis`, { method: 'POST', headers, body: form() });
  assert.equal(first.status, 202);
  const accepted = await first.json();
  assert.match(accepted.analysisId, /^bsa_/);
  const repeat = await fetch(`${url}/service/bank_statement_analysis`, { method: 'POST', headers, body: form() });
  assert.equal(repeat.status, 202);
  assert.equal((await repeat.json()).analysisId, accepted.analysisId);
  const forbidden = await fetch(`${url}${accepted.statusUrl}`, { headers: { authorization: `Bearer ${otherKey}` } });
  assert.equal(forbidden.status, 404);
  const pending = await fetch(`${url}${accepted.resultUrl}`, { headers });
  assert.equal(pending.status, 202);
  const jobFile = join(directory, 'jobs', accepted.analysisId, 'job.json');
  const job = JSON.parse(await readFile(jobFile, 'utf8'));
  const storedInput = await readFile(join(directory, 'jobs', accepted.analysisId, 'input-0.bin'));
  assert.equal(storedInput.subarray(0, 4).toString(), 'BSA1');
  assert.notEqual(storedInput.subarray(0, 5).toString(), '%PDF-');
  assert.equal(job.fields, undefined);
  await writeFile(join(directory, 'jobs', accepted.analysisId, 'result.json'), JSON.stringify({ analysisId: accepted.analysisId, status: 'completed' }));
  await writeFile(jobFile, JSON.stringify({ ...job, status: 'completed' }));
  const result = await fetch(`${url}${accepted.resultUrl}`, { headers });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, 'completed');
});

test('accepts an optional signed callback and never redisplays its signing secret', async () => {
  const headers = { authorization: `Bearer ${key}`, 'idempotency-key': 'bsa-callback-key-001' };
  const callbackForm = () => {
    const body = form();
    body.append('callback_url', 'https://8.8.8.8/ai7-callback');
    return body;
  };
  const first = await fetch(`${url}/service/bank_statement_analysis`, { method: 'POST', headers, body: callbackForm() });
  assert.equal(first.status, 202);
  const accepted = await first.json();
  assert.equal(accepted.callback.configured, true);
  assert.equal(accepted.callback.event, 'bank_statement_analysis.completed');
  assert.equal(accepted.callback.signature_header, 'x-ai7-signature');
  assert.match(accepted.callback.signing_secret, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(accepted.callback.signing_secret_returned, true);

  const repeated = await fetch(`${url}/service/bank_statement_analysis`, { method: 'POST', headers, body: callbackForm() });
  assert.equal(repeated.status, 202);
  const reused = await repeated.json();
  assert.equal(reused.analysisId, accepted.analysisId);
  assert.equal(reused.callback.delivery_id, accepted.callback.delivery_id);
  assert.equal(reused.callback.signing_secret, undefined);
  assert.equal(reused.callback.signing_secret_returned, false);

  const status = await (await fetch(`${url}${accepted.statusUrl}`, { headers })).json();
  assert.deepEqual(status.callback, {
    requested: true, status: 'pending', deliveryId: accepted.callback.delivery_id, attempts: 0
  });

  const invalid = form();
  invalid.append('callback_url', 'http://127.0.0.1/private');
  const rejected = await fetch(`${url}/service/bank_statement_analysis`, { method: 'POST',
    headers: { ...headers, 'idempotency-key': 'bsa-callback-key-002' }, body: invalid });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).reasonCode, 'INVALID_CALLBACK_URL');
});

test('rejects unauthenticated, invalid, oversized and conflicting uploads', async () => {
  assert.equal((await fetch(`${url}/service/bank_statement_analysis`, { method: 'POST', body: form(), headers: { 'idempotency-key': 'bsa-demo-key-002' } })).status, 401);
  const headers = { authorization: `Bearer ${key}`, 'idempotency-key': 'bsa-demo-key-003' };
  const invalid = await fetch(`${url}/service/bank_statement_analysis`, { method: 'POST', headers, body: form(Buffer.from('not-a-pdf')) });
  assert.equal(invalid.status, 415);
  assert.equal((await invalid.json()).reasonCode, 'UNSUPPORTED_FILE_TYPE');
  const valid = await fetch(`${url}/service/bank_statement_analysis`, { method: 'POST', headers, body: form() });
  assert.equal(valid.status, 202);
  const different = await fetch(`${url}/service/bank_statement_analysis`, { method: 'POST', headers, body: form(Buffer.from('%PDF-different')) });
  assert.equal(different.status, 409);
});

test('admin console uses its signed session and CSRF protection for the local demo', async () => {
  const headers = { cookie: adminCookie, 'x-ai7-csrf': adminCsrf, 'idempotency-key': 'bsa-admin-key-001' };
  const config = await fetch(`${url}/admin/api/bsa/config`, { headers });
  assert.equal(config.status, 200);
  assert.equal((await config.json()).enabled, true);
  const rejected = await fetch(`${url}/admin/api/bsa/config`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(rejected.status, 401);
  assert.equal((await fetch(`${url}/admin/api/bsa`, { method: 'POST', headers: { cookie: adminCookie, 'idempotency-key': 'bsa-admin-key-002' }, body: form() })).status, 403);
  const submitted = await fetch(`${url}/admin/api/bsa`, { method: 'POST', headers, body: form() });
  assert.equal(submitted.status, 202);
  const accepted = await submitted.json();
  assert.match(accepted.statusUrl, /^\/admin\/api\/bsa\//);
  assert.equal((await fetch(`${url}${accepted.statusUrl}`, { headers })).status, 200);
  assert.equal((await fetch(`${url}${accepted.statusUrl}`, { headers: { authorization: `Bearer ${key}` } })).status, 401);
  const html = await (await fetch(`${url}/admin`)).text();
  assert.match(html, /data-view="analysis"[^>]*>.*Analysis<\/button>/);
  assert.match(html, /id="analysis-view"/);
  assert.match(html, /Bank statements/);
  assert.match(html, /id="bsa-capabilities"/);
  assert.equal((await fetch(`${url}/admin/bsa-synthetic-combined.pdf`)).status, 404);
  const publicPage = await fetch(`${url}/bank-statement-analysis`);
  assert.equal(publicPage.status, 200);
  assert.match(await publicPage.text(), /Bank statement analysis/);
});

test('local demo assets and routes are hidden when the feature gate is off', async () => {
  process.env.BSA_LOCAL_ENABLED = '0';
  try {
    for (const path of ['/bank-statement-analysis', '/bank-statement-analysis/openapi.json', '/bsa-demo.js', '/bsa-synthetic-combined.pdf', '/admin/bsa-synthetic-combined.pdf']) {
      assert.equal((await fetch(`${url}${path}`)).status, 404);
    }
    const admin = await (await fetch(`${url}/admin`)).text();
    assert.match(admin, /data-view="analysis"[^>]*>.*Analysis<\/button>/);
    assert.equal((await fetch(`${url}/admin/api/bsa/config`, { headers: { cookie: adminCookie } })).status, 503);
  } finally {
    process.env.BSA_LOCAL_ENABLED = '1';
  }
});

test('local OpenAPI documents the gated async service', async () => {
  const response = await fetch(`${url}/bank-statement-analysis/openapi.json`);
  assert.equal(response.status, 200);
  const spec = await response.json();
  assert.ok(spec.paths['/service/bank_statement_analysis'].post);
  assert.ok(spec.paths['/service/bank_statement_analysis/{analysisId}/artifacts/{filename}'].get);
});

test('image bundles, MIME checks and authenticated artifact downloads', async () => {
  const headers = { authorization: `Bearer ${key}`, 'idempotency-key': 'bsa-images-key-001' };
  const image = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de', 'hex');
  const images = new FormData();
  for (const name of ['page-1.png', 'page-2.png']) images.append('statement_file', new Blob([image], { type: 'image/png' }), name);
  images.append('country_code', 'AE'); images.append('entity_type', 'individual'); images.append('get_pdf', 'true');
  const acceptedResponse = await fetch(`${url}/service/bank_statement_analysis`, { method: 'POST', headers, body: images });
  assert.equal(acceptedResponse.status, 202);
  const accepted = await acceptedResponse.json();
  const mismatched = new FormData();
  mismatched.append('statement_file', new Blob([pdf], { type: 'image/png' }), 'wrong.png');
  mismatched.append('country_code', 'AE'); mismatched.append('entity_type', 'individual');
  const rejected = await fetch(`${url}/service/bank_statement_analysis`, { method: 'POST',
    headers: { ...headers, 'idempotency-key': 'bsa-images-key-002' }, body: mismatched });
  assert.equal(rejected.status, 415);
  assert.equal((await rejected.json()).reasonCode, 'MIME_SIGNATURE_MISMATCH');
  const jobDir = join(directory, 'jobs', accepted.analysisId);
  const job = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8'));
  await writeFile(join(jobDir, 'artifact.ledger.json.bin'), encryptBsa(Buffer.from('{"transactions":[]}')));
  await writeFile(join(jobDir, 'result.json'), JSON.stringify({ analysisId: accepted.analysisId, status: 'partial',
    artifacts: [{ filename: 'ledger.json', contentType: 'application/json' }] }));
  await writeFile(join(jobDir, 'job.json'), JSON.stringify({ ...job, status: 'partial' }));
  const artifactUrl = `${url}/service/bank_statement_analysis/${accepted.analysisId}/artifacts/ledger.json`;
  assert.equal((await fetch(artifactUrl)).status, 401);
  assert.equal((await fetch(artifactUrl, { headers: { authorization: `Bearer ${otherKey}` } })).status, 404);
  const downloaded = await fetch(artifactUrl, { headers });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'application/json');
  assert.deepEqual(await downloaded.json(), { transactions: [] });
  const privateWorkbook = Buffer.from('PK\x03\x04demo');
  await writeFile(join(jobDir, 'artifact.analysis.xlsx.bin'), encryptBsa(privateWorkbook));
  await writeFile(join(jobDir, 'result.json'), JSON.stringify({ analysisId: accepted.analysisId, status: 'partial',
    artifacts: [{ filename: 'analysis.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] }));
  const workbookUrl = `${url}/service/bank_statement_analysis/${accepted.analysisId}/artifacts/analysis.xlsx`;
  assert.equal((await fetch(workbookUrl)).status, 401);
  assert.equal((await fetch(workbookUrl, { headers: { authorization: `Bearer ${otherKey}` } })).status, 404);
  const workbookResponse = await fetch(workbookUrl, { headers });
  assert.equal(workbookResponse.status, 200);
  assert.equal(workbookResponse.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.deepEqual(Buffer.from(await workbookResponse.arrayBuffer()), privateWorkbook);
});
