import { createHash } from 'node:crypto';
import { TableClient, odata } from '@azure/data-tables';
import { BlobServiceClient } from '@azure/storage-blob';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';

const TABLE_NAME = process.env.GDELT_INDEX_TABLE || 'GdeltEntityMentions';
const CONTAINER_NAME = process.env.GDELT_ARCHIVE_CONTAINER || 'gdelt-archive';
const STATE_BLOB = 'state/watermark.json';
const STATE_CACHE_MS = 5 * 60 * 1_000;
const MAX_ROWS_PER_NAME = 250;

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

async function archiveState() {
  const now = Date.now();
  if (cachedState?.expiresAt > now) return cachedState.value;
  const configured = storageClients();
  if (!configured) return null;
  try {
    const response = await configured.container.getBlobClient(STATE_BLOB).download();
    const value = JSON.parse((await readStream(response.readableStreamBody)).toString('utf8'));
    cachedState = { value, expiresAt: now + STATE_CACHE_MS };
    return value;
  } catch {
    cachedState = { value: null, expiresAt: now + 30_000 };
    return null;
  }
}

function requestedWindow(request) {
  const end = request.date_to ? new Date(`${request.date_to}T23:59:59.999Z`) : new Date();
  const start = request.date_from
    ? new Date(`${request.date_from}T00:00:00.000Z`)
    : new Date(end.getTime() - 365 * 24 * 60 * 60 * 1_000);
  return { start, end };
}

function stateCoversRequest(state, request) {
  if (!state?.coverage_start || !state?.coverage_end) return false;
  const { start, end } = requestedWindow(request);
  const coverageStart = new Date(state.coverage_start);
  const coverageEnd = new Date(state.coverage_end);
  const freshnessHours = (Date.now() - coverageEnd.getTime()) / 3_600_000;
  return coverageStart <= start && coverageEnd >= end && freshnessHours <= 48;
}

function sourceLanguage(entity) {
  return String(entity.language || '').trim().toLowerCase() || 'und';
}

export async function searchLocalGdeltIndex(request) {
  const configured = storageClients();
  if (!configured) return null;
  const state = await archiveState();
  if (!state) return { results: [], complete: false, state: null };
  const names = [...new Set([
    request.name,
    ...(request.aliases || []),
    ...Object.values(request.transliterations || {}).flat()
  ].map(normalizeEntityName).filter(Boolean))].slice(0, 12);
  const kinds = request.entity_type === 'individual' ? ['person', 'organization'] : ['organization', 'person'];
  const { start, end } = requestedWindow(request);
  const results = [];
  const seen = new Set();

  for (const name of names) {
    const entityHash = hashName(name);
    for (const kind of kinds) {
      const partitionKey = `${kind[0]}-${entityHash.slice(0, 1)}`;
      const rowStart = `${entityHash}_`;
      const rowEnd = `${entityHash}\``;
      const entities = configured.table.listEntities({
        queryOptions: {
          filter: odata`PartitionKey eq ${partitionKey} and RowKey ge ${rowStart} and RowKey lt ${rowEnd}`,
          select: ['RowKey', 'recordId', 'publishedAt', 'source', 'url', 'title', 'themes', 'language', 'matchedName']
        }
      });
      let count = 0;
      for await (const entity of entities) {
        if (count >= MAX_ROWS_PER_NAME) break;
        count += 1;
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
    }
  }

  return {
    results,
    complete: stateCoversRequest(state, request),
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
