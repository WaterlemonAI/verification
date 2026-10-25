import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { BlobServiceClient } from '@azure/storage-blob';
import { TableClient } from '@azure/data-tables';
import unzipper from 'unzipper';
import { ContainerAppsManagedIdentityCredential } from '../lib/azure-managed-identity.mjs';

const SOURCE_ORIGIN = 'https://data.gdeltproject.org';
const TABLE_NAME = process.env.GDELT_INDEX_TABLE || 'GdeltEntityMentions';
const CONTAINER_NAME = process.env.GDELT_ARCHIVE_CONTAINER || 'gdelt-archive';
const INITIAL_LOOKBACK_HOURS = Number(process.env.GDELT_INITIAL_LOOKBACK_HOURS || 72);
const OVERLAP_HOURS = Number(process.env.GDELT_INCREMENTAL_OVERLAP_HOURS || 36);
const MAX_FILES = Number(process.env.GDELT_MAX_FILES_PER_RUN || 400);
const BATCH_CONCURRENCY = 6;
const STATE_BLOB = 'state/watermark.json';
const MAX_COMPRESSED_FILE_BYTES = 32 * 1024 * 1024;
const MAX_UNCOMPRESSED_FILE_BYTES = 256 * 1024 * 1024;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function normalizeEntityName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function intervalTimestamp(date) {
  const rounded = new Date(date);
  rounded.setUTCSeconds(0, 0);
  rounded.setUTCMinutes(Math.floor(rounded.getUTCMinutes() / 15) * 15);
  return rounded.toISOString().replace(/[-:T]/g, '').slice(0, 12) + '00';
}

export function parseTimestamp(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!match) throw new Error('invalid_gdelt_timestamp');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])));
}

function intervals(start, end) {
  const values = [];
  let current = parseTimestamp(intervalTimestamp(start));
  const last = parseTimestamp(intervalTimestamp(end));
  while (current <= last && values.length < MAX_FILES) {
    values.push(intervalTimestamp(current));
    current = new Date(current.getTime() + 15 * 60 * 1_000);
  }
  return values;
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function xmlValue(xml, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml || '');
  return decodeXmlText(match?.[1] || '').trim();
}

function uniqueNames(value) {
  return [...new Set(String(value || '').split(';').map((name) => name.trim()).filter(Boolean))];
}

function languageOf(recordId, translationInfo) {
  const match = /srclc:([^;]+)/i.exec(translationInfo || '');
  if (match) return match[1].trim().toLowerCase().slice(0, 16);
  return String(recordId).includes('-T') ? 'translated' : 'en';
}

export function entityRows(tsv) {
  const byPartition = new Map();
  let records = 0;
  let mentions = 0;
  for (const line of tsv.split('\n')) {
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length < 27) continue;
    records += 1;
    const recordId = fields[0];
    const publishedAt = parseTimestamp(fields[1]).toISOString();
    const source = fields[3].slice(0, 255);
    const url = fields[4].slice(0, 2048);
    const themes = fields[8].slice(0, 8192);
    const title = xmlValue(fields[26], 'PAGE_TITLE').slice(0, 1000);
    const language = languageOf(recordId, fields[25]);
    const groups = [
      ['person', uniqueNames(fields[11])],
      ['organization', uniqueNames(fields[13])]
    ];
    for (const [kind, names] of groups) {
      const normalizedInDocument = new Set();
      for (const matchedName of names) {
        const normalized = normalizeEntityName(matchedName);
        if (normalized.length < 2 || normalizedInDocument.has(normalized)) continue;
        normalizedInDocument.add(normalized);
        const entityHash = sha256(normalized);
        const partitionKey = `${kind[0]}-${entityHash.slice(0, 1)}`;
        const rowKey = `${entityHash}_${recordId}`;
        const rows = byPartition.get(partitionKey) || [];
        rows.push({ partitionKey, rowKey, recordId, publishedAt, source, url, title, themes, language, matchedName: matchedName.slice(0, 500) });
        byPartition.set(partitionKey, rows);
        mentions += 1;
      }
    }
  }
  return { byPartition, records, mentions };
}

