// Isolated, read-only live QA. Keys stay in this process and only public
// response JSON/PDF plus a private cost ledger are written to the output dir.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { TableClient } from '@azure/data-tables';
import { BlobServiceClient } from '@azure/storage-blob';
import forge from 'node-forge';
import { EnvironmentStore, KeyVaultStore } from '../lib/api-store.mjs';
import { ContainerAppsManagedIdentityCredential } from '../lib/azure-managed-identity.mjs';
import { pageLocalGdeltMentions, searchLocalGdeltIndex } from '../lib/gdelt-local-index.mjs';
import { readV2State, v2Clients } from '../lib/gdelt-summary-v2.mjs';

const [manifestPath, outputDir] = process.argv.slice(2);
process.env.GDELT_V2_READ_ENABLED = 'true';
if (!manifestPath || !outputDir) throw new Error('usage: node scripts/run-adverse-media-incident-20-qa.mjs subjects.json output-dir');
if (!process.env.TYPESAFE_API_KEY || !process.env.MISTRAL_API_KEY)
  throw new Error('qa_model_keys_required');
const accountUrl = process.env.GDELT_STORAGE_ACCOUNT_URL || '';
if (!/^https:\/\/[^/]+\.blob\.core\.windows\.net\/?$/.test(accountUrl))
  throw new Error('qa_archive_account_required');
const cases = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(cases) || cases.length < 1 || cases.length > 20
  || new Set(cases.map((item) => item.id)).size !== cases.length
  || cases.some((item) => !item?.id || !item?.subject?.name))
  throw new Error('qa_manifest_invalid');
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const managedIdentityAvailable = Boolean(process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER);
if (process.env.QA_REQUIRE_MANAGED_IDENTITY === 'true' && !managedIdentityAvailable)
  throw new Error('qa_managed_identity_required');
const vault = process.env.QA_KEY_VAULT_NAME || 'kv-ai7uae-api-uaen-001';
const managedVault = managedIdentityAvailable
  ? new KeyVaultStore({ vaultUri: process.env.KEY_VAULT_URI
    || `https://${vault}.vault.azure.net`, managedIdentityClientId: process.env.RUNTIME_IDENTITY_CLIENT_ID })
  : null;
