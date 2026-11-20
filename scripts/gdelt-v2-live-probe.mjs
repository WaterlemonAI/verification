// Read-only probe of V2 point lookups. Counts are partial until the V2
// watermark is contiguous across the complete V1 archive.
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { summaryKey, v2Clients, readV2State } from '../lib/gdelt-summary-v2.mjs';
import { archiveClients, loadArchiveState } from './gdelt-ingest.mjs';

export async function probeV2Names(names, { clients = v2Clients() } = {}) {
  if (!clients) throw new Error('gdelt_v2_clients_required');
  const results = [];
  for (const name of names) {
    const started = performance.now();
    const entities = await Promise.all(['person', 'organization'].map(async (kind) => {
      const key = summaryKey(kind, name);
      try { return await clients.summaryTable.getEntity(key.partitionKey, key.rowKey); }
      catch (error) { if (error.statusCode === 404) return null; throw error; }
    }));
    results.push({ name, elapsed_ms: Math.round(performance.now() - started), point_reads: 2,
      matches: entities.filter(Boolean).map((entity) => ({ kind: entity.partitionKey[0] === 'p' ? 'person' : 'organization',
        mention_count: Number(entity.mentionCount), unreviewed_count: Number(entity.unreviewedCount),
        first_interval: entity.firstInterval, last_interval: entity.lastInterval,
        sample_refs: JSON.parse(entity.sampleRefs || '[]').length })) });
  }
  return results;
}

export async function main() {
  if (!process.argv.includes('--isolated-candidate') || !process.env.GDELT_STORAGE_ACCOUNT_URL) {
    throw new Error('isolated_candidate_environment_required');
  }
  const { container } = archiveClients();
  const clients = v2Clients();
  const { state: source } = await loadArchiveState(container);
  const { value: v2 } = await readV2State(clients.container);
  const names = ['DP World', 'Emirates NBD', 'Etihad Airways', 'Emaar Properties',
    'Microsoft', 'Donald Trump', 'Masdar'];
  const results = await probeV2Names(names, { clients });
  process.stdout.write(`${JSON.stringify({ event: 'gdelt_v2_live_probe',
    source_window: [source?.coverage_start, source?.coverage_end],
    v2_window: [v2?.coverage_start, v2?.coverage_end], results })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ event: 'gdelt_v2_live_probe_failed',
    error: error.message })}\n`); process.exitCode = 1; });
}
