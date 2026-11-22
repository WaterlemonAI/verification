// One controlled, unbilled candidate screening through HTTP, the real worker,
// V1 article review, retained JSON/PDF and an explicitly supplied HTTPS callback.
// This in-process queue proves worker behavior; Azure Queue durability is a separate gate.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ADVANCE_PLAN_VERSION } from '../lib/adverse-media-advance-plan.mjs';
import { ADVANCE_TITLE_URL_FILTER_VERSION } from '../lib/gdelt-archive-candidate.mjs';

if (!process.argv.includes('--isolated-candidate') || !process.argv.includes('--async-trial')
  || process.env.NODE_ENV === 'production' || process.env.FLO_ENABLED !== 'false'
  || process.env.CASE_MANAGER_ENABLED !== 'false'
  || process.env.ADVERSE_MEDIA_WORKER_ENABLED === 'false'
  || process.env.GDELT_V2_READ_ENABLED !== 'true'
  || process.env.GDELT_ARCHIVE_REVIEW_ENABLED !== 'true'
  || !process.env.GDELT_STORAGE_ACCOUNT_URL || !process.env.KEY_VAULT_URI
  || !process.env.EVENT_REGISTRY_API_KEY || !process.env.ADVERSE_QA_CALLBACK_URL
  || !process.env.ADVERSE_QA_SUBJECT) {
  throw new Error('isolated_async_trial_configuration_required');
}
if (!['adverse_media', 'adverse_media_search_plus', 'adverse_media_advance'].includes(process.env.ADVERSE_QA_ROUTE || 'adverse_media')) {
  throw new Error('invalid_qa_route');
}
const subject = process.env.ADVERSE_QA_SUBJECT.trim();
if (subject.length < 3 || subject.length > 160) throw new Error('invalid_qa_subject');
const route = process.env.ADVERSE_QA_ROUTE || 'adverse_media';
if (route === 'adverse_media_advance') process.env.ADVERSE_MEDIA_ADVANCE_ENABLED = 'true';
const entityType = process.env.ADVERSE_QA_ENTITY_TYPE === 'individual' ? 'individual' : 'business';
const qaIdentifiers = process.env.ADVERSE_QA_IDENTIFIERS_JSON
  ? JSON.parse(process.env.ADVERSE_QA_IDENTIFIERS_JSON) : undefined;
if (qaIdentifiers !== undefined && (route !== 'adverse_media_advance'
  || !qaIdentifiers || typeof qaIdentifiers !== 'object' || Array.isArray(qaIdentifiers)
  || Buffer.byteLength(process.env.ADVERSE_QA_IDENTIFIERS_JSON) > 4096)) {
  throw new Error('invalid_qa_identifiers');
}
const token = randomBytes(32).toString('hex');
process.env.AI7_API_KEY_HASHES = createHash('sha256').update(token).digest('hex');
process.env.API_HOSTS = 'localhost,127.0.0.1';
// The default candidate run is small. An explicit Advance override may cover
// a larger pinned snapshot; refuse it before provider calls if the snapshot
// exceeds that bound. The route-specific provider ceiling remains in force.
const qaMaxPostings = Number(process.env.ADVERSE_QA_MAX_POSTINGS || '20');
const qaPostingCeiling = route === 'adverse_media_advance' ? 100_000 : 200;
if (!Number.isInteger(qaMaxPostings) || qaMaxPostings < 1 || qaMaxPostings > qaPostingCeiling) {
  throw new Error('invalid_qa_max_postings');
}
process.env.GDELT_ARCHIVE_REVIEW_MAX_POSTINGS = String(qaMaxPostings);

const [{ createStore, EnvironmentStore }, { createAppServer },
  { MemoryAdverseMediaReportStore, reportOwnerId }, { MemoryAdverseMediaJsonStore },
  { MemoryCustomerUsageStore, validateUsagePolicy }, { searchLocalGdeltIndex }] = await Promise.all([
  import('../lib/api-store.mjs'), import('../server.mjs'),
  import('../lib/adverse-media-report-store.mjs'), import('../lib/adverse-media-json-store.mjs'),
  import('../lib/customer-usage.mjs'), import('../lib/gdelt-local-index.mjs')
]);
const preflight = await searchLocalGdeltIndex({ entity_type: entityType, name: subject,
  aliases: [], transliterations: {}, associations: [], archive_all_stored: true }, { requireV2: true });
