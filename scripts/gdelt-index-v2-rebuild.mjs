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
  processInterval = processGdeltInterval }) {
  if (!v2) throw new Error('gdelt_v2_clients_required');
  if (!sourceState?.coverage_start || !sourceState?.coverage_end) throw new Error('v1_watermark_required');
  if (!Number.isInteger(maxIntervals) || maxIntervals < 1 || maxIntervals > 2000) throw new Error('invalid_rebuild_limit');
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
    const current = explicitRange ? new Date(first.getTime() + processed * INTERVAL_MS)
      : !knownFirst || !knownLast ? first
        : knownFirst > first ? new Date(knownFirst.getTime() - INTERVAL_MS)
          : new Date(knownLast.getTime() + INTERVAL_MS);
    if (current > last || (!explicitRange && knownFirst && knownLast
      && knownFirst <= first && knownLast >= last)) break;
    const timestamp = intervalTimestamp(current);
    await processInterval({ timestamp, container, table, v2, storedOnly: true });
    lastProcessed = current.toISOString();
    if (!explicitRange) {
      const next = { index_version: 2, cursor_version: 2,
        first_completed_interval: knownFirst && knownFirst < current ? knownFirst.toISOString() : current.toISOString(),
        last_completed_interval: knownLast && knownLast > current ? knownLast.toISOString() : current.toISOString(),
        updated_at: new Date().toISOString() };
      const response = await container.getBlockBlobClient(CURSOR_BLOB).uploadData(Buffer.from(JSON.stringify(next)), {
        conditions: cursor.etag ? { ifMatch: cursor.etag } : { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/json' }
      });
      cursor.etag = response.etag;
      cursor.value = next;
    }
    processed += 1;
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
    from: process.env.GDELT_V2_REBUILD_FROM, to: process.env.GDELT_V2_REBUILD_TO });
  process.stdout.write(`${JSON.stringify({ event: 'gdelt_v2_rebuild', ...result })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ event: 'gdelt_v2_rebuild_failed', error: error.message })}\n`);
    process.exitCode = 1; });
}
