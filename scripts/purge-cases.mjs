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
    const result = await purgeCases({ store });
    console.info('case_manager_purge_counts', JSON.stringify(result));
    if (result.limit_reached) console.warn('case_manager_expiry_backlog');
    const aged = await store.agedPending();
    if (aged) console.warn('case_manager_aged_pending', JSON.stringify({ count: aged }));
  } catch {
    console.warn('case_manager_storage_error');
    process.exitCode = 1;
  }
}
