// Controlled, internal-only QA runner. It exercises the same HTTP handler,
// live provider credentials, Azure archive read path, JSON and PDF renderer
// without charging a customer workspace or exposing a public endpoint.
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

if (!process.argv.includes('--isolated-candidate') || process.env.FLO_ENABLED !== 'false'
  || process.env.CASE_MANAGER_ENABLED !== 'false' || !process.env.KEY_VAULT_URI
  || !process.env.GDELT_STORAGE_ACCOUNT_URL) {
  throw new Error('isolated_candidate_environment_required');
}

const token = randomBytes(32).toString('hex');
process.env.AI7_API_KEY_HASHES = createHash('sha256').update(token).digest('hex');
process.env.API_HOSTS = 'localhost,127.0.0.1';
const [{ createStore, EnvironmentStore }, { createAppServer },
  { MemoryAdverseMediaReportStore }, { MemoryAdverseMediaJsonStore },
  { MemoryCustomerUsageStore, validateUsagePolicy }] = await Promise.all([
  import('../lib/api-store.mjs'), import('../server.mjs'),
  import('../lib/adverse-media-report-store.mjs'), import('../lib/adverse-media-json-store.mjs'),
  import('../lib/customer-usage.mjs')
]);
const vault = createStore();
const brave = await vault.getMasterKey('adverse-media');
const gemini = await vault.getMasterKey('adverse-media-ai');
if (!brave || !gemini) throw new Error('adverse_provider_credentials_unavailable');
const store = new EnvironmentStore();
await store.setMasterKey('adverse-media', brave);
await store.setMasterKey('adverse-media-ai', gemini);
const usageStore = new MemoryCustomerUsageStore();
const client = await store.getClientForKey(token);
await usageStore.configure(client.id, validateUsagePolicy({ mode: 'postpay', currency: 'USD',
  allowed_modules: ['adverse-media', 'adverse-media-search-plus'], rates: {
    'adverse-media': [{ up_to: null, price: '0.20' }],
    'adverse-media-search-plus': [{ up_to: null, price: '0.20' }]
  } }, new Set(['adverse-media', 'adverse-media-search-plus'])));

const cohort = [
  { subject: 'DP World', route: 'adverse_media', date_from: '2026-11-16', date_to: '2026-11-18' },
  { subject: 'DP World', route: 'adverse_media_search_plus', date_from: '2026-11-16', date_to: '2026-11-18' },
  { subject: 'Emirates NBD', route: 'adverse_media_search_plus', date_from: '2026-11-16', date_to: '2026-11-18' },
  { subject: 'Etihad Airways', route: 'adverse_media', date_from: '2026-11-16', date_to: '2026-11-18' },
  { subject: 'Emaar Properties', route: 'adverse_media', date_from: '2026-11-16', date_to: '2026-11-18' },
  { subject: 'Microsoft', route: 'adverse_media' },
  { subject: 'Donald Trump', route: 'adverse_media', entity_type: 'individual' },
  { subject: 'DP World', route: 'adverse_media', date_from: '2026-10-21', date_to: '2026-10-23' },
  { subject: 'Masdar', route: 'adverse_media', date_from: '2026-11-16', date_to: '2026-11-18' }
];

const selected = process.env.ADVERSE_QA_CASES
  ? cohort.filter((_, index) => process.env.ADVERSE_QA_CASES.split(',').includes(String(index + 1))) : cohort;
if (!selected.length) throw new Error('no_qa_cases_selected');
const app = createAppServer({ store, startWorker: false,
  reportStore: new MemoryAdverseMediaReportStore(), jsonStore: new MemoryAdverseMediaJsonStore(),
  usageStore });
await new Promise((resolve, reject) => app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
const base = `http://127.0.0.1:${app.address().port}`;
try {
  for (const [position, item] of selected.entries()) {
    const startedAt = new Date().toISOString();
    const begin = performance.now();
    try {
      const response = await fetch(`${base}/service/${item.route}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ entity_type: item.entity_type || 'business', name: item.subject,
          ...(item.date_from ? { date_from: item.date_from, date_to: item.date_to } : {}),
          languages: ['en'], max_results: 15 })
      });
      const body = await response.json();
      let pdf = null;
      if (body.report?.download_url) {
        const report = await fetch(new URL(body.report.download_url, base));
        if (report.ok) {
          const bytes = Buffer.from(await report.arrayBuffer());
          pdf = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
            valid_header: bytes.subarray(0, 5).toString() === '%PDF-' };
        } else pdf = { http_status: report.status };
      }
      process.stdout.write(`${JSON.stringify({ event: 'adverse_live_qa_case', case_number: cohort.indexOf(item) + 1,
        sequence: position + 1, started_at: startedAt, subject: item.subject, route: item.route,
        date_from: item.date_from || null, date_to: item.date_to || null,
        http_status: response.status, screening_status: body.status || null,
        response_error: response.ok ? null : body.error || null,
        profile: body.summary?.profile_status || null, decision_eligible: body.summary?.decision_eligible || false,
        profile_reason: body.summary?.profile_reason || null,
        processing_reasons: body.summary?.processing_reason_codes || [],
        unresolved_results: body.summary?.unresolved_results || 0,
        bucket_counts: body.summary?.media_bucket_counts || null,
        coverage_complete: body.coverage?.complete || false,
        coverage_reasons: body.coverage?.reason_codes || [],
        source_status: body.coverage?.sources || [],
        archive_origin: body.coverage?.archive_origin || null, archive_reason: body.coverage?.archive_reason_code || null,
        archive_scan: body.coverage?.archive_scan || null,
        archive_public_windows: body.coverage?.archive_public_windows || [],
        search_plus_publishers_completed: body.coverage?.search_plus?.publisher_batches_completed || 0,
        result_count: body.results?.length || 0,
        adverse_count: body.summary?.confirmed_distinct_adverse_articles || 0,
        findings: (body.results || []).slice(0, 5).map((result) => ({ title: result.title, url: result.url,
          subject_role: result.subject_role, media_bucket: result.media_bucket })),
        pdf, elapsed_ms: Math.round(performance.now() - begin),
        response_sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ event: 'adverse_live_qa_case', case_number: cohort.indexOf(item) + 1,
        sequence: position + 1, subject: item.subject, route: item.route, error: error.message,
        elapsed_ms: Math.round(performance.now() - begin) })}\n`);
    }
  }
} finally {
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
}
// The imported server also owns idle provider transports and timers. This is
// a one-shot isolated QA command, so terminate after all cases and PDFs finish.
await new Promise((resolve) => process.stdout.write('', resolve));
process.exit(0);
