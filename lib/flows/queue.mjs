import { QueueClient } from '@azure/storage-queue';
import { ContainerAppsManagedIdentityCredential } from '../azure-managed-identity.mjs';

export class MemoryFloQueue {
  constructor() { this.jobs = []; }
  async enqueue(job) { this.jobs.push(job); }
  async drain(handler) { while (this.jobs.length) await handler(this.jobs.shift()); }
}

export class AzureFloQueue {
  constructor({ queueUrl = process.env.FLO_QUEUE_URL, deadLetterUrl = process.env.FLO_DEAD_LETTER_QUEUE_URL,
    credential = new ContainerAppsManagedIdentityCredential(), client, deadLetterClient } = {}) {
    if (!queueUrl && !client) throw new Error('flo_queue_unavailable');
    this.client = client || new QueueClient(queueUrl, credential);
    this.deadLetterClient = deadLetterClient || (deadLetterUrl ? new QueueClient(deadLetterUrl, credential) : null);
  }
  async enqueue(job) {
    if (!/^[a-f0-9]{16}$/.test(job.workspace_id) || !/^[0-9a-f-]{36}$/.test(job.application_id)
      || !['process', 'preview', 'diagnostic', 'callback', 'email'].includes(job.job_type) || !Number.isInteger(job.attempt) || job.attempt < 0
      || job.attempt > (job.job_type === 'callback' ? 5 : 30))
      throw new Error('invalid_flo_job');
    await this.client.sendMessage(Buffer.from(JSON.stringify(job)).toString('base64'),
      { visibilityTimeout: Math.min(60, Math.max(0, Number(job.delay_seconds || 0))) });
  }
  async poll(handler) {
    const response = await this.client.receiveMessages({ numberOfMessages: 1, visibilityTimeout: 300 });
    for (const message of response.receivedMessageItems || []) {
      let receipt = message.popReceipt;
      let leaseError = null;
      let extending = Promise.resolve();
      const timer = setInterval(() => {
        extending = extending.then(async () => {
          const updated = await this.client.updateMessage(message.messageId, receipt, message.messageText, 300);
          receipt = updated.popReceipt;
        }).catch((error) => { leaseError = error; });
      }, 90_000);
      timer.unref?.();
      try {
        const job = JSON.parse(Buffer.from(message.messageText, 'base64').toString());
        await handler(job);
        clearInterval(timer); await extending;
        if (leaseError) throw leaseError;
        await this.client.deleteMessage(message.messageId, receipt);
      } catch (error) {
        clearInterval(timer); await extending;
        if (message.dequeueCount >= 5) {
          if (!this.deadLetterClient) throw new Error('flo_dead_letter_unavailable');
          await this.deadLetterClient.sendMessage(message.messageText);
          await this.client.deleteMessage(message.messageId, receipt);
          console.warn('flo_job_dead_lettered', JSON.stringify({ message_id: message.messageId }));
        } else console.warn('flo_job_retry', JSON.stringify({ message_id: message.messageId, attempt: message.dequeueCount }));
      }
    }
  }
}

export function createFloQueue() {
  if (process.env.FLO_ENABLED !== 'true') return null;
  return process.env.NODE_ENV === 'test' ? new MemoryFloQueue() : new AzureFloQueue();
}

export function createFloCallbackQueue() {
  if (process.env.FLO_ENABLED !== 'true') return null;
  return process.env.NODE_ENV === 'test' ? new MemoryFloQueue() : new AzureFloQueue({ queueUrl: process.env.FLO_CALLBACK_QUEUE_URL });
}

export function startFloWorker(queue, handler) {
  let stopped = false;
  async function cycle() {
    if (stopped) return;
    try { await queue.poll(handler); } catch { console.warn('flo_queue_poll_failed'); }
    if (!stopped) setTimeout(cycle, 2000).unref?.();
  }
  cycle();
  return () => { stopped = true; };
}