async function retryingFetch(url, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (response.ok || response.status === 404) return response;
      lastError = new Error(`source_http_${response.status}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000 * (2 ** attempt)));
  }
  throw lastError;
}

async function latestTimestamp() {
  const response = await retryingFetch(`${SOURCE_ORIGIN}/gdeltv2/lastupdate.txt`);
  if (!response.ok) throw new Error('gdelt_lastupdate_unavailable');
  const text = await response.text();
  const match = /\/(\d{14})\.gkg\.csv\.zip/.exec(text);
  if (!match) throw new Error('gdelt_lastupdate_invalid');
  return match[1];
}

async function readBlobJson(container, name) {
  try {
    const response = await container.getBlobClient(name).download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

async function writeBatches(table, byPartition) {
  const batches = [];
  for (const rows of byPartition.values()) {
    for (let i = 0; i < rows.length; i += 100) {
      batches.push(rows.slice(i, i + 100).map((entity) => ['upsert', entity, 'Replace']));
    }
  }
  let cursor = 0;
  const workers = Array.from({ length: BATCH_CONCURRENCY }, async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor];
      cursor += 1;
      await table.submitTransaction(batch);
    }
  });
  await Promise.all(workers);
}

export async function main() {
  const accountUrl = required('GDELT_STORAGE_ACCOUNT_URL');
  const credential = new ContainerAppsManagedIdentityCredential();
  const account = new URL(accountUrl);
  const tableUrl = `${account.protocol}//${account.hostname.replace('.blob.', '.table.')}`;
  const blobService = new BlobServiceClient(accountUrl, credential);
  const container = blobService.getContainerClient(CONTAINER_NAME);
  const table = new TableClient(tableUrl, TABLE_NAME, credential);
  const previous = await readBlobJson(container, STATE_BLOB);
  const latest = await latestTimestamp();
  const end = parseTimestamp(latest);
  const start = previous?.coverage_end
    ? new Date(new Date(previous.coverage_end).getTime() - OVERLAP_HOURS * 3_600_000)
    : new Date(end.getTime() - INITIAL_LOOKBACK_HOURS * 3_600_000);
  const targets = intervals(start, end);
  if (targets.length >= MAX_FILES && targets.at(-1) !== intervalTimestamp(end)) throw new Error('gdelt_run_file_limit_exceeded');

  let filesProcessed = 0;
  let sourceRecords = 0;
  let entityMentions = 0;
  let lastProcessed = previous?.coverage_end ? new Date(previous.coverage_end) : start;
  for (const timestamp of targets) {
    const sourceUrl = `${SOURCE_ORIGIN}/gdeltv2/${timestamp}.gkg.csv.zip`;
    const response = await retryingFetch(sourceUrl);
    if (response.status === 404) continue;
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_COMPRESSED_FILE_BYTES) throw new Error(`gdelt_zip_too_large_${timestamp}`);
    const zip = Buffer.from(await response.arrayBuffer());
    if (zip.length > MAX_COMPRESSED_FILE_BYTES) throw new Error(`gdelt_zip_too_large_${timestamp}`);
    const md5 = createHash('md5').update(zip).digest('hex');
    const rawName = `raw/gkg/${timestamp.slice(0, 4)}/${timestamp.slice(4, 6)}/${timestamp.slice(6, 8)}/${timestamp}.gkg.csv.zip`;
    const raw = container.getBlockBlobClient(rawName);
    if (!(await raw.exists())) {
      await raw.uploadData(zip, { blobHTTPHeaders: { blobContentType: 'application/zip' }, metadata: { source: 'gdelt', md5 } });
    }
    const directory = await unzipper.Open.buffer(zip);
    const entry = directory.files.find((file) => file.type === 'File');
    if (!entry) throw new Error(`gdelt_zip_empty_${timestamp}`);
    if (Number(entry.vars?.uncompressedSize || 0) > MAX_UNCOMPRESSED_FILE_BYTES) throw new Error(`gdelt_entry_too_large_${timestamp}`);
    const parsed = entityRows((await entry.buffer()).toString('utf8'));
    await writeBatches(table, parsed.byPartition);
    filesProcessed += 1;
    sourceRecords += parsed.records;
    entityMentions += parsed.mentions;
    lastProcessed = parseTimestamp(timestamp);
    process.stdout.write(`${JSON.stringify({ event: 'gdelt_file_indexed', timestamp, records: parsed.records, mentions: parsed.mentions })}\n`);
  }

  const coverageStart = previous?.coverage_start || parseTimestamp(intervalTimestamp(start)).toISOString();
  const state = {
    version: 1,
    coverage_start: coverageStart,
    coverage_end: lastProcessed.toISOString(),
    last_successful_at: new Date().toISOString(),
    files_processed: Number(previous?.files_processed || 0) + filesProcessed,
    entity_mentions_indexed: Number(previous?.entity_mentions_indexed || 0) + entityMentions,
    last_run: { files_processed: filesProcessed, source_records: sourceRecords, entity_mentions_indexed: entityMentions }
  };
  await container.getBlockBlobClient(STATE_BLOB).uploadData(Buffer.from(JSON.stringify(state)), {
    blobHTTPHeaders: { blobContentType: 'application/json' }
  });
  process.stdout.write(`${JSON.stringify({ event: 'gdelt_ingestion_completed', ...state.last_run, coverage_start: state.coverage_start, coverage_end: state.coverage_end })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'gdelt_ingestion_failed', error: error.message })}\n`);
    process.exitCode = 1;
  });
}
