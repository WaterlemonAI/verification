import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { QueueClient } from '@azure/storage-queue';

const STORAGE_SCOPE = 'https://storage.azure.com/.default';
const POLL_INTERVAL_MS = 5_000;
const INCOMPLETE_RETRY_SECONDS = 15 * 60;
const CALLBACK_RETRY_SECONDS = 5 * 60;

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

export async function validatePublicCallbackUrl(rawUrl) {
  await publicCallbackTarget(rawUrl);
  return true;
}

async function postSignedCallback(job, result) {
  const { url, pinned } = await publicCallbackTarget(job.callback_url);
  const event = {
    event: 'adverse_media.deep_research.completed',
    screening_id: job.screening_id,
    completed_at: new Date().toISOString(),
    data: result
  };
  const body = Buffer.from(JSON.stringify(event));
  const signature = `sha256=${createHmac('sha256', job.callback_secret).update(body).digest('hex')}`;
  await new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: 'POST',
      timeout: 15_000,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': body.length,
        'user-agent': 'AI7UAE-Webhook/1.0',
        'x-ai7-event': event.event,
        'x-ai7-screening-id': job.screening_id,
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
    req.on('timeout', () => req.destroy(new Error('callback_timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

class ContainerAppsManagedIdentityCredential {
  async getToken(scopes) {
    const endpoint = process.env.IDENTITY_ENDPOINT;
    const identityHeader = process.env.IDENTITY_HEADER;
    if (!endpoint || !identityHeader) throw new Error('managed_identity_unavailable');
    const requested = Array.isArray(scopes) ? scopes[0] : scopes;
    const resource = requested === STORAGE_SCOPE ? 'https://storage.azure.com/' : String(requested).replace(/\.default$/, '');
    const url = new URL(endpoint);
    url.searchParams.set('api-version', '2019-08-01');
    url.searchParams.set('resource', resource);
    if (process.env.RUNTIME_IDENTITY_CLIENT_ID) url.searchParams.set('client_id', process.env.RUNTIME_IDENTITY_CLIENT_ID);
    const response = await fetch(url, { headers: { 'x-identity-header': identityHeader, metadata: 'true' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`managed_identity_failed_${response.status}`);
    const payload = await response.json();
    const expires = Number(payload.expires_on);
    return {
      token: payload.access_token,
      expiresOnTimestamp: Number.isFinite(expires) ? expires * 1_000 : Date.now() + 45 * 60 * 1_000
    };
  }
}

export function createDeepResearchQueue(queueUrl = process.env.ADVERSE_MEDIA_QUEUE_URL) {
  if (!queueUrl) return null;
  const client = new QueueClient(queueUrl, new ContainerAppsManagedIdentityCredential());
  return {
    async enqueue(job) {
      await client.sendMessage(JSON.stringify(job), { messageTimeToLive: 7 * 24 * 60 * 60 });
    },
    async receive() {
      const response = await client.receiveMessages({ numberOfMessages: 1, visibilityTimeout: 5 * 60 });
      return response.receivedMessageItems[0] || null;
    },
    async complete(message) {
      await client.deleteMessage(message.messageId, message.popReceipt);
    },
    async release(message, job, visibilityTimeout) {
      await client.updateMessage(message.messageId, message.popReceipt, JSON.stringify(job), visibilityTimeout);
    }
  };
}

export function makeDeepResearchJob(request) {
  return {
    version: 1,
    screening_id: randomUUID(),
    callback_url: request.callback_url,
    callback_secret: randomBytes(32).toString('base64url'),
    request: { ...request, callback_url: '' },
    queued_at: new Date().toISOString()
  };
}

export function startDeepResearchWorker({ queue, store, screen, present = (result) => result, fetchImpl = fetch, deliver = postSignedCallback }) {
  if (!queue) return { stop() {} };
  let stopped = false;
  const run = async () => {
    while (!stopped) {
      try {
        const message = await queue.receive();
        if (!message) { await delay(POLL_INTERVAL_MS); continue; }
        let job;
        try { job = JSON.parse(message.messageText); } catch { await queue.complete(message); continue; }
        try {
          const apiKey = await store.getMasterKey('adverse-media');
          const aiApiKey = await store.getMasterKey('adverse-media-ai');
          if (!apiKey || !aiApiKey) throw new Error('deep_research_credentials_unavailable');
          const result = await screen({ request: job.request, apiKey, aiApiKey, fetchImpl });
          result.screening_id = job.screening_id;
          if (result.status !== 'completed' || result.summary?.decision_eligible !== true) {
            await queue.release(message, job, INCOMPLETE_RETRY_SECONDS);
            continue;
          }
          await deliver(job, present(result));
          await queue.complete(message);
        } catch {
          await queue.release(message, job, CALLBACK_RETRY_SECONDS);
        }
      } catch {
        await delay(POLL_INTERVAL_MS);
      }
    }
  };
  void run();
  return { stop() { stopped = true; } };
}

