import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { QueueClient } from '@azure/storage-queue';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';

const POLL_INTERVAL_MS = 5_000;
const MAX_QUEUE_JOB_BYTES = 48 * 1024;
const MAX_EXECUTION_ATTEMPTS = 3;
const MAX_SETTLEMENT_ATTEMPTS = 5;
const MAX_CALLBACK_ATTEMPTS = 5;
const MAX_TOTAL_DEQUEUES = MAX_EXECUTION_ATTEMPTS + MAX_SETTLEMENT_ATTEMPTS + MAX_CALLBACK_ATTEMPTS + 2;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized);
  }
  return true;
}

async function publicCallbackTarget(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('callback_url_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('callback_url_invalid');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('callback_url_not_public');
  return { url, pinned: addresses[0] };
}

export async function validateFormsCallbackUrl(rawUrl) {
  if (!rawUrl) throw new Error('callback_url_required');
  await publicCallbackTarget(rawUrl);
  return true;
}

export async function postFormsCallback(job, result) {
  const { url, pinned } = await publicCallbackTarget(job.callback_url);
  const event = {
    event: 'forms.submission.completed',
    delivery_id: job.delivery_id,
    submission_id: job.submission_id,
    completed_at: result.completed_at,
    data: result
  };
  const body = Buffer.from(JSON.stringify(event));
  const signature = `sha256=${createHmac('sha256', job.callback_secret).update(body).digest('hex')}`;
  await new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'POST',
      timeout: 20_000,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': body.length,
        'user-agent': 'AI7UAE-Webhook/1.0',
        'x-ai7-event': event.event,
        'x-ai7-delivery-id': job.delivery_id,
        'x-ai7-submission-id': job.submission_id,
        'x-ai7-signature': signature
      },
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      }
    }, (response) => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`callback_failed_${response.statusCode}`));
      });
    });
    request.on('timeout', () => request.destroy(new Error('callback_timeout')));
    request.on('error', reject);
    request.end(body);
  });
}

export function createFormsQueue(queueUrl = process.env.FORMS_QUEUE_URL,
  deadLetterUrl = process.env.FORMS_DEAD_LETTER_QUEUE_URL) {
  if (!queueUrl) return null;
  if (!deadLetterUrl) throw new Error('forms_dead_letter_queue_unavailable');
  const credential = new ContainerAppsManagedIdentityCredential();
  const client = new QueueClient(queueUrl, credential);
  const deadLetter = new QueueClient(deadLetterUrl, credential);
  return {
    async enqueue(job) {
      await client.sendMessage(JSON.stringify(job), { messageTimeToLive: 7 * 24 * 60 * 60 });
    },
    async receive() {
      const response = await client.receiveMessages({ numberOfMessages: 1, visibilityTimeout: 10 * 60 });
      return response.receivedMessageItems[0] || null;
    },
    async complete(message) {
      await client.deleteMessage(message.messageId, message.popReceipt);
    },
    async release(message, job, visibilityTimeout) {
      await client.updateMessage(message.messageId, message.popReceipt, JSON.stringify(job), visibilityTimeout);
    },
    async deadLetter(message, job, reason) {
      await deadLetter.sendMessage(JSON.stringify({ job, reason, dead_lettered_at: new Date().toISOString(),
        dequeue_count: message.dequeueCount || 0 }), { messageTimeToLive: formsDeadLetterTtl(job) });
      await client.deleteMessage(message.messageId, message.popReceipt);
    }
  };
}

export function formsDeadLetterTtl(job, now = Date.now()) {
  if (!job.form?.ai_action?.ocr_job_fields?.length) return -1;
  const queuedExpiry = Date.parse(job.queued_at || '') + 30 * 24 * 60 * 60 * 1_000;
  const sourceExpiry = Date.parse(job.ocr_expires_at || '');
  if (!Number.isFinite(queuedExpiry) || !Number.isFinite(sourceExpiry)) return 1;
  const remaining = Math.floor((Math.min(queuedExpiry, sourceExpiry) - now) / 1_000);
  return Math.max(1, Math.min(7 * 24 * 60 * 60, remaining));
}

