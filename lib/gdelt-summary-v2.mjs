import { createHash } from 'node:crypto';
import { TableClient } from '@azure/data-tables';
import { BlobServiceClient } from '@azure/storage-blob';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';

export const V2_SUMMARY_TABLE = 'GdeltEntitySummaryV2';
export const V2_MANIFEST_TABLE = 'GdeltIntervalManifestV2';
export const V2_STATE_BLOB = 'state/v2-watermark.json';
const INTERVAL_MS = 15 * 60_000;
const MAX_BITMAP_INTERVALS = 5 * 366 * 96;
const MAX_SAMPLE_REFS = 20;
const UPDATE_RETRIES = 8;

const hash = (value) => createHash('sha256').update(value).digest('hex');
const timestampDate = (timestamp) => {
  if (!/^\d{14}$/.test(timestamp)) throw new Error('invalid_v2_interval_timestamp');
  const date = new Date(Date.UTC(Number(timestamp.slice(0, 4)), Number(timestamp.slice(4, 6)) - 1,
    Number(timestamp.slice(6, 8)), Number(timestamp.slice(8, 10)), Number(timestamp.slice(10, 12)),
    Number(timestamp.slice(12, 14))));
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace(/[-:T]/g, '').slice(0, 14) !== timestamp
    || date.getUTCMinutes() % 15 !== 0) throw new Error('invalid_v2_interval_timestamp');
  return date;
};
const intervalNumber = (timestamp) => timestampDate(timestamp).getTime() / INTERVAL_MS;
const intervalString = (number) => new Date(number * INTERVAL_MS).toISOString().replace(/[-:T]/g, '').slice(0, 14);

export function normalizedGdeltName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export function summaryKey(kind, name) {
  if (!['person', 'organization'].includes(kind)) throw new Error('invalid_v2_kind');
  const normalized = normalizedGdeltName(name);
  if (normalized.length < 2) throw new Error('invalid_v2_name');
  return { partitionKey: `${kind[0]}-${hash(normalized)}`, rowKey: 'summary' };
}

function keyFromV1(row) {
  const kind = row.partitionKey.startsWith('p-') ? 'person' : 'organization';
  const nameHash = row.rowKey.slice(0, 64);
  if (!/^[a-f0-9]{64}$/.test(nameHash)) throw new Error('invalid_v1_row_key');
  return { partitionKey: `${kind[0]}-${nameHash}`, rowKey: 'summary' };
}

function decodeBitmap(entity) {
  if (!entity) return { base: null, bytes: Buffer.alloc(0) };
  const base = Number(entity.bitmapBase);
  const bytes = Buffer.from(String(entity.intervalBitmap || ''), 'base64');
  if (!Number.isSafeInteger(base) || bytes.length > Math.ceil(MAX_BITMAP_INTERVALS / 8)) {
    throw new Error('invalid_v2_summary_bitmap');
  }
  return { base, bytes };
}

export function hasAppliedInterval(entity, timestamp) {
  const { base, bytes } = decodeBitmap(entity);
  if (base === null) return false;
  const offset = intervalNumber(timestamp) - base;
  return offset >= 0 && offset < bytes.length * 8 && Boolean(bytes[Math.floor(offset / 8)] & (1 << offset % 8));
}

function addInterval(entity, timestamp) {
  const index = intervalNumber(timestamp);
  const previous = decodeBitmap(entity);
  const base = previous.base === null ? index : Math.min(previous.base, index);
  const highest = previous.base === null ? index : Math.max(previous.base + previous.bytes.length * 8 - 1, index);
  if (highest - base + 1 > MAX_BITMAP_INTERVALS) throw new Error('v2_summary_interval_span_exceeded');
  const bytes = Buffer.alloc(Math.ceil((highest - base + 1) / 8));
  if (previous.base !== null) {
    for (let i = 0; i < previous.bytes.length * 8; i += 1) {
      if (previous.bytes[Math.floor(i / 8)] & (1 << i % 8)) {
        const shifted = previous.base + i - base;
        bytes[Math.floor(shifted / 8)] |= 1 << shifted % 8;
      }
    }
  }
  const offset = index - base;
  bytes[Math.floor(offset / 8)] |= 1 << offset % 8;
  return { bitmapBase: base, intervalBitmap: bytes.toString('base64') };
}

