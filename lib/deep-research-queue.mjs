import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { QueueClient } from '@azure/storage-queue';
import { createScreeningCostGuard } from './screening-cost-guard.mjs';

const STORAGE_SCOPE = 'https://storage.azure.com/.default';
const POLL_INTERVAL_MS = 5_000;
const CALLBACK_RETRY_SECONDS = 5 * 60;
const MAX_SCREENING_ATTEMPTS = 2;
const MAX_FINALIZE_ATTEMPTS = 3;
const MAX_CALLBACK_ATTEMPTS = 5;
const MAX_TOTAL_DEQUEUES = MAX_SCREENING_ATTEMPTS + MAX_FINALIZE_ATTEMPTS + MAX_CALLBACK_ATTEMPTS + 2;

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
    event_id: job.screening_id,
    event: 'adverse_media.deep_research.completed',
    screening_id: job.screening_id,
    completed_at: job.callback_completed_at || new Date().toISOString(),
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
        'x-ai7-event-id': event.event_id,
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

export function createDeepResearchQueue(queueUrl = process.env.ADVERSE_MEDIA_QUEUE_URL,
  deadLetterUrl = process.env.ADVERSE_MEDIA_DEAD_LETTER_QUEUE_URL) {
  if (!queueUrl) return null;
  const credential = new ContainerAppsManagedIdentityCredential();
  const client = new QueueClient(queueUrl, credential);
  const deadLetterClient = deadLetterUrl ? new QueueClient(deadLetterUrl, credential) : null;
  return {
    async enqueue(job) {
      await client.sendMessage(JSON.stringify(job), { messageTimeToLive: 7 * 24 * 60 * 60 });
    },
    async receive() {
      const response = await client.receiveMessages({ numberOfMessages: 1, visibilityTimeout: 15 * 60 });
      return response.receivedMessageItems[0] || null;
    },
    async complete(message) {
      await client.deleteMessage(message.messageId, message.popReceipt);
    },
    async release(message, job, visibilityTimeout) {
      await client.updateMessage(message.messageId, message.popReceipt, JSON.stringify(job), visibilityTimeout);
    },
    async deadLetter(_message, job, reason) {
      if (!deadLetterClient) throw new Error('deep_research_dead_letter_unavailable');
      await deadLetterClient.sendMessage(JSON.stringify({ job, reason, dead_lettered_at: new Date().toISOString() }),
        { messageTimeToLive: 7 * 24 * 60 * 60 });
    }
  };
}

export function makeDeepResearchJob(request, context = {}) {
  return {
    version: 2,
    screening_id: randomUUID(),
    report_id: randomUUID(),
    callback_url: request.callback_url,
    callback_secret: randomBytes(32).toString('base64url'),
    request: { ...request, callback_url: '' },
    owner_id: context.owner_id || '',
    request_origin: context.request_origin || {
      received_at: new Date().toISOString(),
      network_origin: 'Unavailable',
      processing_location: process.env.AZURE_REGION_DISPLAY || 'Microsoft Azure UAE North'
    },
    queued_at: new Date().toISOString()
  };
}

function failureCode(error) {
  const code = String(error?.message || '');
  if (/^callback_failed_[1-5][0-9]{2}$/.test(code)) return code;
  if (['callback_timeout', 'screening_cost_limit', 'deep_research_credentials_unavailable',
    'deep_research_dead_letter_unavailable', 'deep_research_result_store_unavailable',
    'deep_research_state_invalid', 'deep_research_component_store_unavailable',
    'report_service_unavailable', 'search_provider_unavailable'].includes(code)) return code;
  return 'unclassified_failure';
}