if (!preflight?.complete || preflight.scan?.mode !== 'v2_point_summary') {
  throw new Error('candidate_v2_snapshot_unavailable');
}
if (route === 'adverse_media_advance'
  && preflight.scan.mentions_indexed > qaMaxPostings) {
  throw new Error('candidate_archive_posting_limit_exceeded');
}
const vault = createStore();
const brave = await vault.getMasterKey('adverse-media');
const gemini = await vault.getMasterKey('adverse-media-ai');
if (!brave || !gemini) throw new Error('adverse_provider_credentials_unavailable');
const store = new EnvironmentStore();
await store.setMasterKey('adverse-media', brave);
await store.setMasterKey('adverse-media-ai', gemini);
const reportStore = new MemoryAdverseMediaReportStore();
const jsonStore = new MemoryAdverseMediaJsonStore();
const usageStore = new MemoryCustomerUsageStore();
const providerExchange = [];
const secretKey = /^(?:key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|.*[_-]secret|secret|authorization|password|credential)$/i;
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, secretKey.test(key) ? '[redacted]' : redact(entry)]));
  return value;
}
function parseExchangeBody(value) {
  if (value == null) return null;
  const body = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  try { return redact(JSON.parse(body)); } catch { return body; }
}
async function recordingFetch(input, init = {}) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const startedAt = performance.now();
  const query = Object.fromEntries([...url.searchParams].map(([key, value]) =>
    [key, secretKey.test(key) ? '[redacted]' : value]));
  const exchange = { method: init.method || (input instanceof Request ? input.method : 'GET'),
    host: url.hostname, path: url.pathname, query,
    request_body: parseExchangeBody(init.body) };
  try {
    const response = await fetch(input, init);
    const body = await response.clone().text();
    providerExchange.push({ ...exchange, status: response.status,
      elapsed_ms: Math.round(performance.now() - startedAt), response_body: parseExchangeBody(body) });
    return response;
  } catch (error) {
    providerExchange.push({ ...exchange, elapsed_ms: Math.round(performance.now() - startedAt),
      error: error?.message || 'provider_request_failed' });
    throw error;
  }
}
const client = await store.getClientForKey(token);
await usageStore.configure(client.id, validateUsagePolicy({ mode: 'postpay', currency: 'USD',
  allowed_modules: ['adverse-media', 'adverse-media-search-plus', 'adverse-media-advance'], rates: {
    'adverse-media': [{ up_to: null, price: '0.20' }],
    'adverse-media-search-plus': [{ up_to: null, price: '0.20' }],
    'adverse-media-advance': [{ up_to: null, price: '0.75' }]
  } }, new Set(['adverse-media', 'adverse-media-search-plus', 'adverse-media-advance'])));

let pending = null;
let availableAt = 0;
const queue = {
  async enqueue(job) { pending = job; availableAt = Date.now(); },
  async receive() {
    if (!pending || Date.now() < availableAt) return null;
    availableAt = Infinity;
    return { messageId: pending.screening_id, popReceipt: 'candidate-receipt',
      messageText: JSON.stringify(pending) };
  },
  async release(_message, job, seconds = 0) {
    pending = job;
    availableAt = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
  },
  async complete() { pending = null; },
  async deadLetter() { pending = null; }
};

