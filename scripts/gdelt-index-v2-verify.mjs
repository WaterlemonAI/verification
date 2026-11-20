import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import unzipper from 'unzipper';
import { archiveClients, entityRows, intervalTimestamp, loadArchiveState, parseTimestamp } from './gdelt-ingest.mjs';
import { groupV2Rows, hasAppliedInterval, readV2State, v2Manifest } from '../lib/gdelt-summary-v2.mjs';

const INTERVAL_MS = 15 * 60_000;
const asDate = (value) => /^\d{14}$/.test(String(value)) ? parseTimestamp(String(value)) : new Date(value);

export async function verifyV2Interval(timestamp, { container, summaryTable, manifestTable, v1Table }, { verifySummaries = true } = {}) {
  const rawName = `raw/gkg/${timestamp.slice(0, 4)}/${timestamp.slice(4, 6)}/${timestamp.slice(6, 8)}/${timestamp}.gkg.csv.zip`;
  const raw = await container.getBlobClient(rawName).download();
  const chunks = [];
  for await (const chunk of raw.readableStreamBody) chunks.push(Buffer.from(chunk));
  const zip = Buffer.concat(chunks);
  if (zip.length > 32 * 1024 * 1024) throw new Error(`v2_raw_too_large_${timestamp}`);
  if (raw.metadata?.md5 && createHash('md5').update(zip).digest('hex') !== raw.metadata.md5) throw new Error(`v2_raw_md5_mismatch_${timestamp}`);
  const directory = await unzipper.Open.buffer(zip);
  const entry = directory.files.find((file) => file.type === 'File');
  if (!entry) throw new Error(`v2_raw_empty_${timestamp}`);
  if (Number(entry.vars?.uncompressedSize || 0) > 256 * 1024 * 1024) throw new Error(`v2_entry_too_large_${timestamp}`);
  const parsed = entityRows((await entry.buffer()).toString('utf8'));
  const { grouped, mentions } = groupV2Rows(parsed.byPartition);
  const expected = v2Manifest(timestamp, createHash('sha256').update(zip).digest('hex'), parsed.records, mentions, grouped.size);
  const manifest = await manifestTable.getEntity(expected.partitionKey, expected.rowKey);
  for (const property of ['indexVersion', 'sourceSha256', 'sourceRecords', 'mentionCount', 'entityCount', 'committed']) {
    if (manifest[property] !== expected[property]) throw new Error(`v2_manifest_${property}_mismatch_${timestamp}`);
  }
  if (verifySummaries) {
    let cursor = 0;
    const keys = [...grouped.keys()];
    const workers = Array.from({ length: Math.min(32, keys.length) }, async () => {
      while (cursor < keys.length) {
        const partitionKey = keys[cursor++];
        const summary = await summaryTable.getEntity(partitionKey, 'summary');
        if (summary.indexVersion !== 2 || !hasAppliedInterval(summary, timestamp)) {
          throw new Error(`v2_summary_interval_missing_${timestamp}_${partitionKey}`);
        }
      }
    });
    const settled = await Promise.allSettled(workers);
    const failed = settled.find((item) => item.status === 'rejected');
    if (failed) throw failed.reason;
    if (v1Table) {
      const postings = [...parsed.byPartition.values()].flat();
      const sample = postings.length <= 8 ? postings : [postings[0], postings.at(-1),
        ...Array.from({ length: 6 }, (_, index) => postings[Math.floor((index + 1) * postings.length / 7)])];
      for (const row of sample) {
        const stored = await v1Table.getEntity(row.partitionKey, row.rowKey);
        if (stored.recordId !== row.recordId || stored.url !== row.url) {
          throw new Error(`v2_v1_posting_mismatch_${timestamp}`);
        }
      }
    }
  }
  if (verifySummaries && manifest.verified !== true) {
    const { etag, timestamp: ignored, ...rest } = manifest;
    await manifestTable.updateEntity({ ...rest, partitionKey: expected.partitionKey,
      rowKey: expected.rowKey, verified: true }, 'Replace', { etag });
  }
  return { timestamp, source_records: parsed.records, mentions, entities: grouped.size };
}

export async function verifyV2Range({ container, summaryTable, manifestTable, v1Table, sourceState, v2State,
  maxIntervals = 400, from, to, verifySummaries = true }) {
  if (!sourceState?.coverage_start || !sourceState?.coverage_end || !v2State?.coverage_start || !v2State?.coverage_end) {
    throw new Error('v2_watermarks_required');
  }
  const first = parseTimestamp(intervalTimestamp(asDate(from || sourceState.coverage_start)));
  const last = parseTimestamp(intervalTimestamp(asDate(to || sourceState.coverage_end)));
  if (first < parseTimestamp(v2State.coverage_start) || last > parseTimestamp(v2State.coverage_end) || first > last) {
    throw new Error('v2_verify_outside_committed_range');
  }
  if (!Number.isInteger(maxIntervals) || maxIntervals < 1 || maxIntervals > 50_000) throw new Error('invalid_verify_limit');
  let checked = 0;
  let mentions = 0;
  let current = first;
  while (current <= last && checked < maxIntervals) {
    const result = await verifyV2Interval(intervalTimestamp(current), { container, summaryTable, manifestTable, v1Table }, { verifySummaries });
    checked += 1;
    mentions += result.mentions;
    current = new Date(current.getTime() + INTERVAL_MS);
  }
  return { checked, mentions, more: current <= last, next_interval: current <= last ? intervalTimestamp(current) : null };
}

export async function main() {
  const { container, table, v2 } = archiveClients();
  if (!v2) throw new Error('gdelt_v2_clients_required');
  const { state } = await loadArchiveState(container);
  const { value: v2State } = await readV2State(v2.container);
  const result = await verifyV2Range({ container, summaryTable: v2.summaryTable, manifestTable: v2.manifestTable,
    v1Table: table,
    sourceState: state, v2State, maxIntervals: Number(process.env.GDELT_V2_VERIFY_MAX_INTERVALS || 400),
    from: process.env.GDELT_V2_VERIFY_FROM, to: process.env.GDELT_V2_VERIFY_TO });
  process.stdout.write(`${JSON.stringify({ event: 'gdelt_v2_verify', ...result })}\n`);
  if (result.more) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ event: 'gdelt_v2_verify_failed', error: error.message })}\n`);
    process.exitCode = 1; });
}
