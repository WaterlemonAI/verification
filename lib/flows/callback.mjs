import { createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { validateHttpsUrl } from './contract.mjs';

function privateIp(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
      || a === 100 && b >= 64 && b <= 127 || a === 172 && b >= 16 && b <= 31
      || a === 192 && b === 168 || a === 198 && (b === 18 || b === 19);
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
      || /^fe[89ab]/.test(value) || value.startsWith('::ffff:') && privateIp(value.slice(7));
  }
  return true;
}

export function callbackKey() {
  const raw = process.env.FLO_CALLBACK_SIGNING_KEY_HEX || '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error('flo_callback_signing_unavailable');
  return Buffer.from(raw, 'hex');
}

export function callbackSigningSecret(workspaceId) {
  return createHmac('sha256', callbackKey()).update(workspaceId).digest('hex');
}

function buyerOrigin() {
  const url = new URL(process.env.APP_PUBLIC_BASE_URL || 'https://app.kycprobe.com');
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) throw new Error('flo_buyer_origin_invalid');
  return url.origin;
}

async function pinnedPost(url, address, family, headers, payload) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: 'POST', headers, timeout: 10000,
      lookup: (_host, _options, callback) => callback(null, address, family) }, (response) => {
      response.resume(); response.on('end', () => resolve({ status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300 }));
    });
    request.on('timeout', () => request.destroy(new Error('flo_callback_timeout')));
    request.on('error', reject); request.end(payload);
  });
}

export function callbackEvent(item, type, actor) {
  const origin = buyerOrigin();
  return { event_id: randomUUID(), type, at: new Date().toISOString(), actor,
    status: item.status, payload: {
      schema_version: '1.0.0', application_id: item.application_id, workspace_id: item.workspace_id,
      flow_id: item.flow_id, template_version: item.template_version, definition_hash: item.definition_hash || null,
      customer_reference: item.customer_reference,
      status: item.status, submitted_at: item.submitted_at, supplier_email: item.supplier_email,
      draft: item.draft, documents: item.documents.map((document) => ({ ...document,
        download_url: `${origin}/portal/api/flo/cases/${item.application_id}/documents/${document.document_id}` })),
      facts: item.facts, subjects: item.subjects, checks: item.checks, check_history: item.check_history || [],
      comparisons: item.comparisons, preview_issues: item.preview_issues || [],
      gemini_review: item.gemini_review || null, diagnostic: item.diagnostic || null,
      report_summary: { latest_version: item.reports.at(-1)?.version || null,
        incomplete_checks: item.checks.filter((check) => check.coverage !== 'complete')
          .map((check) => ({ service_id: check.service_id, subject_id: check.subject_id,
            transport: check.transport, coverage: check.coverage, reason_codes: check.reason_codes })) },
      reports: item.reports.map((report) => ({ ...report,
        download_url: `${origin}/portal/api/flo/cases/${item.application_id}/reports/${report.version}` }))
    } };
}

export async function deliverFloCallback(job, { floStore, post = pinnedPost, resolve = lookup }) {
  const item = await floStore.getCase(job.workspace_id, job.application_id);
  if (!item) return;
  const event = item.events.find((candidate) => candidate.event_id === job.event_id);
  if (!event?.payload || !item.configuration?.callback_url) return;
  if (item.events.some((candidate) => candidate.type === 'callback_delivered' && candidate.source_event_id === job.event_id)) return;
  let response;
  let reason = null;
  try {
    const url = new URL(validateHttpsUrl(item.configuration.callback_url));
    const addresses = await resolve(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => privateIp(entry.address))) throw new Error('flo_callback_destination_private');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = JSON.stringify({ event_id: event.event_id, event_type: event.type, created_at: event.at, data: event.payload });
    const secret = Buffer.from(callbackSigningSecret(item.workspace_id), 'hex');
    const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    response = await post(url, addresses[0].address, addresses[0].family,
      { 'content-type': 'application/json', 'x-flo-event-id': event.event_id,
        'x-flo-timestamp': timestamp, 'x-flo-signature': `sha256=${signature}` }, payload);
  } catch (error) {
    reason = error.message === 'flo_callback_destination_private' ? 'destination_private' : 'delivery_failed';
    throw error;
  } finally {
    await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
      current.events.push({ event_id: randomUUID(), type: 'callback_attempt', source_event_id: event.event_id,
        at: new Date().toISOString(), actor: 'flo_worker', http_status: response?.status || null, reason_code: reason });
      return current;
    });
  }
  if (!response.ok) throw new Error('flo_callback_delivery_failed');
  await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
    current.events.push({ event_id: randomUUID(), type: 'callback_delivered', source_event_id: event.event_id,
      at: new Date().toISOString(), actor: 'flo_worker', http_status: response.status });
    return current;
  });
}