export function startDeepResearchWorker({ queue, store, resultStore, screen, present = (result) => result,
  finalize = async ({ response }) => response, fetchImpl = fetch, deliver = postSignedCallback }) {
  if (!queue) return { stop() {} };
  let stopped = false;
  async function log(job, message, stage, failure = '') {
    let providerAttempts = null;
    try { providerAttempts = (await resultStore?.getDeepResearchUsage({ ownerId: job.owner_id, screeningId: job.screening_id }))?.providerCalls || null; }
    catch { /* diagnostics must not expose payloads or interrupt settlement */ }
    console.info('deep_research_job', JSON.stringify({
      screening_id: job.screening_id, queue_message_id: message.messageId,
      dequeue_count: Number(message.dequeueCount || 0), stage, failure_code: failure || null,
      processing_attempts: Number(job.processing_attempts || 0), finalize_attempts: Number(job.finalize_attempts || 0),
      callback_attempts: Number(job.callback_attempts || 0),
      provider_attempts: providerAttempts
    }));
  }

  async function deadLetter(message, job, stage, reason) {
    await queue.deadLetter(message, job, reason);
    await queue.complete(message);
    await log(job, message, stage, reason);
  }

  async function release(message, job, visibilityTimeout) {
    try { await queue.release(message, job, visibilityTimeout); }
    catch (error) {
      await log(job, message, 'queue_release', 'queue_release_failed');
      throw error;
    }
  }

  const run = async () => {
    while (!stopped) {
      try {
        const message = await queue.receive();
        if (!message) { await delay(POLL_INTERVAL_MS); continue; }
        let job;
        try { job = JSON.parse(message.messageText); }
        catch {
          await queue.deadLetter(message, { malformed: true }, 'malformed_job');
          await queue.complete(message);
          continue;
        }
        if (job.version !== 2 || !job.screening_id || !job.owner_id) {
          try { await deadLetter(message, job, 'quarantined', 'legacy_job_requires_review'); }
          catch { await release(message, job, 6 * 60 * 60); }
          continue;
        }
        if (Number(message.dequeueCount || 0) > MAX_TOTAL_DEQUEUES) {
          try { await deadLetter(message, job, 'exhausted', 'dequeue_limit'); }
          catch { await release(message, job, 6 * 60 * 60); }
          continue;
        }
        let stage = 'screening';
        let state = null;
        try {
          if (!resultStore?.getDeepResearchState || !resultStore?.saveDeepResearchState || !resultStore?.reserveDeepResearchCost) {
            throw new Error('deep_research_result_store_unavailable');
          }
          if (!resultStore.getDeepResearchComponent || !resultStore.saveDeepResearchComponent) {
            throw new Error('deep_research_component_store_unavailable');
          }
          state = await resultStore.getDeepResearchState({ ownerId: job.owner_id, screeningId: job.screening_id });
          if (state && !['screening_partial', 'screened', 'finalized', 'delivered'].includes(state.stage)) {
            throw new Error('deep_research_state_invalid');
          }
          let aiApiKey = '';
          const costGuard = createScreeningCostGuard(fetchImpl, { reserve: ({ costMicroUsd, provider, maxMicroUsd }) =>
            resultStore.reserveDeepResearchCost({ ownerId: job.owner_id, screeningId: job.screening_id,
              costMicroUsd, provider, maxMicroUsd }) });
          const checkpoint = {
            get: (componentKey) => resultStore.getDeepResearchComponent({
              ownerId: job.owner_id, screeningId: job.screening_id, componentKey
            }),
            save: (componentKey, value) => resultStore.saveDeepResearchComponent({
              ownerId: job.owner_id, screeningId: job.screening_id, componentKey, value
            })
          };
          if (!state || state.stage === 'screening_partial') {
            job.processing_attempts = Number(job.processing_attempts || 0) + 1;
            const apiKey = await store.getMasterKey('adverse-media');
            aiApiKey = await store.getMasterKey('adverse-media-ai');
            if (!apiKey || !aiApiKey) throw new Error('deep_research_credentials_unavailable');
            const result = await screen({ request: job.request, apiKey, aiApiKey, fetchImpl, costGuard, checkpoint });
            result.screening_id = job.screening_id;
            const retryMissing = result.status === 'partial' && result.coverage
              && job.processing_attempts < MAX_SCREENING_ATTEMPTS;
            state = { stage: retryMissing ? 'screening_partial' : 'screened', response: present(result) };
            await resultStore.saveDeepResearchState({ ownerId: job.owner_id, screeningId: job.screening_id, state });
            await log(job, message, state.stage);
            if (retryMissing) {
              await release(message, job, CALLBACK_RETRY_SECONDS * (2 ** (job.processing_attempts - 1)));
              continue;
            }
          }
          if (state.stage === 'screened') {
            stage = 'finalizing';
            job.finalize_attempts = Number(job.finalize_attempts || 0) + 1;
            if (!aiApiKey) aiApiKey = await store.getMasterKey('adverse-media-ai');
            if (!aiApiKey) throw new Error('deep_research_credentials_unavailable');
            const response = await finalize({ job, response: state.response, aiApiKey, costGuard });
            state = { stage: 'finalized', response, callback_completed_at: new Date().toISOString() };
            await resultStore.saveDeepResearchState({ ownerId: job.owner_id, screeningId: job.screening_id, state });
            await log(job, message, 'finalized');
          }
          if (state.stage === 'finalized') {
            stage = 'callback';
            await deliver({ ...job, callback_completed_at: state.callback_completed_at }, state.response);
            state = { stage: 'delivered', callback_completed_at: state.callback_completed_at,
              report_id: job.report_id, delivered_at: new Date().toISOString() };
            await resultStore.saveDeepResearchState({ ownerId: job.owner_id, screeningId: job.screening_id, state });
            await log(job, message, 'delivered');
          }
          stage = 'queue_complete';
          await queue.complete(message);
          // Keep a small delivered tombstone so late duplicate queue receipts cannot rerun providers.
          try { await resultStore.deleteDeepResearchComponents?.({ ownerId: job.owner_id, screeningId: job.screening_id }); }
          catch { /* component cleanup follows durable queue completion */ }
          await log(job, message, 'completed');
        } catch (error) {
          const code = failureCode(error);
          if (stage === 'callback') job.callback_attempts = Number(job.callback_attempts || 0) + 1;
          await log(job, message, stage, code);
          if (stage === 'screening' && state?.stage === 'screening_partial'
            && Number(job.processing_attempts || 0) >= MAX_SCREENING_ATTEMPTS) {
            await resultStore.saveDeepResearchState({ ownerId: job.owner_id, screeningId: job.screening_id,
              state: { ...state, stage: 'screened' } });
            await release(message, job, 0);
            continue;
          }
          const exhausted = stage === 'callback'
            ? job.callback_attempts >= MAX_CALLBACK_ATTEMPTS
            : stage === 'screening' ? Number(job.processing_attempts || 0) >= MAX_SCREENING_ATTEMPTS
              : stage === 'finalizing' ? Number(job.finalize_attempts || 0) >= MAX_FINALIZE_ATTEMPTS
                : stage === 'queue_complete' && Number(message.dequeueCount || 0) >= MAX_TOTAL_DEQUEUES;
          if (exhausted) {
            try { await deadLetter(message, job, 'exhausted', code); }
            catch { await release(message, job, 6 * 60 * 60); }
          } else {
            const attempt = stage === 'callback' ? job.callback_attempts
              : stage === 'finalizing' ? job.finalize_attempts : Number(job.processing_attempts || 0);
            const retrySeconds = Math.min(6 * 60 * 60, CALLBACK_RETRY_SECONDS * (2 ** Math.max(0, attempt - 1)));
            await release(message, job, retrySeconds);
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

