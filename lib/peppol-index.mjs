import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { BlobClient } from '@azure/storage-blob';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';

const REFRESH_MS = 5 * 60 * 1000;
const MAX_MATCHES = 5;
const cache = new Map();
const inFlight = new Map();

function usableName(value) {
  if (typeof value !== 'string') return '';
  const name = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return name.length >= 3 && name.length <= 200 && !/^(?:not found|not readable|unknown|null|n\/a)$/i.test(name)
    ? name : '';
}

function comparableName(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}\s]+/gu, '').replace(/\s+/g, ' ').trim();
}

function baseName(value) {
  return comparableName(value).replace(/(?:\s+(?:llc|ltd|limited|fzco|fzc|fze|pjsc|plc))+$/u, '').trim();
}

function possibleScore(query, candidate) {
  if (!query || !candidate) return 0;
  if (baseName(query) === baseName(candidate)) return 0.95;
  const q = new Set(baseName(query).split(' ').filter((token) => token.length > 2));
  const c = new Set(baseName(candidate).split(' ').filter((token) => token.length > 2));
  if (q.size < 2 || c.size < 2) return 0;
  const common = [...q].filter((token) => c.has(token)).length;
  return common >= 2 ? common / new Set([...q, ...c]).size : 0;
}

function unavailable(name, reason) {
  return { status: 'unavailable', source: 'peppol_directory_export', queried_name: name,
    country: 'AE', checked_at: new Date().toISOString(), reason_code: reason, matches: [] };
}

export function tradeLicenseName(source) {
  for (const result of [source?.uae_tl_verification, source?.trade_licence_verification_api]) {
    const name = usableName(result?.licence_registration_name)
      || usableName(result?.licence_registration_name_arabic);
    if (name) return name;
  }
  return '';
}

export function tradeLicenseOcrName(data) {
  return usableName(data?.company_name_english) || usableName(data?.company_name_arabic);
}

async function parseIndex(stream) {
  let metadata;
  let footer;
  const cards = [];
  const exact = new Map();
  const tokens = new Map();
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const value = JSON.parse(line);
    if (!metadata) {
      metadata = value._meta;
      if (metadata?.schema_version !== 1 || metadata?.country !== 'AE'
        || !Number.isFinite(Date.parse(metadata?.snapshot_at))) throw new Error('peppol_index_invalid');
      continue;
    }
    if (value._footer) {
      footer = value._footer;
      continue;
    }
    if (footer) throw new Error('peppol_index_invalid');
    if (!value.participant_id || !Array.isArray(value.entities)) throw new Error('peppol_index_invalid');
    const searchNames = value.entities.flatMap((entity) => entity.names || [])
      .map((item) => comparableName(item.name)).filter(Boolean);
    const index = cards.length;
    cards.push({ value, searchNames });
    for (const name of new Set(searchNames)) {
      if (!exact.has(name)) exact.set(name, []);
      exact.get(name).push(index);
    }
    for (const token of new Set(searchNames.flatMap((name) => baseName(name).split(' '))
      .filter((item) => item.length > 2))) {
      if (!tokens.has(token)) tokens.set(token, new Set());
      tokens.get(token).add(index);
    }
  }
  if (!metadata || !cards.length || footer?.cards !== cards.length) throw new Error('peppol_index_invalid');
  return { metadata, cards, exact, tokens };
}

async function indexSource({ indexPath, blobUrl, blobClient }) {
  if (indexPath) {
    const info = await stat(indexPath);
    return { key: `file:${indexPath}`, version: `${info.size}:${info.mtimeMs}`,
      open: () => createReadStream(indexPath) };
  }
  if (blobUrl || blobClient) {
    const client = blobClient || new BlobClient(blobUrl, new ContainerAppsManagedIdentityCredential());
    const properties = await client.getProperties();
    return { key: `blob:${blobUrl || 'injected'}`, version: properties.etag,
      open: async () => (await client.download()).readableStreamBody };
  }
  throw new Error('peppol_index_not_configured');
}

async function loadIndex(options) {
  const key = options.indexPath ? `file:${options.indexPath}` : `blob:${options.blobUrl || 'injected'}`;
  const prior = cache.get(key);
  if (prior && Date.now() - prior.checkedAt < REFRESH_MS) return prior.data;
  if (inFlight.has(key)) return inFlight.get(key);
  const loading = (async () => {
    try {
      const source = await indexSource(options);
      if (prior?.version === source.version) {
        prior.checkedAt = Date.now();
        return prior.data;
      }
      const data = await parseIndex(await source.open());
      cache.set(source.key, { data, version: source.version, checkedAt: Date.now() });
      return data;
    } catch {
      if (prior) return prior.data;
      throw new Error('peppol_index_unavailable');
    }
  })();
  inFlight.set(key, loading);
  try { return await loading; }
  finally { inFlight.delete(key); }
}

export async function searchPeppolIndex(rawName, { indexPath = process.env.PEPPOL_INDEX_PATH,
  blobUrl = process.env.PEPPOL_INDEX_BLOB_URL, blobClient } = {}) {
  const name = usableName(rawName);
  if (!name) return { status: 'name_unavailable', source: 'peppol_directory_export',
    country: 'AE', checked_at: new Date().toISOString(), matches: [] };
  let index;
  try { index = await loadIndex({ indexPath, blobUrl, blobClient }); }
  catch { return unavailable(name, 'index_unavailable'); }
  const normalized = comparableName(name);
  let selected = (index.exact.get(normalized) || []).map((cardIndex) => index.cards[cardIndex]);
  let status = 'name_match';
  if (!selected.length) {
    const candidates = [];
    const queryTokens = [...new Set(baseName(normalized).split(' ').filter((item) => item.length > 2))];
    const candidateIds = new Set(queryTokens.flatMap((token) => [...(index.tokens.get(token) || [])]));
    for (const candidateId of candidateIds) {
      const card = index.cards[candidateId];
      const score = Math.max(0, ...card.searchNames.map((item) => possibleScore(normalized, item)));
      if (score >= 0.7) candidates.push({ card, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    selected = candidates.map((item) => item.card);
    status = selected.length ? 'possible_matches' : 'not_found';
  }
  return { status, source: 'peppol_directory_export', queried_name: name, country: 'AE',
    checked_at: new Date().toISOString(), snapshot_at: index.metadata.snapshot_at,
    stale: Date.now() - Date.parse(index.metadata.snapshot_at) > 48 * 60 * 60 * 1000,
    total_results: selected.length, truncated: selected.length > MAX_MATCHES,
    matches: selected.slice(0, MAX_MATCHES).map((item) => item.value) };
}