export function makeFormsJob({ form, submission, ownerId, workspaceId = '', ocrExpiresAt = null,
  origin, billing = null }) {
  const job = {
    version: 1,
    submission_id: randomUUID(),
    report_id: randomUUID(),
    delivery_id: randomUUID(),
    callback_url: submission.callback_url,
    callback_secret: randomBytes(32).toString('base64url'),
    customer_logo_url: submission.customer_logo_url,
    data: submission.data,
    form,
    owner_id: ownerId,
    workspace_id: workspaceId,
    ...(ocrExpiresAt ? { ocr_expires_at: ocrExpiresAt } : {}),
    ...(billing ? { billing } : {}),
    request_origin: origin,
    queued_at: new Date().toISOString(),
    attempts: 0
  };
  if (Buffer.byteLength(JSON.stringify(job)) > MAX_QUEUE_JOB_BYTES) throw new Error('form_submission_too_large');
  return job;
}

export function startFormsWorker({ queue, execute, deliver = postFormsCallback, resultStore = null, onResult = async () => {} }) {
  if (!queue) return { stop() {} };
  let stopped = false;
  const run = async () => {
    while (!stopped) {
      try {
        const message = await queue.receive();
        if (!message) { await delay(POLL_INTERVAL_MS); continue; }
        let job;
        try { job = JSON.parse(message.messageText); } catch { await queue.complete(message); continue; }
        if (job.ocr_expires_at && Date.parse(job.ocr_expires_at) <= Date.now()) {
          await queue.deadLetter(message, job, 'ocr_reference_expired');
          continue;
        }
        let stage = 'execution';
        try {
          if (Number(message.dequeueCount || 0) > MAX_TOTAL_DEQUEUES) {
            await queue.deadLetter(message, job, 'dequeue_limit_exceeded');
            continue;
          }
          let result = job.result_reference && resultStore
            ? await resultStore.getFormResult({ ownerId: job.owner_id, submissionId: job.submission_id })
            : job.result;
          if (job.result_reference && !result) throw new Error('result_checkpoint_missing');
          if (!result) {
            result = await execute(job);
            if (resultStore) {
              await resultStore.saveFormResult({ ownerId: job.owner_id, submissionId: job.submission_id, result });
              job.result_reference = true;
            } else job.result = result;
          }
          stage = 'settlement';
          await onResult(job, result);
          stage = 'callback';
          await deliver(job, result);
          await queue.complete(message);
          if (job.result_reference && resultStore) {
            try { await resultStore.deleteFormResult({ ownerId: job.owner_id, submissionId: job.submission_id }); } catch { /* private retry payload cleanup is best effort after durable completion */ }
          }
        } catch (error) {
          job.stage_attempts ||= {};
          const attempts = job.stage_attempts[stage] = Number(job.stage_attempts[stage] || 0) + 1;
          job.attempts = Number(job.attempts || 0) + 1;
          const limit = stage === 'callback' ? MAX_CALLBACK_ATTEMPTS
            : stage === 'settlement' ? MAX_SETTLEMENT_ATTEMPTS : MAX_EXECUTION_ATTEMPTS;
          const reason = error.message === 'result_checkpoint_missing' ? 'result_checkpoint_missing'
            : /^callback_failed_\d{3}$/.test(error.message) ? error.message
              : stage === 'callback' && error.message === 'callback_timeout' ? 'callback_timeout' : `${stage}_failed`;
          console.warn('forms_job_retry', JSON.stringify({ submission_id: job.submission_id,
            stage, attempts, dequeue_count: message.dequeueCount || 0, reason }));
          if (attempts >= limit || Number(message.dequeueCount || 0) >= MAX_TOTAL_DEQUEUES || reason === 'result_checkpoint_missing') {
            await queue.deadLetter(message, job, reason);
          } else {
            const retrySeconds = Math.min(6 * 60 * 60, 60 * (2 ** Math.min(attempts - 1, 8)));
            await queue.release(message, job, retrySeconds);
          }
        }
      } catch {
        await delay(POLL_INTERVAL_MS);
      }
    }
  };
  void run();
  return { stop() { stopped = true; } };
}

export const formsQueueConfig = Object.freeze({ maximumJobBytes: MAX_QUEUE_JOB_BYTES,
  maximumExecutionAttempts: MAX_EXECUTION_ATTEMPTS, maximumSettlementAttempts: MAX_SETTLEMENT_ATTEMPTS,
  maximumCallbackAttempts: MAX_CALLBACK_ATTEMPTS });
