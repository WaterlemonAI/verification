#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, rename, mkdir, stat, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync } from 'node:zlib';
import { TableClient } from '@azure/data-tables';
import { BlobClient } from '@azure/storage-blob';
import { ContainerAppsManagedIdentityCredential } from '../lib/azure-managed-identity.mjs';
import { comparableName } from '../lib/peppol-index.mjs';

const execFileAsync = promisify(execFile);
const TABLE_NAME = process.env.PEPPOL_GLOBAL_TABLE || 'PeppolDirectoryNames';
const ACCOUNT_URL = process.env.PEPPOL_GLOBAL_TABLE_URL || 'https://stai7uaeocruaen001.table.core.windows.net';
const SOURCE = resolve(process.argv[2] || '/Users/zainabkhan/Downloads/00_INBOX/export-all-businesscards.xml');
const SOURCE_BLOB_URL = process.env.PEPPOL_SOURCE_BLOB_URL || '';
const CHECKPOINT = resolve(process.env.PEPPOL_INGEST_CHECKPOINT || '.local-peppol/global-ingest-checkpoint.json');
const BATCH_SIZE = 100;
const BATCH_CONCURRENCY = 12;
const FLUSH_EVERY_CARDS = 50_000;
const STOP_AFTER_CARDS = Number(process.env.PEPPOL_INGEST_MAX_CARDS || 0);
const MAX_DATA_PARTS = 12;
const DATA_PART_LENGTH = 48_000;

const hash = (value) => createHash('sha256').update(value).digest('hex');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

class AzureCliCredential {
  cached;
  async getToken() {
    if (this.cached?.expiresOnTimestamp > Date.now() + 5 * 60_000) return this.cached;
    const { stdout } = await execFileAsync('az', ['account', 'get-access-token', '--resource', 'https://storage.azure.com/', '-o', 'json']);
    const value = JSON.parse(stdout);
    this.cached = { token: value.accessToken, expiresOnTimestamp: Date.now() + 45 * 60_000 };
    return this.cached;
  }
}

export function rowsForCard(card, version) {
  const participant = card.participant_id;
  if (!participant?.value || !participant.scheme) return [];
  const participantHash = hash(`${participant.scheme}:${participant.value}`).slice(0, 24);
  const rows = [];
  for (const entity of card.entities || []) {
    const countryCode = /^[A-Z]{2}$/.test(entity.country_code || '') ? entity.country_code : 'XX';
    const value = { participant_id: participant, document_types: card.document_types || [], entities: [entity] };
    const data = deflateRawSync(Buffer.from(JSON.stringify(value))).toString('base64');
    if (data.length > MAX_DATA_PARTS * DATA_PART_LENGTH) throw new Error('peppol_card_too_large');
    const parts = {};
    for (let i = 0; i < data.length; i += DATA_PART_LENGTH) parts[`data${i / DATA_PART_LENGTH}`] = data.slice(i, i + DATA_PART_LENGTH);
    for (const name of new Set((entity.names || []).map((item) => comparableName(item.name)).filter((item) => item.length >= 3 && item.length <= 200))) {
      const nameHash = hash(name);
      rows.push({ partitionKey: `p${version}_${nameHash.slice(0, 2)}`,
        rowKey: `${nameHash}_${countryCode}_${participantHash}`,
        matchedName: (entity.names || []).find((item) => comparableName(item.name) === name)?.name?.slice(0, 200) || name,
        countryCode, ...parts });
    }
  }
  return rows;
}

async function sendBatch(table, rows) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { return await table.submitTransaction(rows.map((row) => ['upsert', row, 'Replace'])); }
    catch (error) {
      if (![408, 429, 500, 502, 503, 504].includes(error.statusCode) || attempt === 5) throw error;
      await wait(1_000 * (2 ** attempt) + Math.random() * 500);
    }
  }
}

async function sendBatches(table, batches) {
  let next = 0;
  await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      await sendBatch(table, batch);
    }
  }));
}

async function saveCheckpoint(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}

async function sourceFile() {
  if (!SOURCE_BLOB_URL) {
    const info = await stat(SOURCE);
    return { path: SOURCE, id: SOURCE, size: info.size };
  }
  const blob = new BlobClient(SOURCE_BLOB_URL, new ContainerAppsManagedIdentityCredential());
  const properties = await blob.getProperties();
  const path = '/tmp/peppol-export.xml.gz';
  await rm(path, { force: true });
  await blob.downloadToFile(path, 0, undefined, { concurrency: 16 });
  const info = await stat(path);
  if (info.size !== properties.contentLength) throw new Error('peppol_source_download_incomplete');
  return { path, id: SOURCE_BLOB_URL, size: info.size };
}

