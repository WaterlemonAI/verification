import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { archiveClients, intervalTimestamp, loadArchiveState, parseTimestamp, processGdeltInterval } from './gdelt-ingest.mjs';
import { v2Clients } from '../lib/gdelt-summary-v2.mjs';

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
  concurrency = 1, processInterval = processGdeltInterval }) {
  if (!v2) throw new Error('gdelt_v2_clients_required');
  if (!sourceState?.coverage_start || !sourceState?.coverage_end) throw new Error('v1_watermark_required');
  if (!Number.isInteger(maxIntervals) || maxIntervals < 1 || maxIntervals > 2000) throw new Error('invalid_rebuild_limit');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('invalid_rebuild_concurrency');
  const explicitRange = Boolean(from || to);
  const cursor = explicitRange ? { value: null, etag: null } : await readCursor(container);
  const first = parseTimestamp(intervalTimestamp(asDate(from || sourceState.coverage_start)));
  const last = parseTimestamp(intervalTimestamp(asDate(to || sourceState.coverage_end)));
  if (first < new Date(sourceState.coverage_start) || last > new Date(sourceState.coverage_end) || first > last) {
    throw new Error('v2_rebuild_outside_v1_watermark');
  }
  let processed = 0;
  let lastProcessed = null;
  while (processed < maxIntervals) {
    // Older rebuild cursors tracked only the high end, so a manual single-
    // interval replay could make them look as if the whole archive was done.
    // Ignore them until a contiguous cursor has been written by this version.
    const previous = cursor.value?.cursor_version === 2 ? cursor.value : null;
    const knownFirst = previous?.first_completed_interval && new Date(previous.first_completed_interval);
    const knownLast = previous?.last_completed_interval && new Date(previous.last_completed_interval);
    // An old cursor lacks first_completed_interval. Replaying from the source
    // start is safe because each interval is idempotent, and repairs that cursor.
    const backwards = !explicitRange && knownFirst && knownFirst > first;
    const current = explicitRange ? new Date(first.getTime() + processed * INTERVAL_MS)
      : !knownFirst || !knownLast ? first
        : backwards ? new Date(knownFirst.getTime() - INTERVAL_MS)
          : new Date(knownLast.getTime() + INTERVAL_MS);
    if (current > last || current < first || (!explicitRange && knownFirst && knownLast
      && knownFirst <= first && knownLast >= last)) break;
    // Commit the cursor only after every interval in this bounded group has
    // passed its raw/V1/V2 verification. A partial group safely replays from
    // the last cursor because each summary records applied intervals.
    const size = backwards ? 1 : Math.min(concurrency, maxIntervals - processed,
      Math.floor((last.getTime() - current.getTime()) / INTERVAL_MS) + 1);
    const batch = Array.from({ length: size }, (_, index) => new Date(current.getTime()
      + (backwards ? -index : index) * INTERVAL_MS));
    const settled = await Promise.allSettled(batch.map((interval) => processInterval({
      timestamp: intervalTimestamp(interval), container, table, v2, storedOnly: true
    })));
    const failed = settled.find((item) => item.status === 'rejected');
    if (failed) throw failed.reason;
    lastProcessed = batch.at(-1).toISOString();
    if (!explicitRange) {
      const low = batch[0] < batch.at(-1) ? batch[0] : batch.at(-1);
      const high = batch[0] > batch.at(-1) ? batch[0] : batch.at(-1);
      const next = { index_version: 2, cursor_version: 2,
        first_completed_interval: knownFirst && knownFirst < low ? knownFirst.toISOString() : low.toISOString(),
        last_completed_interval: knownLast && knownLast > high ? knownLast.toISOString() : high.toISOString(),
        updated_at: new Date().toISOString() };
      const response = await container.getBlockBlobClient(CURSOR_BLOB).uploadData(Buffer.from(JSON.stringify(next)), {
        conditions: cursor.etag ? { ifMatch: cursor.etag } : { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/json' }
      });
      cursor.etag = response.etag;
      cursor.value = next;
    }
    processed += size;
  }
  const trusted = cursor.value?.cursor_version === 2 ? cursor.value : null;
  const knownFirst = trusted?.first_completed_interval && new Date(trusted.first_completed_interval);
  const knownLast = trusted?.last_completed_interval && new Date(trusted.last_completed_interval);
  return { processed, first_completed_interval: trusted?.first_completed_interval || null,
    last_completed_interval: explicitRange ? lastProcessed : trusted?.last_completed_interval || null,
    more: explicitRange ? first.getTime() + processed * INTERVAL_MS <= last.getTime()
      : !knownFirst || !knownLast || knownFirst > first || knownLast < last };
}

export async function main() {
  const { container, table } = archiveClients();
  const v2 = v2Clients();
  const { state } = await loadArchiveState(container);
  const result = await rebuildStoredV2({ container, table, v2, sourceState: state,
    maxIntervals: Number(process.env.GDELT_V2_REBUILD_MAX_INTERVALS || 400),
    concurrency: Number(process.env.GDELT_V2_REBUILD_CONCURRENCY || 1),
    from: process.env.GDELT_V2_REBUILD_FROM, to: process.env.GDELT_V2_REBUILD_TO });
  process.stdout.write(`${JSON.stringify({ event: 'gdelt_v2_rebuild', ...result })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ event: 'gdelt_v2_rebuild_failed', error: error.message })}\n`);
    process.exitCode = 1; });
}