async function vaultSecret(name) {
  if (managedVault) return managedVault.getSecret(name);
  return execFileSync('az', ['keyvault', 'secret', 'show', '--vault-name', vault,
    '--name', name, '--query', 'value', '-o', 'tsv'],
  { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const braveKey = await vaultSecret('integration-adverse-media-master-key');
const articleKey = await vaultSecret('event-registry-trial-api-key');
if (!braveKey || !articleKey) throw new Error('qa_source_credentials_unavailable');

const tokens = new Map();
const localCredential = { async getToken(scopes) {
  const resource = String(Array.isArray(scopes) ? scopes[0] : scopes).replace(/\.default$/, '');
  const saved = tokens.get(resource);
  if (saved?.expiresOnTimestamp > Date.now() + 60_000) return saved;
  const raw = execFileSync('az', ['account', 'get-access-token', '--resource', resource,
    '--output', 'json'], { encoding: 'utf8', timeout: 30_000 });
  const result = JSON.parse(raw);
  const token = { token: result.accessToken,
    expiresOnTimestamp: Number(result.expires_on) * 1000 || Date.parse(result.expiresOn) };
  if (!token.token || !Number.isFinite(token.expiresOnTimestamp)) throw new Error('qa_azure_token_invalid');
  tokens.set(resource, token);
  return token;
} };
const credential = managedIdentityAvailable
  ? new ContainerAppsManagedIdentityCredential() : localCredential;
const blobContainer = new BlobServiceClient(accountUrl, credential)
  .getContainerClient(process.env.GDELT_ARCHIVE_CONTAINER || 'gdelt-archive');
const stateResponse = await blobContainer.getBlobClient('state/watermark.json').download();
const chunks = [];
for await (const chunk of stateResponse.readableStreamBody) chunks.push(Buffer.from(chunk));
const sourceState = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const clients = v2Clients(accountUrl, credential);
const v2State = (await readV2State(clients.container)).value;
process.stdout.write(JSON.stringify({ source_coverage: [sourceState.coverage_start, sourceState.coverage_end],
  v2_coverage: v2State ? [v2State.coverage_start, v2State.coverage_end, v2State.committed_intervals] : null }) + '\n');
const table = new TableClient(accountUrl.replace('.blob.', '.table.'),
  process.env.GDELT_INDEX_TABLE || 'GdeltEntityMentions', credential);

const keyPair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
const certificate = forge.pki.createCertificate();
certificate.publicKey = keyPair.publicKey;
certificate.serialNumber = '01';
certificate.validity.notBefore = new Date(Date.now() - 60_000);
certificate.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
const certificateName = [{ name: 'commonName', value: 'KYCProbe QA Test Signer' },
  { name: 'organizationName', value: 'AI7 Lab' }];
certificate.setSubject(certificateName);
certificate.setIssuer(certificateName);
certificate.sign(keyPair.privateKey, forge.md.sha256.create());
const p12 = forge.pkcs12.toPkcs12Asn1(keyPair.privateKey, certificate, 'qa-password',
  { algorithm: '3des' });
const signing = { p12Bytes: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'),
  passphrase: 'qa-password', name: 'KYCProbe QA Test Signer' };

process.env.NODE_ENV = 'test';
process.env.ADVERSE_MEDIA_JEV_API_ENABLED = 'true';
process.env.ADVERSE_MEDIA_JEV_SCREENING_TOKEN = randomBytes(32).toString('hex');
process.env.EVENT_REGISTRY_API_KEY = articleKey;
const { createAppServer } = await import('../server.mjs');
const store = new EnvironmentStore();
await store.setMasterKey('adverse-media', braveKey);
await store.setMasterKey('adverse-media-jev', process.env.TYPESAFE_API_KEY);
let trace = [];
let audit = null;
let archiveAccessDenied = false;
const fetchImpl = async (url, options) => {
  const address = String(url);
  const category = address.includes('api.search.brave.com') ? 'search'
    : address.includes('eventregistry.org') ? 'article_extraction'
      : address.includes('api.typesafe.ai') ? 'screening'
        : address.includes('api.mistral.ai') ? 'summary' : 'other';
  const started = performance.now();
  try {
    const response = await fetch(url, options);
    trace.push({ category, status: response.status, ms: Math.round(performance.now() - started),
      request_bytes: Buffer.byteLength(options?.body || '') });
    return response;
  } catch (error) {
    trace.push({ category, status: 0, ms: Math.round(performance.now() - started),
      request_bytes: Buffer.byteLength(options?.body || ''), error: error.name });
    throw error;
  }
};
const archiveSearch = async (input) => {
  const started = performance.now();
  try { const result = await searchLocalGdeltIndex(input, { state: sourceState,
    v2Clients: clients, v2State, requireV2: true });
    if (process.env.QA_DEBUG_SOURCE === 'true') process.stdout.write(JSON.stringify({
      archive_scan: result?.scan, archive_limit: result?.limitReason,
      archive_complete: result?.complete }) + '\n');
    return result; }
  catch (error) { if (process.env.QA_DEBUG_SOURCE === 'true') process.stdout.write(JSON.stringify({
    archive_error: error.message, status: error.statusCode || null }) + '\n');
    if (error.statusCode === 403 && process.env.QA_ALLOW_ARCHIVE_RBAC_FALLBACK === 'true') {
      archiveAccessDenied = true;
      return { complete: true, scan: { mode: 'v2_point_summary' },
        state: { coverage_start: sourceState.coverage_start, coverage_end: sourceState.coverage_end,
          qa_source_gap: true },
        results: [] };
    }
    throw error; }
  finally { trace.push({ category: 'archive_search', status: 200,
    ms: Math.round(performance.now() - started), request_bytes: 0 }); }
};
const archivePage = async (input, options) => {
  const started = performance.now();
  try { return archiveAccessDenied ? { rows: [], done: true, nextCursor: null }
    : await pageLocalGdeltMentions(input, { ...options, table }); }
  finally { trace.push({ category: 'archive_page', status: 200,
    ms: Math.round(performance.now() - started), request_bytes: 0 }); }
};
const server = createAppServer({ store, fetchImpl, jevArchiveSearch: archiveSearch,
  jevArchivePage: archivePage, incidentReportSigning: signing,
  onIncidentReportAudit: (value) => { audit = value; }, startWorker: false });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}${process.env.QA_DEBUG_SOURCE === 'true'
  ? '/internal/adverse-media-jev/integrated-test' : '/internal/adverse-media-advance/report-test'}`;
const records = [];
let modeledSpend = 0;
const maxModeledSpend = Number(process.env.QA_MAX_MODELED_USD || 5);
if (!Number.isFinite(maxModeledSpend) || maxModeledSpend <= 0)
  throw new Error('qa_cost_cap_invalid');
const ledgerPath = join(outputDir, 'private-run-ledger.json');
const previousRecords = existsSync(ledgerPath)
  ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : [];
const forceRerun = new Set(String(process.env.QA_RERUN_IDS || '').split(',').filter(Boolean));
try {
  for (const item of cases.slice(0, Number(process.env.QA_STOP_AFTER || cases.length))) {
    const previous = previousRecords.find((record) => record.id === item.id && record.status === 200);
    if (previous && !forceRerun.has(item.id)
      && existsSync(join(outputDir, `${item.id}.response.json`))
      && existsSync(join(outputDir, `${item.id}.pdf`))) {
      records.push(previous);
      modeledSpend += Number(previous.costs?.total_variable_model_upper_usd || 0);
      continue;
    }
    const knownGap = previousRecords.find((record) => record.id === item.id
      && record.status === 424 && record.private_error === 'event_registry_no_article_body');
    if (knownGap && process.env.QA_SKIP_KNOWN_EVIDENCE_GAPS === 'true'
      && !forceRerun.has(item.id)) {
      records.push(knownGap);
      modeledSpend += Number(knownGap.costs?.total_variable_model_upper_usd || 0);
      continue;
    }
    if (modeledSpend + 0.25 > maxModeledSpend + 0.000001) break;
    trace = [];
    audit = null;
    archiveAccessDenied = false;
    const started = performance.now();
    let status = 0;
    let error = '';
    let responseJson = null;
    try {
      const response = await fetch(endpoint, { method: 'POST',
        headers: { authorization: `Bearer ${process.env.ADVERSE_MEDIA_JEV_SCREENING_TOKEN}`,
          'content-type': 'application/json' },
        body: JSON.stringify(process.env.QA_SUBJECT_ONLY === 'true'
          ? { subject: item.subject }
          : { subject: item.subject, adverse_profile: 'all', countries: [],
            date_from: item.date_from || '2026-10-26', date_to: item.date_to || '2026-11-24',
            max_articles: 40, max_archive_postings: 500 }),
        signal: AbortSignal.timeout(300_000) });
      status = response.status;
      responseJson = await response.json();
      if (response.ok) {
        const pdf = Buffer.from(responseJson.report.pdf_base64, 'base64');
        if (createHash('sha256').update(pdf).digest('hex') !== responseJson.report.sha256)
          throw new Error('qa_pdf_hash_mismatch');
        const publicText = JSON.stringify({ ...responseJson, report: {
          ...responseJson.report, pdf_base64: undefined } });
        if (/\b(?:mistral|ministral|jev|gemini|brave|typesafe|event[ _-]?registry|internal[ _-]?tool)\b/i.test(publicText))
          throw new Error('qa_public_contract_leak');
        writeFileSync(join(outputDir, `${item.id}.response.json`),
          JSON.stringify(responseJson, null, 2), { mode: 0o600 });
        writeFileSync(join(outputDir, `${item.id}.pdf`), pdf, { mode: 0o600 });
      } else {
        error = responseJson.error || 'http_error';
        writeFileSync(join(outputDir, `${item.id}.error.json`),
          JSON.stringify(responseJson, null, 2), { mode: 0o600 });
      }
    } catch (cause) { error = cause.message; }
    const elapsed = Math.round(performance.now() - started);
    const counts = Object.fromEntries(['search', 'article_extraction', 'screening', 'summary']
      .map((category) => [category, trace.filter((entry) => entry.category === category).length]));
    const fallbackCost = counts.search * 0.005 + counts.article_extraction * 0.0009
      + trace.filter((entry) => entry.category === 'screening')
        .reduce((sum, entry) => sum + entry.request_bytes * 0.042 / 1_000_000, 0)
      + elapsed / 1_000 * 0.000015;
    const cost = audit?.costs?.total_variable_model_upper_usd ?? fallbackCost;
    modeledSpend += cost;
    const articles = responseJson?.event_register?.articles || [];
    const record = { id: item.id, subject: item.subject.name, status,
      error, private_error: audit?.error || '', elapsed_ms: elapsed, incident_count: responseJson?.event_register?.incidents?.length ?? 0,
      retained_count: articles.length, adverse_count: articles.filter((article) => article.adverseness === 'adverse').length,
      unassigned_count: articles.filter((article) => !article.incident_id).length,
      body_count: articles.filter((article) => article.evidence_grade === 'article_body').length,
      omitted_count: responseJson?.coverage?.omitted_due_to_test_limit ?? null,
      pages: responseJson?.report?.page_count ?? 0,
      pdf_sha256: responseJson?.report?.sha256 || '',
      archive_access_denied: archiveAccessDenied,
      calls: counts, costs: audit?.costs || { total_variable_model_upper_usd: Number(cost.toFixed(6)) },
      timings_ms: audit?.timings_ms || null, trace };
    records.push(record);
    process.stdout.write(JSON.stringify({ id: record.id, subject: record.subject,
      status, elapsed_ms: elapsed, articles: record.retained_count,
      incidents: record.incident_count, error, cost_model_usd: Number(cost.toFixed(6)) }) + '\n');
    writeFileSync(ledgerPath, JSON.stringify(records, null, 2),
      { mode: 0o600 });
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
process.stdout.write(JSON.stringify({ completed: records.length,
  modeled_spend_usd: Number(modeledSpend.toFixed(6)) }) + '\n');
