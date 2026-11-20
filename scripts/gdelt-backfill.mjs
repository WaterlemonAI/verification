import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { archiveClients, intervalTimestamp, loadArchiveState, parseTimestamp,
  processGdeltInterval, saveArchiveState } from './gdelt-ingest.mjs';

const INTERVAL_MS = 15 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TARGET_DAYS = 365;
const STOP_RESERVE_MS = 90_000;
const ABORT_RESERVE_MS = 10_000;

// Azure Container Apps evaluates cron in UTC. Saturday 18:00–20:00 UTC is
// Saturday 22:00–Sunday 00:00 in the UAE throughout the year.
export function weekendWindow(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime()) || date.getUTCDay() !== 6) return null;
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 18);
  const deadline = start + 2 * 60 * 60 * 1_000;
  return date.getTime() >= start && date.getTime() < deadline
    ? { start, deadline } : null;
}

export function nextBackfillInterval(state, now, targetDays = DEFAULT_TARGET_DAYS) {
  if (!Number.isInteger(targetDays) || targetDays < 1 || targetDays > 3660) throw new Error('invalid_backfill_target_days');
  if (!state?.coverage_start || !state?.coverage_end) throw new Error('archive_watermark_required');
  const coverageStart = parseTimestamp(intervalTimestamp(new Date(state.coverage_start)));
  if (coverageStart.toISOString() !== state.coverage_start) throw new Error('invalid_archive_coverage_start');
  const target = parseTimestamp(intervalTimestamp(new Date(new Date(now).getTime() - targetDays * DAY_MS)));
  const next = new Date(coverageStart.getTime() - INTERVAL_MS);
  return next >= target ? intervalTimestamp(next) : null;
}

export function advanceBackfillState(state, timestamp, parsed, completedAt = new Date()) {
  if (!state?.coverage_start) throw new Error('archive_watermark_required');
  const expected = intervalTimestamp(new Date(new Date(state.coverage_start).getTime() - INTERVAL_MS));
  if (expected !== timestamp) throw new Error('backfill_interval_not_contiguous');
  const completed = new Date(completedAt).toISOString();
  return {
    ...state,
    coverage_start: parseTimestamp(timestamp).toISOString(),
    files_processed: Number(state.files_processed || 0) + 1,
    entity_mentions_indexed: Number(state.entity_mentions_indexed || 0) + parsed.mentions,
    backfill: {
      ...state.backfill,
      last_completed_interval: parseTimestamp(timestamp).toISOString(),
      last_completed_at: completed,
      files_processed_total: Number(state.backfill?.files_processed_total || 0) + 1,
      source_records_total: Number(state.backfill?.source_records_total || 0) + parsed.records,
      entity_mentions_indexed_total: Number(state.backfill?.entity_mentions_indexed_total || 0) + parsed.mentions
    }
  };
}

export async function runBackfill({ state: initialState, processInterval, saveState,
  clock = () => new Date(), signal, targetDays = DEFAULT_TARGET_DAYS,
  stopReserveMs = STOP_RESERVE_MS }) {
  const window = weekendWindow(clock());
  if (!window) return { status: 'outside_window', files_processed: 0 };
  let state = initialState;
  let filesProcessed = 0;
  let sourceRecords = 0;
  let entityMentions = 0;
  while (new Date(clock()).getTime() < window.deadline - stopReserveMs) {
    if (signal?.aborted) break;
    const timestamp = nextBackfillInterval(state, clock(), targetDays);
    if (!timestamp) break;
    let parsed;
    try {
      parsed = await processInterval(timestamp, signal);
      const nextState = advanceBackfillState(state, timestamp, parsed, clock());
      await saveState(nextState, signal);
      state = nextState;
    } catch (error) {
      // A partially written file has no watermark advancement. Its deterministic
      // RowKeys make next Saturday's replay safe.
      if (signal?.aborted && new Date(clock()).getTime() >= window.deadline - ABORT_RESERVE_MS) break;
      throw error;
    }
    filesProcessed += 1;
    sourceRecords += parsed.records;
    entityMentions += parsed.mentions;
    if (filesProcessed % 25 === 0) {
      process.stdout.write(`${JSON.stringify({ event: 'gdelt_backfill_progress', files_processed: filesProcessed,
        coverage_start: state.coverage_start, source_records: sourceRecords,
        entity_mentions_indexed: entityMentions })}\n`);
    }
  }
  return {
    status: nextBackfillInterval(state, clock(), targetDays) ? 'window_closed' : 'target_reached',
    files_processed: filesProcessed,
    source_records: sourceRecords,
    entity_mentions_indexed: entityMentions,
    coverage_start: state.coverage_start,
    coverage_end: state.coverage_end,
    deadline: new Date(window.deadline).toISOString()
  };
}

export async function main() {
  const window = weekendWindow(new Date());
  if (!window) throw new Error('backfill_outside_saturday_22_00_to_midnight_uae');
  const targetDays = Number(process.env.GDELT_BACKFILL_TARGET_DAYS || DEFAULT_TARGET_DAYS);
  const { container, table } = archiveClients();
  const loaded = await loadArchiveState(container);
  let etag = loaded.etag;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('backfill_window_closed')),
    Math.max(0, window.deadline - ABORT_RESERVE_MS - Date.now()));
  try {
    const result = await runBackfill({ state: loaded.state, targetDays, signal: controller.signal,
      processInterval: (timestamp, signal) => processGdeltInterval({ timestamp, container, table, signal }),
      saveState: async (state, signal) => { etag = await saveArchiveState(container, state, etag, signal); } });
    process.stdout.write(`${JSON.stringify({ event: 'gdelt_backfill_completed', ...result })}\n`);
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'gdelt_backfill_failed', error: error.message })}\n`);
    process.exitCode = 1;
  });
}
