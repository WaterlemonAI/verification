// Read-only release gate: compare complete V1 postings with V2 point counts.
// Run only in the approved isolated candidate with a controlled subject list.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { archiveClients, loadArchiveState } from './gdelt-ingest.mjs';
import { normalizedGdeltName, readV2State, summaryKey, v2Clients } from '../lib/gdelt-summary-v2.mjs';
import { pageLocalGdeltMentions } from '../lib/gdelt-local-index.mjs';

const INTERVAL_MS = 15 * 60_000;
const MAX_PAGES_PER_SUBJECT = 10_000;
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const compactTime = (value) => {
  if (!/^\d{14}$/.test(String(value))) throw new Error('invalid_v2_watermark');
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid_v2_watermark');
  return date.getTime();
};

function validateWindows(source, snapshot, now) {
  const sourceStart = Date.parse(source?.coverage_start || '');
  const sourceEnd = Date.parse(source?.coverage_end || '');
  const v2Start = compactTime(snapshot?.coverage_start);
  const v2End = compactTime(snapshot?.coverage_end);
  if (snapshot.index_version !== 2 || !Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd)
    || sourceStart > sourceEnd || v2Start > sourceStart || v2End < sourceEnd
    || Number(snapshot.committed_intervals) !== (v2End - v2Start) / INTERVAL_MS + 1
    || now - sourceEnd > 36 * 60 * 60_000 || sourceEnd > now + INTERVAL_MS) {
    throw new Error('v2_snapshot_does_not_cover_fresh_v1');
  }
}

export async function countV1(subject, state, table) {
  const request = { name: subject.name, entity_type: subject.entity_type, aliases: subject.aliases || [] };
  let cursor = null;
  let count = 0;
  let pages = 0;
  do {
    if (++pages > MAX_PAGES_PER_SUBJECT) throw new Error('v1_parity_page_limit');
    const page = await pageLocalGdeltMentions(request, { state, cursor, pageSize: 500, table });
    count += page.rows.length;
    cursor = page.done ? null : page.nextCursor;
    if (page.done) return { count, pages };
  } while (cursor);
  throw new Error('v1_parity_cursor_missing');
}

export async function countV2(subject, snapshot, table) {
  let count = 0;
  for (const name of [...new Set([subject.name, ...(subject.aliases || [])].map(normalizedGdeltName))]) {
    for (const kind of ['person', 'organization']) {
      const key = summaryKey(kind, name);
      let row;
      try { row = await table.getEntity(key.partitionKey, key.rowKey); }
      catch (error) { if (error.statusCode === 404) continue; throw error; }
      if (row.indexVersion !== 2 || !Number.isSafeInteger(Number(row.mentionCount))
        || Number(row.mentionCount) < 1 || row.firstInterval < snapshot.coverage_start
        || row.lastInterval > snapshot.coverage_end) throw new Error('invalid_v2_parity_summary');
      count += Number(row.mentionCount);
    }
  }
  return count;
}

export async function compareV2Parity(subjects, { sourceState, v2State, v1Table, summaryTable,
  minimumSubjects = 50, clock = () => Date.now(), countV1Impl = countV1, countV2Impl = countV2 } = {}) {
  if (!Array.isArray(subjects) || subjects.length < minimumSubjects) throw new Error('at_least_50_controlled_subjects_required');
  validateWindows(sourceState, v2State, clock());
  const seen = new Set();
  const results = [];
  for (const input of subjects) {
    const subject = typeof input === 'string' ? { name: input, entity_type: 'business' } : input;
    if (!['business', 'individual'].includes(subject?.entity_type)
      || normalizedGdeltName(subject.name).length < 2
      || (subject.aliases !== undefined && (!Array.isArray(subject.aliases) || subject.aliases.length > 10
        || subject.aliases.some((alias) => normalizedGdeltName(alias).length < 2)))) {
      throw new Error('invalid_parity_subject');
    }
    const key = `${subject.entity_type}:${[...new Set([subject.name, ...(subject.aliases || [])]
      .map(normalizedGdeltName))].sort().join('|')}`;
    if (seen.has(key)) throw new Error('duplicate_parity_subject');
    seen.add(key);
    const started = performance.now();
    const v1 = await countV1Impl(subject, sourceState, v1Table);
    const v1Ms = Math.round(performance.now() - started);
    const v2Started = performance.now();
    const v2 = await countV2Impl(subject, v2State, summaryTable);
    const v2Ms = Math.round(performance.now() - v2Started);
    results.push({ subject_hash: digest(key), v1_count: v1.count, v2_count: v2,
      v1_pages: v1.pages, v1_ms: v1Ms, v2_ms: v2Ms, match: v1.count === v2 });
  }
  const sorted = results.map((item) => item.v2_ms).sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
  return { source_window: [sourceState.coverage_start, sourceState.coverage_end],
    v2_window: [v2State.coverage_start, v2State.coverage_end],
    checked: results.length, mismatches: results.filter((item) => !item.match).length,
    v2_p50_ms: percentile(0.5), v2_p90_ms: percentile(0.9),
    v2_p95_ms: percentile(0.95), v2_p99_ms: percentile(0.99),
    results };
}

export async function main() {
  const fileIndex = process.argv.indexOf('--subjects-file');
  if (!process.argv.includes('--isolated-candidate') || fileIndex < 0 || !process.argv[fileIndex + 1]
    || !process.env.GDELT_STORAGE_ACCOUNT_URL) throw new Error('isolated_candidate_and_subjects_file_required');
  const subjects = JSON.parse(await readFile(resolve(process.argv[fileIndex + 1]), 'utf8'));
  const { container, table } = archiveClients();
  const v2 = v2Clients();
  const { state: sourceState } = await loadArchiveState(container);
  const { value: v2State } = await readV2State(v2.container);
  const result = await compareV2Parity(subjects, { sourceState, v2State, v1Table: table, summaryTable: v2.summaryTable });
  process.stdout.write(`${JSON.stringify({ event: 'gdelt_v2_parity', ...result })}\n`);
  if (result.mismatches) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ event: 'gdelt_v2_parity_failed', error: error.message })}\n`);
    process.exitCode = 1; });
}
