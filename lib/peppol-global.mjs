import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { TableClient, odata } from '@azure/data-tables';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';
import { comparableName } from './peppol-index.mjs';

const TABLE_NAME = process.env.PEPPOL_GLOBAL_TABLE || 'PeppolDirectoryNames';
const MAX_MATCHES = 10;
const METADATA_TTL_MS = 5 * 60_000;
let defaultClient;
const metadataCache = new WeakMap();

function configuredClient() {
  if (!process.env.PEPPOL_GLOBAL_TABLE_URL) return null;
  defaultClient ||= new TableClient(process.env.PEPPOL_GLOBAL_TABLE_URL, TABLE_NAME,
    new ContainerAppsManagedIdentityCredential());
  return defaultClient;
}

async function metadata(table) {
  const cached = metadataCache.get(table);
  if (cached?.expiresAt > Date.now()) return cached.value;
  try {
    const row = await table.getEntity('meta', 'current');
    if (row.state !== 'ready' || !/^[a-f0-9]{8}$/.test(row.version || '')
      || !Number.isFinite(Date.parse(row.snapshotAt))) return null;
    const value = { snapshot_at: row.snapshotAt, version: row.version, cards: Number(row.cards),
      countries: JSON.parse(row.countriesJson || '[]').filter((item) =>
        /^[A-Z]{2}$/.test(item.code) && !['XX', 'ZZ', 'EU'].includes(item.code)) };
    metadataCache.set(table, { value, expiresAt: Date.now() + METADATA_TTL_MS });
    return value;
  } catch {
    metadataCache.set(table, { value: null, expiresAt: Date.now() + 30_000 });
    return null;
  }
}

function decodedCard(row) {
  const parts = [];
  for (let i = 0; i < 12; i += 1) {
    if (!row[`data${i}`]) break;
    parts.push(row[`data${i}`]);
  }
  const card = JSON.parse(inflateRawSync(Buffer.from(parts.join(''), 'base64')).toString('utf8'));
  return { ...card, matched_name: row.matchedName, country_code: row.countryCode };
}

export function validatePeppolSearchInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A JSON object is required.');
  const name = typeof input.name === 'string' ? input.name.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
  if (name.length < 3 || name.length > 200 || comparableName(name).length < 3)
    throw new Error('Name must contain 3–200 searchable characters.');
  const country = input.country === undefined || input.country === null || input.country === ''
    ? null : String(input.country).trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error('Country must be a two-letter code such as AE.');
  return { name, country };
}

export async function peppolGlobalCountries({ table = configuredClient() } = {}) {
  if (!table) return { status: 'unavailable', countries: [] };
  const current = await metadata(table);
  return current ? { status: 'ready', snapshot_at: current.snapshot_at, cards: current.cards,
    countries: current.countries } : { status: 'unavailable', countries: [] };
}

export async function searchPeppolGlobal(input, { table = configuredClient() } = {}) {
  const { name, country } = validatePeppolSearchInput(input);
  const result = { source: 'peppol_directory_export', queried_name: name, country,
    checked_at: new Date().toISOString(), matches: [] };
  if (!table) return { ...result, status: 'unavailable', reason_code: 'index_unavailable' };
  const current = await metadata(table);
  if (!current) return { ...result, status: 'unavailable', reason_code: 'index_unavailable' };
  if (country && !current.countries.some((item) => item.code === country))
    return { ...result, status: 'not_found', snapshot_at: current.snapshot_at,
      stale: Date.now() - Date.parse(current.snapshot_at) > 48 * 60 * 60_000,
      returned_count: 0, truncated: false };
  const normalized = comparableName(name);
  const nameHash = createHash('sha256').update(normalized).digest('hex');
  const partitionKey = `p${current.version}_${nameHash.slice(0, 2)}`;
  const rowPrefix = country ? `${nameHash}_${country}_` : `${nameHash}_`;
  const rows = table.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${partitionKey} and RowKey ge ${rowPrefix} and RowKey lt ${rowPrefix + '~'}` } });
  const matches = [];
  try {
    for await (const row of rows) {
      matches.push(decodedCard(row));
      if (matches.length > MAX_MATCHES) break;
    }
  } catch {
    return { ...result, status: 'unavailable', reason_code: 'index_unavailable',
      snapshot_at: current.snapshot_at };
  }
  return { ...result, status: matches.length ? 'name_match' : 'not_found',
    snapshot_at: current.snapshot_at, stale: Date.now() - Date.parse(current.snapshot_at) > 48 * 60 * 60_000,
    returned_count: Math.min(matches.length, MAX_MATCHES), truncated: matches.length > MAX_MATCHES,
    matches: matches.slice(0, MAX_MATCHES) };
}
