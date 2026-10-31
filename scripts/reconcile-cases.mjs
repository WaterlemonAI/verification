import { QueueClient } from '@azure/storage-queue';
import { ContainerAppsManagedIdentityCredential } from '../lib/azure-managed-identity.mjs';
import { createCaseManagerStore } from '../lib/case-manager-store.mjs';
import { createCustomerUsageStore } from '../lib/customer-usage.mjs';
import { createDocumentOcrStore } from '../lib/document-ocr-store.mjs';
import { createEjariStore } from '../lib/ejari-store.mjs';
import { getBsaResult } from '../lib/bsa-store.mjs';
import { reconcileCaseMessage } from '../lib/case-manager-reconcile.mjs';
import { recoverCaseRetirements } from '../lib/case-manager-retirement.mjs';

export async function drainCaseReconciliation({ queue, deadLetterQueue, caseStore, usageStore,
  documentOcrStore, ejariStore, getBsaResultImpl = getBsaResult, reconcileMessageImpl = reconcileCaseMessage,
  maxMessages = 512, maxBatches = 16, maxRunMs = 10 * 60_000 } = {}) {
  const counts = { captured: 0, pending: 0, retired: 0, dead_lettered: 0, errors: 0,
    retirement_recovered: 0, retirement_continuing: 0, retirement_oldest_age_seconds: 0,
    messages_processed: 0,
    batches_received: 0, queue_age_seconds_p95: 0, queue_age_seconds_p99: 0,
    queue_age_seconds_max: 0, stored_finals_recovered: 0, stored_finals_scanned: 0, run_ms: 0 };
  const startedAt = Date.now();
  const queueAges = [];
  for (let batches = 0; batches < maxBatches && counts.messages_processed < maxMessages
    && Date.now() - startedAt < maxRunMs; batches++) {
    let batch;
    try {
      batch = await queue.receiveMessages({ numberOfMessages: Math.min(32, maxMessages - counts.messages_processed),
        visibilityTimeout: 120 });
    } catch { counts.errors++; break; }
    const items = batch.receivedMessageItems || [];
    if (!items.length) break;
    counts.batches_received++;
    for (const item of items) {
      counts.messages_processed++;
      const insertedAt = Date.parse(item.insertedOn || '');
      if (Number.isFinite(insertedAt)) {
        queueAges.push(Math.max(0, Math.round((Date.now() - insertedAt) / 1000)));
      }
      let message;
      try { message = JSON.parse(Buffer.from(item.messageText, 'base64').toString('utf8')); }
      catch { message = null; }
      if (message?.kind === 'retire' && message.version === 1 && message.workspaceId) {
        try {
          const beforeVersion = Number(message.beforeVersion);
          const policy = await usageStore.casePolicy(message.workspaceId);
          if (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1
            || policy.visible_from_version < beforeVersion) throw new Error('case_manager_retirement_policy_mismatch');
          const result = await caseStore.retireWorkspaceCases(message.workspaceId, beforeVersion,
            { cursor: message.cursor || '', limit: 10_000 });
          if (!result.done) {
            await queue.sendMessage(Buffer.from(JSON.stringify({ ...message, cursor: result.cursor })).toString('base64'),
              { messageTimeToLive: 7 * 24 * 60 * 60 });
            counts.pending++;
          } else counts.retired++;
        } catch {
          const attempt = Number(message.attempt || 0) + 1;
          if (attempt < 12) {
            await queue.sendMessage(Buffer.from(JSON.stringify({ ...message, attempt })).toString('base64'),
              { visibilityTimeout: Math.min(6 * 60 * 60, 60 * 2 ** Math.min(attempt - 1, 9)),
                messageTimeToLive: 7 * 24 * 60 * 60 });
            counts.pending++;
          } else {
            await deadLetterQueue.sendMessage(Buffer.from(JSON.stringify({ version: 1, kind: 'retire',
              workspaceId: message.workspaceId, beforeVersion: message.beforeVersion, cursor: message.cursor || '',
              attempt, reason: 'retirement_exhausted' })).toString('base64'));
            counts.dead_lettered++;
          }
        }
        await queue.deleteMessage(item.messageId, item.popReceipt);
        continue;
      }
      let outcome = 'invalid';
      try {
        if (message) outcome = await reconcileMessageImpl(message, { caseStore, usageStore, documentOcrStore,
          ejariStore, getBsaResult: getBsaResultImpl });
      } catch { counts.errors++; outcome = 'pending'; }
      if (outcome === 'pending') {
        const attempt = Number(message?.attempt || 0) + 1;
        if (attempt < 12 && message?.caseId) {
          const retrySeconds = Math.min(6 * 60 * 60, 60 * 2 ** Math.min(attempt - 1, 9));
          await queue.sendMessage(Buffer.from(JSON.stringify({ ...message, attempt })).toString('base64'),
            { visibilityTimeout: retrySeconds, messageTimeToLive: 7 * 24 * 60 * 60 });
          counts.pending++;
        } else outcome = 'exhausted';
      }
      if (outcome === 'invalid' || outcome === 'exhausted') {
        if (message?.workspaceId && message?.caseId) {
          await caseStore.markIncomplete(message.workspaceId, message.caseId, 'RECONCILIATION_EXHAUSTED').catch(() => {});
        }
        await deadLetterQueue.sendMessage(Buffer.from(JSON.stringify({ version: 1, kind: 'reconcile',
          workspaceId: message?.workspaceId || null, caseId: message?.caseId || null,
          serviceId: message?.serviceId || null, sourceId: message?.sourceId || null,
          originalOwner: message?.originalOwner || null, attempt: message?.attempt || 0,
          reason: outcome })).toString('base64'));
        counts.dead_lettered++;
      } else if (outcome === 'captured') counts.captured++;
      else if (outcome === 'retired' || outcome === 'incomplete') counts.retired++;
      await queue.deleteMessage(item.messageId, item.popReceipt);
    }
  }
  try {
    const recovery = await recoverCaseRetirements({ usageStore, caseStore });
    counts.retirement_recovered = recovery.completed;
    counts.retirement_continuing = recovery.continuing;
    counts.retirement_oldest_age_seconds = recovery.oldest_age_seconds;
    counts.errors += recovery.errors;
  } catch { counts.errors++; }
  try {
    const recovery = await caseStore.recoverStoredFinals?.();
    counts.stored_finals_recovered = recovery?.recovered || 0;
    counts.stored_finals_scanned = recovery?.scanned || 0;
    counts.errors += recovery?.errors || 0;
  } catch { counts.errors++; }
  if (queueAges.length) {
    queueAges.sort((a, b) => a - b);
    counts.queue_age_seconds_p95 = queueAges[Math.ceil(queueAges.length * 0.95) - 1];
    counts.queue_age_seconds_p99 = queueAges[Math.ceil(queueAges.length * 0.99) - 1];
    counts.queue_age_seconds_max = queueAges.at(-1);
  }
  counts.run_ms = Date.now() - startedAt;
  return counts;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.env.CASE_MANAGER_ENABLED !== 'true') process.exit(0);
  const queueUrl = process.env.CASE_MANAGER_QUEUE_URL;
  if (!queueUrl) throw new Error('case_manager_queue_unavailable');
  const credential = new ContainerAppsManagedIdentityCredential();
  const queue = new QueueClient(`${queueUrl.replace(/\/$/, '')}/${process.env.CASE_MANAGER_RECONCILE_QUEUE_NAME || 'case-manager-reconcile'}`, credential);
  const deadLetterQueue = new QueueClient(`${queueUrl.replace(/\/$/, '')}/${process.env.CASE_MANAGER_DEAD_LETTER_QUEUE_NAME || 'case-manager-dead-letter'}`, credential);
  const counts = await drainCaseReconciliation({ queue, deadLetterQueue,
    caseStore: createCaseManagerStore(), usageStore: createCustomerUsageStore(),
    documentOcrStore: createDocumentOcrStore(), ejariStore: createEjariStore() });
  console.info('case_manager_reconcile_counts', JSON.stringify(counts));
  if (counts.errors) console.warn('case_manager_storage_error', JSON.stringify({ count: counts.errors }));
  if (counts.dead_lettered) console.warn('case_manager_dead_letters', JSON.stringify({ count: counts.dead_lettered }));
  if (counts.retirement_oldest_age_seconds >= 20 * 60 * 60) console.warn('case_manager_retirement_near_deadline',
    JSON.stringify({ oldest_age_seconds: counts.retirement_oldest_age_seconds }));
  if (counts.retirement_oldest_age_seconds >= 24 * 60 * 60) console.warn('case_manager_retirement_deadline_breached',
    JSON.stringify({ oldest_age_seconds: counts.retirement_oldest_age_seconds }));
}