async function readCheckpoint(table, path, cloud, sourceId) {
  if (cloud) {
    try {
      const value = await table.getEntity('meta', `ingest-${hash(sourceId).slice(0, 12)}`);
      return JSON.parse(value.checkpointJson);
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function persistCheckpoint(table, path, cloud, value) {
  if (cloud) return table.upsertEntity({ partitionKey: 'meta', rowKey: `ingest-${hash(value.source).slice(0, 12)}`,
    checkpointJson: JSON.stringify(value) }, 'Replace');
  return saveCheckpoint(path, value);
}

export async function ingest({ table = new TableClient(ACCOUNT_URL, TABLE_NAME,
  SOURCE_BLOB_URL ? new ContainerAppsManagedIdentityCredential() : new AzureCliCredential()),
  source = SOURCE, checkpointPath = CHECKPOINT } = {}) {
  const input = SOURCE_BLOB_URL ? await sourceFile() : { path: source, id: source, size: (await stat(source)).size };
  const checkpoint = await readCheckpoint(table, checkpointPath, Boolean(SOURCE_BLOB_URL), input.id);
  if (checkpoint && (checkpoint.source !== input.id || checkpoint.sourceSize !== input.size))
    throw new Error('peppol_ingest_checkpoint_source_mismatch');
  let cards = checkpoint?.cards || 0;
  let nameRows = checkpoint?.nameRows || 0;
  const countryCounts = checkpoint?.countryCounts || {};
  const parser = spawn('python3', ['scripts/build-peppol-uae-index.py', '--stream-all', '--skip-cards', String(cards), input.path],
    { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'] });
  const parserExit = new Promise((done) => parser.once('close', done));
  const lines = createInterface({ input: parser.stdout, crlfDelay: Infinity });
  const buckets = new Map();
  const batches = [];
  let metadata;
  let footer;
  let version;
  let lastFlush = cards;
  async function flush() {
    for (const bucket of buckets.values()) if (bucket.size) batches.push([...bucket.values()]);
    buckets.clear();
    if (batches.length) await sendBatches(table, batches.splice(0));
    await persistCheckpoint(table, checkpointPath, Boolean(SOURCE_BLOB_URL), { source: input.id, sourceSize: input.size, snapshotAt: metadata.snapshot_at,
      cards, nameRows, countryCounts });
    lastFlush = cards;
    process.stdout.write(`${JSON.stringify({ event: 'peppol_ingest_progress', cards, nameRows })}\n`);
  }
  try {
    for await (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (record._meta) {
        metadata = record._meta;
        if (metadata.schema_version !== 1 || metadata.country !== null || !Number.isFinite(Date.parse(metadata.snapshot_at)))
          throw new Error('peppol_export_metadata_invalid');
        if (checkpoint?.snapshotAt && checkpoint.snapshotAt !== metadata.snapshot_at)
          throw new Error('peppol_ingest_checkpoint_snapshot_mismatch');
        version = hash(metadata.snapshot_at).slice(0, 8);
        continue;
      }
      if (record._footer) { footer = record._footer; continue; }
      if (!metadata || footer) throw new Error('peppol_export_invalid');
      cards += 1;
      const countries = new Set((record.entities || []).map((entity) => entity.country_code || 'XX'));
      for (const country of countries) countryCounts[country] = (countryCounts[country] || 0) + 1;
      const rows = rowsForCard(record, version);
      nameRows += rows.length;
      for (const row of rows) {
        const bucket = buckets.get(row.partitionKey) || new Map();
        bucket.set(row.rowKey, row);
        buckets.set(row.partitionKey, bucket);
        if (bucket.size >= BATCH_SIZE) {
          batches.push([...bucket.values()]);
          buckets.set(row.partitionKey, new Map());
        }
      }
      if (STOP_AFTER_CARDS && cards >= STOP_AFTER_CARDS) {
        await flush();
        parser.kill();
        return;
      }
      if (cards - lastFlush >= FLUSH_EVERY_CARDS) await flush();
    }
    const exitCode = await parserExit;
    if (exitCode !== 0 || !footer || footer.cards !== cards) throw new Error('peppol_export_incomplete');
    await flush();
    await table.upsertEntity({ partitionKey: 'meta', rowKey: 'current', state: 'ready',
      snapshotAt: metadata.snapshot_at, version, cards, nameRows,
      countriesJson: JSON.stringify(Object.entries(countryCounts).filter(([code]) => /^[A-Z]{2}$/.test(code))
        .sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count }))) }, 'Replace');
    process.stdout.write(`${JSON.stringify({ event: 'peppol_ingest_complete', cards, nameRows, version })}\n`);
  } catch (error) {
    parser.kill();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  ingest().catch((error) => { console.error(error); process.exitCode = 1; });
}
