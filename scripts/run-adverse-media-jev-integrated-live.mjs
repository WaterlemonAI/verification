// Read-only, local QA against the isolated candidate's V2 archive and live
// providers. Credentials are supplied only in this process environment.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { TableClient } from '@azure/data-tables';
import { BlobServiceClient } from '@azure/storage-blob';
import { collectJevArchiveArticles } from '../lib/adverse-media-jev-archive-source.mjs';
import { runJevIntegratedTest, validateJevIntegratedRequest } from '../lib/adverse-media-jev-integrated.mjs';
import { pageLocalGdeltMentions, searchLocalGdeltIndex } from '../lib/gdelt-local-index.mjs';
import { readV2State, v2Clients } from '../lib/gdelt-summary-v2.mjs';

const [mode, requestPath, outputPath, archiveCapturePath] = process.argv.slice(2);
if (!['preflight', 'run'].includes(mode) || !requestPath || (mode === 'run' && !outputPath))
  throw new Error('usage: node scripts/run-adverse-media-jev-integrated-live.mjs preflight|run request.json [result.json]');
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const validated = validateJevIntegratedRequest(request);
const accountUrl = process.env.GDELT_STORAGE_ACCOUNT_URL || '';
if (!archiveCapturePath && !accountUrl.startsWith('https://'))
  throw new Error('gdelt_storage_url_unavailable');

const tokens = new Map();
const credential = { async getToken(scopes) {
  const resource = String(Array.isArray(scopes) ? scopes[0] : scopes).replace(/\.default$/, '');
  const saved = tokens.get(resource);
  if (saved?.expiresOnTimestamp > Date.now() + 60_000) return saved;
  const raw = execFileSync('az', ['account', 'get-access-token', '--resource', resource,
    '--output', 'json'], { encoding: 'utf8', timeout: 30_000 });
  const response = JSON.parse(raw);
  const token = { token: response.accessToken,
    expiresOnTimestamp: Number(response.expires_on) * 1000 || Date.parse(response.expiresOn) };
  if (!token.token || !Number.isFinite(token.expiresOnTimestamp))
    throw new Error('azure_cli_storage_token_invalid');
  tokens.set(resource, token);
  return token;
} };
let archiveSearch;
let archivePage;
if (archiveCapturePath) {
  const captured = JSON.parse(readFileSync(archiveCapturePath, 'utf8'));
  if (!captured.complete || captured.scan?.mode !== 'v2_point_summary'
    || !Array.isArray(captured.rows)) throw new Error('invalid_archive_capture');
  archiveSearch = async () => captured;
  archivePage = async (_input, { cursor, pageSize }) => {
    const start = cursor?.offset || 0;
    const next = Math.min(captured.rows.length, start + pageSize);
    return { rows: captured.rows.slice(start, next),
      nextCursor: { offset: next }, done: next >= captured.rows.length };
  };
} else {
  const blobContainer = new BlobServiceClient(accountUrl, credential)
    .getContainerClient(process.env.GDELT_ARCHIVE_CONTAINER || 'gdelt-archive');
  const sourceResponse = await blobContainer.getBlobClient('state/watermark.json').download();
  const sourceChunks = [];
  for await (const chunk of sourceResponse.readableStreamBody) sourceChunks.push(Buffer.from(chunk));
  const sourceState = JSON.parse(Buffer.concat(sourceChunks).toString('utf8'));
  const clients = v2Clients(accountUrl, credential);
  const v2State = (await readV2State(clients.container)).value;
  const tableUrl = accountUrl.replace('.blob.', '.table.');
  const table = new TableClient(tableUrl, process.env.GDELT_INDEX_TABLE || 'GdeltEntityMentions', credential);
  archiveSearch = (input) => searchLocalGdeltIndex(input, {
    state: sourceState, v2Clients: clients, v2State, requireV2: true });
  archivePage = (input, options) => pageLocalGdeltMentions(input, { ...options, table });
}

if (mode === 'preflight') {
  try {
    const probe = await archiveSearch({ name: validated.subject.name,
      aliases: validated.subject.aliases, entity_type: validated.subject.entity_type,
      archive_all_stored: true, date_to: validated.date_to });
    process.stderr.write(JSON.stringify({ archive_lookup_complete: probe?.complete,
      mode: probe?.scan?.mode, limit_reason: probe?.limitReason || null }) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ archive_lookup_error: error.name,
      status_code: error.statusCode || null, code: error.code || null }) + '\n');
    throw new Error('archive_lookup_failed');
  }
  const result = await collectJevArchiveArticles(validated, { eventRegistryApiKey: '',
    archiveSearch, archivePage, fetchImpl: () => { throw new Error('preflight_must_not_call_provider'); } });
  process.stdout.write(JSON.stringify({ subject: validated.subject.name,
    period: { from: validated.date_from, to: validated.date_to },
    archive: result.coverage }) + '\n');
} else {
  const result = await runJevIntegratedTest(request, {
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY,
    eventRegistryApiKey: process.env.EVENT_REGISTRY_API_KEY,
    jevApiKey: process.env.TYPESAFE_API_KEY,
    archiveSearch, archivePage });
  writeFileSync(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ subject: validated.subject.name, output: outputPath,
    coverage: result.coverage, usage: result.usage,
    retained: result.event_register.articles.length,
    redundant: result.redundant.length,
    incidents: result.event_register.incidents.length }) + '\n');
}