const app = createAppServer({ store, startWorker: true, deepResearchQueue: queue,
  formsQueue: null, floStore: null, caseStore: null, reportStore, jsonStore, usageStore,
  fetchImpl: recordingFetch });
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;
const started = performance.now();
let status = 'error';
async function verifyCallbackReceipt(receipt) {
  const secret = receipt.callback?.signing_secret;
  const callback = new URL(process.env.ADVERSE_QA_CALLBACK_URL);
  const match = callback.hostname === 'webhook.site'
    ? callback.pathname.match(/^\/([0-9a-f-]{36})$/i) : null;
  if (!match || typeof secret !== 'string' || !secret) return false;
  const endpoint = `https://webhook.site/token/${match[1]}/requests?sorting=newest&per_page=100`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await fetch(endpoint, { signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/json' } });
      if (result.ok) {
        const page = await result.json();
        const request = page.data?.find((item) => item.headers?.['x-ai7-screening-id']?.[0]
          === receipt.screening_id);
        if (request) {
          const supplied = request.headers?.['x-ai7-signature']?.[0];
          const expected = `sha256=${createHmac('sha256', secret).update(request.content || '').digest('hex')}`;
          return request.method === 'POST'
            && request.headers?.['x-ai7-event']?.[0] === 'adverse_media.advance.completed'
            && typeof supplied === 'string' && supplied.length === expected.length
            && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
        }
      }
    } catch { /* The receiver may need a moment to index the delivered request. */ }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}
try {
  const idempotencyKey = route === 'adverse_media_advance'
    ? `candidate-advance-${randomBytes(8).toString('hex')}` : null;
  const inputPayload = { entity_type: entityType, name: subject,
    languages: ['en'], max_results: 15,
    ...(route === 'adverse_media_advance'
      ? { countries: [], policy_selection: 'all', ...(qaIdentifiers ? { identifiers: qaIdentifiers } : {}) }
      : { deep_research: true, archive_review: true }),
    callback_url: process.env.ADVERSE_QA_CALLBACK_URL };
  const response = await fetch(`${base}/service/${route}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    body: JSON.stringify(inputPayload) });
  const receipt = await response.json();
  if (response.status !== 202) throw new Error(`candidate_submission_http_${response.status}:${receipt.error || 'unknown'}`);
  const ownerId = route === 'adverse_media_advance' ? `workspace-${client.id}` : reportOwnerId(token);
  const deadline = Date.now() + 10 * 60_000;
  let finalizedAt = null;
  let state;
  let budgetBlock = null;
  let lastProgressPoll = 0;
  while (Date.now() < deadline) {
    state = await reportStore.getDeepResearchState({ ownerId, screeningId: receipt.screening_id });
    if (state?.stage === 'delivered') break;
    if (route === 'adverse_media_advance' && Date.now() - lastProgressPoll >= 2_000) {
      lastProgressPoll = Date.now();
      const progress = await fetch(`${base}/service/adverse_media_advance/jobs/${receipt.screening_id}`,
        { headers: { authorization: `Bearer ${token}` } });
      if (progress.ok) {
        const body = await progress.json();
        if (body.status === 'budget_blocked') { budgetBlock = body; break; }
      }
    }
    if (['finalized', 'callback'].includes(state?.stage)) finalizedAt ||= Date.now();
    if (process.env.ADVERSE_QA_ALLOW_CALLBACK_PENDING === 'true'
      && finalizedAt && Date.now() - finalizedAt >= 20_000) break;
    if (!pending && state?.stage !== 'finalized') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const retained = await jsonStore.get({ ownerId, screeningId: receipt.screening_id });
  const final = retained?.response;
  const report = final?.report?.report_id
    ? await reportStore.get({ ownerId, reportId: final.report.report_id }) : null;
  const usage = await reportStore.getDeepResearchUsage({ ownerId, screeningId: receipt.screening_id });
  const evidenceItems = [];
  if (final?.coverage?.archive_review?.review_id) {
    let cursor = null;
    do {
      const page = await reportStore.listArchiveReviewItems({ ownerId,
        reviewId: final.coverage.archive_review.review_id, cursor, pageSize: 100 });
      evidenceItems.push(...page.items);
      if (evidenceItems.length > qaPostingCeiling) throw new Error('candidate_evidence_limit');
      cursor = page.nextCursor;
    } while (cursor);
  }
  const pdfHash = report?.bytes ? createHash('sha256').update(report.bytes).digest('hex') : null;
  if (route === 'adverse_media_advance' && final) {
    const lookup = await fetch(`${base}/service/adverse_media_advance/jobs/${receipt.screening_id}`,
      { headers: { authorization: `Bearer ${token}` } });
    const lookupBody = await lookup.json();
    if (lookup.status !== 200 || lookupBody.result?.screening_id !== receipt.screening_id) {
      throw new Error('candidate_advance_result_lookup_failed');
    }
  }
  if (process.env.ADVERSE_QA_ARTIFACT_DIR && final) {
    const directory = process.env.ADVERSE_QA_ARTIFACT_DIR;
    if (directory !== '/tmp/adverse-qa-artifacts') throw new Error('invalid_qa_artifact_directory');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${receipt.screening_id}.json`), `${JSON.stringify(final, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(directory, `${receipt.screening_id}.request.json`),
      `${JSON.stringify({ method: 'POST', path: `/service/${route}`, idempotency_key: idempotencyKey,
        payload: inputPayload, source_sha: process.env.ADVERSE_QA_SOURCE_SHA || null,
        image_digest: process.env.ADVERSE_QA_IMAGE_DIGEST || null,
        algorithm_versions: { query_plan: ADVANCE_PLAN_VERSION,
          title_url_filter: ADVANCE_TITLE_URL_FILTER_VERSION } }, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(directory, `${receipt.screening_id}.cost.json`),
      `${JSON.stringify({ provider_calls: usage.providerCalls,
        reserved_provider_usd: usage.reservedMicroUsd / 1_000_000,
        result_usage: final.usage || null }, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(directory, `${receipt.screening_id}.provider-exchanges.json`),
      `${JSON.stringify({ screening_id: receipt.screening_id,
        note: 'Credential fields redacted; Azure SDK calls and signed callback transport are logged separately.',
        exchanges: providerExchange }, null, 2)}\n`, { mode: 0o600 });
    if (report?.bytes) await writeFile(join(directory, `${receipt.screening_id}.pdf`), report.bytes, { mode: 0o600 });
    if (process.env.ADVERSE_QA_EXPORT_EVIDENCE === 'true') {
      await writeFile(join(directory, `${receipt.screening_id}.evidence.json`),
        `${JSON.stringify({ screening_id: receipt.screening_id, subject,
          archive_review: final.coverage?.archive_review || null, items: evidenceItems }, null, 2)}\n`,
        { mode: 0o600 });
    }
  }
  const expectedEvidence = route === 'adverse_media_advance'
    ? final?.coverage?.archive_review?.postings_recorded
    : final?.coverage?.archive_review?.unique_articles;
  const callbackSignatureVerified = process.env.ADVERSE_QA_VERIFY_CALLBACK === 'true'
    ? state?.stage === 'delivered' && await verifyCallbackReceipt(receipt) : null;
  const screeningVerified = Boolean(final && pdfHash === final.report?.sha256
    && (expectedEvidence === undefined || evidenceItems.length === expectedEvidence));
  status = budgetBlock ? 'budget_blocked' : screeningVerified && state?.stage === 'delivered'
    && (process.env.ADVERSE_QA_VERIFY_CALLBACK !== 'true' || callbackSignatureVerified)
    ? 'verified' : screeningVerified ? 'screening_verified_callback_pending' : 'incomplete';
  process.stdout.write(`${JSON.stringify({ event: 'adverse_async_candidate_qa', status,
    route, subject_sha256: createHash('sha256').update(subject).digest('hex'),
    screening_id: receipt.screening_id, worker_stage: state?.stage || null,
    profile: final?.summary?.profile_status || null,
    policy_outcome: final?.advance_assessment?.policy_outcome?.status || null,
    decision_eligible: final?.summary?.decision_eligible ?? null,
    budget_pending_count: budgetBlock?.pending_count ?? null,
    coverage_complete: final?.coverage?.complete ?? null,
    archive_review: final?.coverage?.archive_review ? {
      status: final.coverage.archive_review.status,
      reason: final.coverage.archive_review.reason || null,
      expected_postings: final.coverage.archive_review.expected_postings || 0,
      postings_scanned: final.coverage.archive_review.postings_scanned || 0,
      postings_recorded: final.coverage.archive_review.postings_recorded || 0,
      unique_articles: final.coverage.archive_review.unique_articles || 0,
      deferred: final.coverage.archive_review.deferred || 0,
      adverse: final.coverage.archive_review.adverse || 0,
      unresolved: final.coverage.archive_review.unresolved || 0
    } : null,
    evidence_items: evidenceItems.length,
    evidence_retained: process.env.ADVERSE_QA_EXPORT_EVIDENCE === 'true'
      && Boolean(process.env.ADVERSE_QA_ARTIFACT_DIR && final),
    callback_signature_verified: callbackSignatureVerified,
    callback_delivery_stage: state?.stage || null,
    artifacts_retained: Boolean(process.env.ADVERSE_QA_ARTIFACT_DIR && final),
    json_sha256: final ? createHash('sha256').update(JSON.stringify(final)).digest('hex') : null,
    pdf_sha256: pdfHash, provider_calls: usage.providerCalls,
    reserved_provider_usd: usage.reservedMicroUsd / 1_000_000,
    elapsed_ms: Math.round(performance.now() - started) })}\n`);
} finally {
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
}
if (status !== 'verified') process.exitCode = 1;
// The worker poller is intentionally process-scoped for this one-shot command.
await new Promise((resolve) => process.stdout.write('', resolve));
process.exit(process.exitCode || 0);
