import { createHash } from 'node:crypto';
import { TableClient, odata } from '@azure/data-tables';
import { BlobServiceClient } from '@azure/storage-blob';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';
import { searchV2Summary } from './gdelt-summary-v2.mjs';
import { readV2State, v2Clients } from './gdelt-summary-v2.mjs';

const TABLE_NAME = process.env.GDELT_INDEX_TABLE || 'GdeltEntityMentions';
const CONTAINER_NAME = process.env.GDELT_ARCHIVE_CONTAINER || 'gdelt-archive';
const STATE_BLOB = 'state/watermark.json';
const STATE_CACHE_MS = 5 * 60 * 1_000;
// A high-volume name must fail closed rather than exhaust the API replica.
const MAX_ROWS_PER_SEARCH = 100_000;
const MAX_SCAN_MS = 15_000;

let clients;
let cachedState;

function normalizeEntityName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function hashName(value) {
  return createHash('sha256').update(value).digest('hex');
}

function storageClients() {
  const accountUrl = process.env.GDELT_STORAGE_ACCOUNT_URL;
  if (!accountUrl) return null;
  if (!clients) {
    const credential = new ContainerAppsManagedIdentityCredential();
    const account = new URL(accountUrl);
    const tableUrl = `${account.protocol}//${account.hostname.replace('.blob.', '.table.')}`;
    clients = {
      table: new TableClient(tableUrl, TABLE_NAME, credential),
      container: new BlobServiceClient(accountUrl, credential).getContainerClient(CONTAINER_NAME)
    };
  }
  return clients;
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function archiveState({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cachedState?.expiresAt > now) return cachedState.value;
  const configured = storageClients();
  if (!configured) return null;
  try {
    const response = await configured.container.getBlobClient(STATE_BLOB).download();
    const value = JSON.parse((await readStream(response.readableStreamBody)).toString('utf8'));
    cachedState = { value, expiresAt: now + STATE_CACHE_MS };
    return value;
  } catch (error) {
    console.warn('gdelt_archive_watermark_read_failed', JSON.stringify({
      status: Number.isInteger(error?.statusCode) ? error.statusCode : null
    }));
    cachedState = { value: null, expiresAt: now + 30_000 };
    return null;
  }
}

// A completed screening cache must be invalidated when daily ingestion or
// weekend backfill changes the indexed source window. V2 can advance before
// the V1 daily watermark is saved, so compare both pointers when V2 is on.
export async function archiveCacheSignature() {
  if (!process.env.GDELT_STORAGE_ACCOUNT_URL) return 'no_archive_configured';
  const source = await archiveState({ fresh: true });
  if (!source?.coverage_start || !source?.coverage_end) return null;
  let v2 = null;
  if (process.env.GDELT_V2_READ_ENABLED === 'true') {
    try { v2 = (await readV2State(v2Clients().container)).value; }
    catch { return null; }
    if (!v2?.coverage_start || !v2?.coverage_end) return null;
  }
  return JSON.stringify([source.coverage_start, source.coverage_end,
    v2?.coverage_start || null, v2?.coverage_end || null]);
}

function requestedWindow(request, currentTime = Date.now(), state = null) {
  const end = request.date_to ? new Date(`${request.date_to}T23:59:59.999Z`) : new Date(currentTime);
  const start = request.archive_all_stored && state?.coverage_start
    ? new Date(state.coverage_start)
    : request.date_from
    ? new Date(`${request.date_from}T00:00:00.000Z`)
    : new Date(end.getTime() - 365 * 24 * 60 * 60 * 1_000);
  return { start, end };
}

function rowTimestamp(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// The asynchronous evidence review uses the complete V1 postings. Unlike the
// HTTP search path, it resumes one bounded Azure Table page at a time.
export async function pageLocalGdeltMentions(request, { state, cursor = null, pageSize = 250,
  table = storageClients()?.table } = {}) {
  if (!table || !state?.coverage_start || !state?.coverage_end) throw new Error('gdelt_archive_unavailable');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('invalid_gdelt_page_size');
  const names = [...new Set([request.name, ...(request.aliases || []),
    ...Object.values(request.transliterations || {}).flat(),
    ...(request.associations || []).map(({ value }) => value)]
    .map(normalizeEntityName).filter((name) => name.length >= 2))];
  if (!names.length || names.length > 12) throw new Error('gdelt_name_limit_exceeded');
  const start = new Date(state.coverage_start);
  const end = new Date(new Date(state.coverage_end).getTime() + 15 * 60_000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new Error('invalid_gdelt_snapshot');
  }
  const kinds = request.entity_type === 'individual' ? ['person', 'organization'] : ['organization', 'person'];
  let index = cursor?.index || 0;
  while (index < names.length * kinds.length) {
    const name = names[Math.floor(index / kinds.length)];
    const kind = kinds[index % kinds.length];
    const entityHash = hashName(name);
    const partitionKey = `${kind[0]}-${entityHash[0]}`;
    const rowStart = `${entityHash}_${rowTimestamp(start)}`;
    const rowEnd = `${entityHash}_${rowTimestamp(end)}`;
    const pages = table.listEntities({ queryOptions: {
      filter: odata`PartitionKey eq ${partitionKey} and RowKey ge ${rowStart} and RowKey lt ${rowEnd}`,
      select: ['RowKey', 'recordId', 'publishedAt', 'source', 'url', 'title', 'themes', 'language', 'matchedName']
    } }).byPage({ maxPageSize: pageSize, ...(cursor?.index === index && cursor.token
      ? { continuationToken: cursor.token } : {}) });
    const first = await pages.next();
    const rows = first.done ? [] : [...first.value];
    const token = first.done ? null : first.value.continuationToken || null;
    if (rows.length || token) return { rows, name, kind,
      nextCursor: token ? { index, token } : { index: index + 1, token: null },
      done: false };
    index += 1;
  }
  return { rows: [], nextCursor: { index, token: null }, done: true };
}

export function stateCoversRequest(state, request, currentTime = Date.now()) {
  if (!state?.coverage_start || !state?.coverage_end) return false;
  const { start, end } = requestedWindow(request, currentTime, state);
  const coverageStart = new Date(state.coverage_start);
  const coverageEnd = new Date(state.coverage_end);
  const freshnessHours = (currentTime - coverageEnd.getTime()) / 3_600_000;
  const today = new Date(currentTime).toISOString().slice(0, 10);
  // Historical closed windows do not become incomplete merely because today's
  // ingest is late. A request through today still needs a fresh watermark.
  const endCovered = request.date_to && request.date_to !== today
    ? coverageEnd >= end : freshnessHours >= 0 && freshnessHours <= 36;
  return coverageStart <= start && endCovered;
}

function sourceLanguage(entity) {
  return String(entity.language || '').trim().toLowerCase() || 'und';
}

export async function searchLocalGdeltIndex(request, overrides = {}) {
  if (process.env.GDELT_V2_READ_ENABLED === 'true' && request.archive_all_stored === true) {
    const sourceState = overrides.state ?? await archiveState({ fresh: true });
    const v2 = await searchV2Summary(request, { clients: overrides.v2Clients,
      state: overrides.v2State, sourceState });
    if (v2) return v2;
  }
  if (overrides.requireV2 === true) return { results: [], complete: false,
    limitReason: 'v2_snapshot_unavailable', scan: { mode: 'v2_unavailable' }, state: null };
  const configured = overrides.clients ?? storageClients();
  if (!configured) return null;
  const state = overrides.state ?? await archiveState();
  if (!state) return { results: [], complete: false, state: null };
  const allNames = [...new Set([
    request.name,
    ...(request.aliases || []),
    ...Object.values(request.transliterations || {}).flat(),
    ...(request.associations || []).map(({ value }) => value)
  ].map(normalizeEntityName).filter(Boolean))];
  const names = allNames.slice(0, 12);
  const kinds = request.entity_type === 'individual' ? ['person', 'organization'] : ['organization', 'person'];
  const { start, end } = requestedWindow(request, Date.now(), state);
  const scanStart = new Date(Math.max(start.getTime(), new Date(state.coverage_start).getTime()));
  const scanEndExclusive = new Date(Math.floor(end.getTime() / 1_000) * 1_000 + 1_000);
  const results = [];
  const seen = new Set();
  const scanStartedAt = Date.now();
  const maxRows = overrides.maxRows ?? MAX_ROWS_PER_SEARCH;
  const maxScanMs = overrides.maxScanMs ?? MAX_SCAN_MS;
  let rowsScanned = 0;
  let lookups = 0;
  let limitReason = allNames.length > names.length ? 'name_limit_exceeded' : null;

  lookup: for (const name of names) {
    const entityHash = hashName(name);
    for (const kind of kinds) {
      if (scanStart >= scanEndExclusive) break lookup;
      const partitionKey = `${kind[0]}-${entityHash.slice(0, 1)}`;
      // The ingester writes hash_YYYYMMDDHHMMSS-recordId. Bound the indexed
      // RowKey range before paging so recent searches never read old rows.
      const rowStart = `${entityHash}_${rowTimestamp(scanStart)}`;
      const rowEnd = `${entityHash}_${rowTimestamp(scanEndExclusive)}`;
      const entities = configured.table.listEntities({
        queryOptions: {
          filter: odata`PartitionKey eq ${partitionKey} and RowKey ge ${rowStart} and RowKey lt ${rowEnd}`,
          select: ['RowKey', 'recordId', 'publishedAt', 'source', 'url', 'title', 'themes', 'language', 'matchedName']
        }
      });
      lookups += 1;
      for await (const entity of entities) {
        if (rowsScanned >= maxRows) {
          limitReason = 'scan_row_limit_exceeded';
          break lookup;
        }
        if (Date.now() - scanStartedAt >= maxScanMs) {
          limitReason = 'scan_time_limit_exceeded';
          break lookup;
        }
        rowsScanned += 1;
        const published = new Date(String(entity.publishedAt || ''));
        if (!Number.isFinite(published.getTime()) || published < start || published > end) continue;
        const url = String(entity.url || '');
        if (!url || seen.has(url)) continue;
        seen.add(url);
        results.push({
          title: String(entity.title || entity.matchedName || request.name),
          url,
          description: `${String(entity.matchedName || '')} ${String(entity.themes || '').replaceAll(';', ' ')}`.trim(),
          published: published.toISOString(),
          meta_url: { hostname: String(entity.source || '') },
          _queryLanguage: sourceLanguage(entity),
          _sourceType: 'global_archive'
        });
      }
      if (Date.now() - scanStartedAt >= maxScanMs) {
        limitReason = 'scan_time_limit_exceeded';
        break lookup;
      }
    }
  }

  return {
    results,
    complete: !limitReason && stateCoversRequest(state, request),
    limitReason,
    scan: { rows_scanned: rowsScanned, rows_returned: results.length,
      names_requested: allNames.length, names_queried: names.length,
      lookups, elapsed_ms: Date.now() - scanStartedAt, truncated: Boolean(limitReason) },
    state: {
      coverage_start: state.coverage_start,
      coverage_end: state.coverage_end,
      last_successful_at: state.last_successful_at,
      files_processed: state.files_processed,
      entity_mentions_indexed: state.entity_mentions_indexed
    }
  };
}

export function resetLocalGdeltIndexForTests() {
  clients = undefined;
  cachedState = undefined;
}
