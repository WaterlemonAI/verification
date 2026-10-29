import { createCaseManagerStore } from '../lib/case-manager-store.mjs';

export async function purgeCases({ store, now = new Date(), maxPerRun = 10_000, batchSize = 250 } = {}) {
  let removed = 0;
  while (removed < maxPerRun) {
    const count = await store.purgeExpired(now, Math.min(batchSize, maxPerRun - removed));
    removed += count;
    if (count < Math.min(batchSize, maxPerRun - removed + count)) break;
  }
  return { removed, limit_reached: removed >= maxPerRun };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.env.CASE_MANAGER_ENABLED !== 'true') process.exit(0);
  const store = createCaseManagerStore();
  try {
    const startedAt = Date.now();
    const oldestExpiredBefore = await store.oldestExpiredAgeSeconds();
    const result = await purgeCases({ store });
    const oldestExpiredAfter = await store.oldestExpiredAgeSeconds();
    const aged = await store.agedPending();
    const oldestPending = await store.oldestPendingAgeSeconds();
    const runMs = Date.now() - startedAt;
    console.info('case_manager_purge_counts', JSON.stringify({ ...result,
      oldest_expired_seconds_before: oldestExpiredBefore, oldest_expired_seconds_after: oldestExpiredAfter,
      oldest_pending_seconds: oldestPending, aged_pending_count: aged, run_ms: runMs,
      throughput_per_second: Math.round(result.removed * 1000 / Math.max(runMs, 1)) }));
    if (result.limit_reached) console.warn('case_manager_expiry_backlog');
    if (oldestExpiredAfter >= 20 * 60 * 60) console.warn('case_manager_expiry_near_deadline',
      JSON.stringify({ oldest_expired_seconds: oldestExpiredAfter }));
    if (oldestExpiredBefore >= 24 * 60 * 60) console.warn('case_manager_expiry_deadline_breached',
      JSON.stringify({ oldest_expired_seconds: oldestExpiredBefore }));
    if (aged) console.warn('case_manager_aged_pending', JSON.stringify({ count: aged }));
  } catch {
    console.warn('case_manager_storage_error');
    process.exitCode = 1;
  }
}
