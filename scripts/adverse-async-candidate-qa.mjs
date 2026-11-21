// One controlled, unbilled candidate screening through HTTP, the real worker,
// V1 article review, retained JSON/PDF and an explicitly supplied HTTPS callback.
// This in-process queue proves worker behavior; Azure Queue durability is a separate gate.
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
const token = randomBytes(32).toString('hex');
process.env.AI7_API_KEY_HASHES = createHash('sha256').update(token).digest('hex');
process.env.API_HOSTS = 'localhost,127.0.0.1';
// The default candidate run is small. An explicit override can exercise the
// runtime's 200-posting default; every external request remains reserved under
// the route-specific provider ceiling.
const qaMaxPostings = Number(process.env.ADVERSE_QA_MAX_POSTINGS || '20');
if (!Number.isInteger(qaMaxPostings) || qaMaxPostings < 1 || qaMaxPostings > 200) {
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
  aliases: [], transliterations: {}, associations: [], archive_all_stored: true });
if (!preflight?.complete || preflight.scan?.mode !== 'v2_point_summary') {
  throw new Error('candidate_v2_snapshot_unavailable');
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
  formsQueue: null, floStore: null, caseStore: null, reportStore, jsonStore, usageStore });
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;
const started = performance.now();
let status = 'error';
try {
  const response = await fetch(`${base}/service/${route}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(route === 'adverse_media_advance'
        ? { 'idempotency-key': `candidate-advance-${randomBytes(8).toString('hex')}` } : {}) },
    body: JSON.stringify({ entity_type: entityType, name: subject, languages: ['en'], max_results: 15,
      ...(route === 'adverse_media_advance'
        ? { policy_selection: 'all' } : { deep_research: true, archive_review: true }),
      callback_url: process.env.ADVERSE_QA_CALLBACK_URL }) });
  const receipt = await response.json();
  if (response.status !== 202) throw new Error(`candidate_submission_http_${response.status}:${receipt.error || 'unknown'}`);
  const ownerId = route === 'adverse_media_advance' ? `workspace-${client.id}` : reportOwnerId(token);
  const deadline = Date.now() + 10 * 60_000;
  let state;
  while (Date.now() < deadline) {
    state = await reportStore.getDeepResearchState({ ownerId, screeningId: receipt.screening_id });
    if (state?.stage === 'delivered') break;
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
      if (evidenceItems.length > 200) throw new Error('candidate_evidence_limit');
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
    if (report?.bytes) await writeFile(join(directory, `${receipt.screening_id}.pdf`), report.bytes, { mode: 0o600 });
  }
  const expectedEvidence = final?.coverage?.archive_review?.unique_articles;
  status = state?.stage === 'delivered' && final && pdfHash === final.report?.sha256
    && (expectedEvidence === undefined || evidenceItems.length === expectedEvidence)
    ? 'verified' : 'incomplete';
  process.stdout.write(`${JSON.stringify({ event: 'adverse_async_candidate_qa', status,
    route, subject_sha256: createHash('sha256').update(subject).digest('hex'),
    screening_id: receipt.screening_id, worker_stage: state?.stage || null,
    profile: final?.summary?.profile_status || null,
    policy_outcome: final?.advance_assessment?.policy_outcome?.status || null,
    decision_eligible: final?.summary?.decision_eligible ?? null,
    coverage_complete: final?.coverage?.complete ?? null,
    archive_review: final?.coverage?.archive_review ? {
      status: final.coverage.archive_review.status,
      reason: final.coverage.archive_review.reason || null,
      expected_postings: final.coverage.archive_review.expected_postings || 0,
      postings_scanned: final.coverage.archive_review.postings_scanned || 0,
      unique_articles: final.coverage.archive_review.unique_articles || 0,
      adverse: final.coverage.archive_review.adverse || 0,
      unresolved: final.coverage.archive_review.unresolved || 0
    } : null,
    evidence_items: evidenceItems.length,
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
