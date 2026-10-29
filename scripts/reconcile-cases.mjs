import { QueueClient } from '@azure/storage-queue';
import { ContainerAppsManagedIdentityCredential } from '../lib/azure-managed-identity.mjs';
import { createCaseManagerStore } from '../lib/case-manager-store.mjs';
import { createCustomerUsageStore } from '../lib/customer-usage.mjs';
import { createDocumentOcrStore } from '../lib/document-ocr-store.mjs';
import { getBsaResult } from '../lib/bsa-store.mjs';
import { reconcileCaseMessage } from '../lib/case-manager-reconcile.mjs';

export async function drainCaseReconciliation({ queue, deadLetterQueue, caseStore, usageStore,
  documentOcrStore, getBsaResultImpl = getBsaResult, maxMessages = 32 } = {}) {
  const batch = await queue.receiveMessages({ numberOfMessages: Math.min(Math.max(maxMessages, 1), 32), visibilityTimeout: 120 });
  const counts = { captured: 0, pending: 0, retired: 0, dead_lettered: 0, errors: 0 };
  for (const item of batch.receivedMessageItems || []) {
    let message;
    try { message = JSON.parse(Buffer.from(item.messageText, 'base64').toString('utf8')); }
    catch { message = null; }
    if (message?.kind === 'retire' && message.version === 1 && message.workspaceId) {
      try {
        const result = await caseStore.retireWorkspaceCases(message.workspaceId, Number(message.beforeVersion),
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
          await deadLetterQueue.sendMessage(Buffer.from(JSON.stringify({ version: 1, reason: 'retirement_exhausted' })).toString('base64'));
          counts.dead_lettered++;
        }
      }
      await queue.deleteMessage(item.messageId, item.popReceipt);
      continue;
    }
    let outcome = 'invalid';
    try {
      if (message) outcome = await reconcileCaseMessage(message, { caseStore, usageStore, documentOcrStore,
        getBsaResult: getBsaResultImpl });
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
      await deadLetterQueue.sendMessage(Buffer.from(JSON.stringify({ version: 1, caseId: message?.caseId || null,
        reason: outcome })).toString('base64'));
      counts.dead_lettered++;
    } else if (outcome === 'captured') counts.captured++;
    else if (outcome === 'retired' || outcome === 'incomplete') counts.retired++;
    await queue.deleteMessage(item.messageId, item.popReceipt);
  }
  return counts;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.env.CASE_MANAGER_ENABLED !== 'true') process.exit(0);
  const queueUrl = process.env.CASE_MANAGER_QUEUE_URL;
  if (!queueUrl) throw new Error('case_manager_queue_unavailable');
  const credential = new ContainerAppsManagedIdentityCredential();
  const queue = new QueueClient(`${queueUrl.replace(/\/$/, '')}/case-manager-reconcile`, credential);
  const deadLetterQueue = new QueueClient(`${queueUrl.replace(/\/$/, '')}/case-manager-dead-letter`, credential);
  const counts = await drainCaseReconciliation({ queue, deadLetterQueue,
    caseStore: createCaseManagerStore(), usageStore: createCustomerUsageStore(),
    documentOcrStore: createDocumentOcrStore() });
  console.info('case_manager_reconcile_counts', JSON.stringify(counts));
  if (counts.errors) console.warn('case_manager_storage_error', JSON.stringify({ count: counts.errors }));
  if (counts.dead_lettered) console.warn('case_manager_dead_letters', JSON.stringify({ count: counts.dead_lettered }));
}
