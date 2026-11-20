import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { archiveClients, intervalTimestamp, loadArchiveState, parseTimestamp, processGdeltInterval } from './gdelt-ingest.mjs';

const CURSOR_BLOB = 'state/v2-rebuild.json';
const INTERVAL_MS = 15 * 60_000;
const asDate = (value) => /^\d{14}$/.test(String(value)) ? parseTimestamp(String(value)) : new Date(value);

async function readCursor(container) {
  try {
    const response = await container.getBlobClient(CURSOR_BLOB).download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) chunks.push(Buffer.from(chunk));
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), etag: response.etag };
  } catch (error) { if (error.statusCode === 404) return { value: null, etag: null }; throw error; }
}

export async function rebuildStoredV2({ container, table, v2, sourceState, maxIntervals = 400, from, to,
  processInterval = processGdeltInterval }) {
  if (!v2) throw new Error('gdelt_v2_clients_required');
  if (!sourceState?.coverage_start || !sourceState?.coverage_end) throw new Error('v1_watermark_required');
  if (!Number.isInteger(maxIntervals) || maxIntervals < 1 || maxIntervals > 2000) throw new Error('invalid_rebuild_limit');
  const cursor = await readCursor(container);
  const first = parseTimestamp(intervalTimestamp(asDate(from || sourceState.coverage_start)));
  const last = parseTimestamp(intervalTimestamp(asDate(to || sourceState.coverage_end)));
  if (first < new Date(sourceState.coverage_start) || last > new Date(sourceState.coverage_end) || first > last) {
    throw new Error('v2_rebuild_outside_v1_watermark');
  }
  const resumed = !from && cursor.value?.last_completed_interval
    ? new Date(new Date(cursor.value.last_completed_interval).getTime() + INTERVAL_MS) : first;
  let current = new Date(Math.max(first.getTime(), resumed.getTime()));
  let processed = 0;
  while (current <= last && processed < maxIntervals) {
    const timestamp = intervalTimestamp(current);
    await processInterval({ timestamp, container, table, v2, storedOnly: true });
    const next = { index_version: 2, last_completed_interval: current.toISOString(), updated_at: new Date().toISOString() };
    const response = await container.getBlockBlobClient(CURSOR_BLOB).uploadData(Buffer.from(JSON.stringify(next)), {
      conditions: cursor.etag ? { ifMatch: cursor.etag } : { ifNoneMatch: '*' },
      blobHTTPHeaders: { blobContentType: 'application/json' }
    });
    cursor.etag = response.etag;
    cursor.value = next;
    processed += 1;
    current = new Date(current.getTime() + INTERVAL_MS);
  }
  return { processed, last_completed_interval: cursor.value?.last_completed_interval || null,
    more: current <= last };
}

export async function main() {
  const { container, table, v2 } = archiveClients();
  const { state } = await loadArchiveState(container);
  const result = await rebuildStoredV2({ container, table, v2, sourceState: state,
    maxIntervals: Number(process.env.GDELT_V2_REBUILD_MAX_INTERVALS || 400),
    from: process.env.GDELT_V2_REBUILD_FROM, to: process.env.GDELT_V2_REBUILD_TO });
  process.stdout.write(`${JSON.stringify({ event: 'gdelt_v2_rebuild', ...result })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ event: 'gdelt_v2_rebuild_failed', error: error.message })}\n`);
    process.exitCode = 1; });
}