function sampleRef(row) {
  return { id: String(row.recordId || '').slice(0, 120), url: String(row.url || '').slice(0, 500),
    title: String(row.title || '').slice(0, 180), published: String(row.publishedAt || ''),
    source: String(row.source || '').slice(0, 100), language: String(row.language || '').slice(0, 16),
    name: String(row.matchedName || '').slice(0, 120), themes: String(row.themes || '').slice(0, 400) };
}

function nextSummary(current, timestamp, rows, key) {
  const refs = [...(current?.sampleRefs ? JSON.parse(current.sampleRefs) : []), ...rows.map(sampleRef)]
    .sort((a, b) => b.published.localeCompare(a.published) || a.id.localeCompare(b.id));
  const selected = [];
  const seen = new Set();
  for (const ref of refs) {
    if (!ref.url || seen.has(ref.url)) continue;
    seen.add(ref.url);
    selected.push(ref);
    if (selected.length >= MAX_SAMPLE_REFS) break;
  }
  while (Buffer.byteLength(JSON.stringify(selected), 'utf8') > 30_000) selected.pop();
  const mentions = Number(current?.mentionCount || 0) + rows.length;
  return { ...key, indexVersion: 2, mentionCount: mentions, unreviewedCount: mentions,
    sampleRefs: JSON.stringify(selected), ...addInterval(current, timestamp),
    firstInterval: current?.firstInterval && current.firstInterval < timestamp ? current.firstInterval : timestamp,
    lastInterval: current?.lastInterval && current.lastInterval > timestamp ? current.lastInterval : timestamp };
}

export async function applyV2SummaryInterval(table, timestamp, rows, { signal } = {}) {
  const key = keyFromV1(rows[0]);
  for (let attempt = 0; attempt < UPDATE_RETRIES; attempt += 1) {
    if (signal?.aborted) throw signal.reason;
    let current;
    try { current = await table.getEntity(key.partitionKey, key.rowKey, { abortSignal: signal }); }
    catch (error) { if (error.statusCode !== 404) throw error; }
    if (current && hasAppliedInterval(current, timestamp)) return false;
    const next = nextSummary(current, timestamp, rows, key);
    try {
      if (current) await table.updateEntity(next, 'Replace', { etag: current.etag, abortSignal: signal });
      else await table.createEntity(next, { abortSignal: signal });
      return true;
    } catch (error) {
      if (![409, 412].includes(error.statusCode)) throw error;
    }
  }
  throw new Error('v2_summary_concurrent_update_exhausted');
}

export function groupV2Rows(byPartition) {
  const grouped = new Map();
  let mentions = 0;
  for (const rows of byPartition.values()) for (const row of rows) {
    const key = keyFromV1(row).partitionKey;
    const entries = grouped.get(key) || [];
    entries.push(row);
    grouped.set(key, entries);
    mentions += 1;
  }
  return { grouped, mentions };
}

export function v2Manifest(timestamp, sourceSha256, records, mentions, entityCount) {
  timestampDate(timestamp);
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) || ![records, mentions, entityCount].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error('invalid_v2_manifest_input');
  }
  return { partitionKey: timestamp.slice(0, 8), rowKey: timestamp, indexVersion: 2,
    sourceSha256, sourceRecords: records, mentionCount: mentions, entityCount, committed: true, verified: false };
}

function sameManifest(a, b) {
  return a.indexVersion === 2 && a.sourceSha256 === b.sourceSha256
    && Number(a.sourceRecords) === b.sourceRecords && Number(a.mentionCount) === b.mentionCount
    && Number(a.entityCount) === b.entityCount && a.committed === true;
}

export async function publishV2Interval({ timestamp, zip, parsed, summaryTable, manifestTable, signal, concurrency = 24 }) {
  const digest = hash(zip);
  const { grouped, mentions } = groupV2Rows(parsed.byPartition);
  if (mentions !== parsed.mentions) throw new Error('v2_mention_count_mismatch');
  const manifest = v2Manifest(timestamp, digest, parsed.records, mentions, grouped.size);
  let prior;
  try { prior = await manifestTable.getEntity(manifest.partitionKey, manifest.rowKey, { abortSignal: signal }); }
  catch (error) { if (error.statusCode !== 404) throw error; }
  if (prior) {
    if (!sameManifest(prior, manifest)) throw new Error('v2_manifest_conflict');
    if (prior.verified === true) return manifest;
  }
  const items = [...grouped.values()];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw signal.reason;
      const rows = items[cursor++];
      await applyV2SummaryInterval(summaryTable, timestamp, rows, { signal });
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((item) => item.status === 'rejected');
  if (failed) throw failed.reason;
  try { await manifestTable.createEntity(manifest, { abortSignal: signal }); }
  catch (error) {
    if (error.statusCode !== 409) throw error;
    const concurrent = await manifestTable.getEntity(manifest.partitionKey, manifest.rowKey, { abortSignal: signal });
    if (!sameManifest(concurrent, manifest)) throw new Error('v2_manifest_conflict');
  }
  return manifest;
}

async function readBlobJson(container, name, signal) {
  try {
    const response = await container.getBlobClient(name).download(0, undefined, { abortSignal: signal });
    const chunks = [];
    for await (const part of response.readableStreamBody) chunks.push(Buffer.from(part));
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), etag: response.etag };
  } catch (error) { if (error.statusCode === 404) return { value: null, etag: null }; throw error; }
}

export async function readV2State(container, signal) { return readBlobJson(container, V2_STATE_BLOB, signal); }

async function committedManifest(table, number, signal) {
  const timestamp = intervalString(number);
  try {
    const value = await table.getEntity(timestamp.slice(0, 8), timestamp, { abortSignal: signal });
    return value.indexVersion === 2 && value.committed === true && value.verified === true;
  } catch (error) { if (error.statusCode === 404) return false; throw error; }
}

export async function advanceV2Watermark(container, manifestTable, timestamp, signal) {
  const index = intervalNumber(timestamp);
  if (!await committedManifest(manifestTable, index, signal)) throw new Error('v2_interval_not_committed');
  for (let attempt = 0; attempt < UPDATE_RETRIES; attempt += 1) {
    const prior = await readV2State(container, signal);
    let start = prior.value ? intervalNumber(prior.value.coverage_start) : index;
    let end = prior.value ? intervalNumber(prior.value.coverage_end) : index;
    // A later daily interval may already be committed when a historical
    // rebuild catches up. Walk only contiguous manifests, never jump gaps.
    let walked = 0;
    while (walked < 50_000 && await committedManifest(manifestTable, start - 1, signal)) { start -= 1; walked += 1; }
    while (walked < 50_000 && await committedManifest(manifestTable, end + 1, signal)) { end += 1; walked += 1; }
    if (index < start - 1 || index > end + 1) return prior.value;
    if (index === start - 1) start = index;
    if (index === end + 1) end = index;
    if (prior.value && intervalNumber(prior.value.coverage_start) === start && intervalNumber(prior.value.coverage_end) === end) return prior.value;
    const state = { index_version: 2, coverage_start: intervalString(start), coverage_end: intervalString(end),
      committed_intervals: end - start + 1, updated_at: new Date().toISOString() };
    try {
      await container.getBlockBlobClient(V2_STATE_BLOB).uploadData(Buffer.from(JSON.stringify(state)), {
        conditions: prior.etag ? { ifMatch: prior.etag } : { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/json' }, abortSignal: signal
      });
      return state;
    } catch (error) { if (![409, 412].includes(error.statusCode)) throw error; }
  }
  throw new Error('v2_watermark_concurrent_update_exhausted');
}

export function v2Clients(accountUrl = process.env.GDELT_STORAGE_ACCOUNT_URL, credential = new ContainerAppsManagedIdentityCredential()) {
  if (!accountUrl) return null;
  const url = new URL(accountUrl);
  const tableUrl = `${url.protocol}//${url.hostname.replace('.blob.', '.table.')}`;
  return { summaryTable: new TableClient(tableUrl, process.env.GDELT_V2_SUMMARY_TABLE || V2_SUMMARY_TABLE, credential),
    manifestTable: new TableClient(tableUrl, process.env.GDELT_V2_MANIFEST_TABLE || V2_MANIFEST_TABLE, credential),
    container: new BlobServiceClient(accountUrl, credential)
      .getContainerClient(process.env.GDELT_ARCHIVE_CONTAINER || 'gdelt-archive') };
}

export async function searchV2Summary(request, { clients = v2Clients(), state, sourceState, clock = () => Date.now() } = {}) {
  if (!clients) return null;
  const snapshot = state || (await readV2State(clients.container)).value;
  if (!snapshot || snapshot.index_version !== 2) return null;
  const snapshotStart = timestampDate(snapshot.coverage_start).getTime();
  const snapshotEnd = timestampDate(snapshot.coverage_end).getTime();
  const expectedIntervals = (snapshotEnd - snapshotStart) / INTERVAL_MS + 1;
  if (!sourceState?.coverage_start || !sourceState?.coverage_end
    || snapshotStart > new Date(sourceState.coverage_start).getTime()
    || snapshotEnd < new Date(sourceState.coverage_end).getTime()
    || Number(snapshot.committed_intervals) !== expectedIntervals) return null;
  const allNames = [...new Set([request.name, ...(request.aliases || []),
    ...Object.values(request.transliterations || {}).flat(),
    ...(request.associations || []).map(({ value }) => value)].map(normalizedGdeltName).filter((name) => name.length >= 2))];
  // A bounded point-read path. A larger alias set is explicitly incomplete.
  const names = allNames.slice(0, 12);
  const kinds = request.entity_type === 'individual' ? ['person', 'organization'] : ['organization', 'person'];
  const lookups = names.flatMap((name) => kinds.map((kind) => summaryKey(kind, name)));
  const entities = await Promise.all(lookups.map(async (key) => {
    try { return await clients.summaryTable.getEntity(key.partitionKey, key.rowKey); }
    catch (error) { if (error.statusCode === 404) return null; throw error; }
  }));
  const refs = [];
  let mentions = 0;
  let unreviewed = 0;
  let sampled = 0;
  let outsideSnapshot = false;
  for (const entity of entities.filter(Boolean)) {
    if (entity.indexVersion !== 2 || !Number.isSafeInteger(Number(entity.mentionCount))
      || Number(entity.unreviewedCount) < 0 || Number(entity.unreviewedCount) > Number(entity.mentionCount)) {
      throw new Error('invalid_v2_summary');
    }
    decodeBitmap(entity);
    if (entity.firstInterval < snapshot.coverage_start || entity.lastInterval > snapshot.coverage_end) outsideSnapshot = true;
    mentions += Number(entity.mentionCount);
    unreviewed += Number(entity.unreviewedCount);
    const samples = JSON.parse(entity.sampleRefs || '[]');
    if (!Array.isArray(samples) || samples.length > MAX_SAMPLE_REFS) throw new Error('invalid_v2_summary_samples');
    sampled += samples.length;
    refs.push(...samples);
  }
  const coverageEnd = timestampDate(snapshot.coverage_end).getTime();
  const now = clock();
  const requestedEnd = request.date_to ? Date.parse(`${request.date_to}T23:59:59.999Z`) : now;
  // Summaries aggregate all indexed history. Dated subranges require V1 until
  // per-period V2 summaries exist; do not present an all-time count as dated.
  const allStored = request.archive_all_stored === true;
  const today = new Date(now).toISOString().slice(0, 10);
  const ageMs = now - coverageEnd;
  const dateCovered = allStored && (request.date_to && request.date_to !== today
    ? coverageEnd >= requestedEnd - INTERVAL_MS : ageMs >= 0 && ageMs <= 36 * 60 * 60_000);
  const limitReason = allNames.length > names.length ? 'name_limit_exceeded'
    : outsideSnapshot ? 'summary_outside_snapshot'
      : !allStored ? 'dated_range_requires_v1' : null;
  const unique = [...new Map(refs.filter((ref) => ref.url).map((ref) => [ref.url, ref])).values()];
  return { results: unique.map((ref) => ({ title: ref.title || ref.name || request.name, url: ref.url,
    description: `${ref.name || ''} ${String(ref.themes || '').replaceAll(';', ' ')}`.trim(),
    published: ref.published, meta_url: { hostname: ref.source || '' },
    _queryLanguage: ref.language || 'und', _sourceType: 'global_archive' })),
  complete: Boolean(dateCovered && !limitReason), limitReason, evidencePending: unreviewed > 0 || mentions > sampled,
  scan: { mode: 'v2_point_summary', lookups: lookups.length, rows_scanned: 0,
    names_requested: allNames.length, names_queried: names.length, mentions_indexed: mentions,
    sample_refs: sampled, unreviewed_count: unreviewed, truncated: mentions > sampled },
  state: { coverage_start: timestampDate(snapshot.coverage_start).toISOString(),
    coverage_end: timestampDate(snapshot.coverage_end).toISOString(), index_version: 2,
    committed_intervals: snapshot.committed_intervals } };
}
