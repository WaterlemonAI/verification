import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { callbackEvent, callbackSigningSecret, deliverFloCallback, pinnedLookup } from '../lib/flows/callback.mjs';

process.env.FLO_CALLBACK_SIGNING_KEY_HEX = '44'.repeat(32);

test('pinned callback lookup supports Node single-address and all-address requests', async () => {
  const lookup = pinnedLookup('178.63.67.106', 4);
  const single = await new Promise((resolve, reject) => lookup('webhook.site', { all: false },
    (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(single, { address: '178.63.67.106', family: 4 });
  const all = await new Promise((resolve, reject) => lookup('webhook.site', { all: true },
    (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(all, [{ address: '178.63.67.106', family: 4 }]);
});

test('callback signs exact stable event, records attempts and skips delivered replay', async () => {
  const store = new MemoryFloStore();
  const workspace = '1234567890abcdef';
  const { case: item } = await store.createCase(workspace, { customer_reference: 'REF', supplier_email: 'a@example.com', prefill: {} },
    'idem-12345678', 'a'.repeat(64), { callback_url: 'https://buyer.example/callback' });
  item.gemini_review = { status: 'not_run', reason_codes: ['gemini_unconfigured'] };
  const event = callbackEvent(item, 'submitted', 'supplier');
  assert.equal(event.payload.schema_version, '2.0.0');
  assert.equal(event.payload.ai7edd_review.status, 'not_run');
  assert.equal(event.payload.gemini_review, undefined);
  await store.updateCase(workspace, item.application_id, (current) => { current.events.push(event); return current; });
  let sent = 0;
  const post = async (_url, address, _family, headers, payload) => {
    sent++;
    assert.equal(address, '8.8.8.8');
    const expected = createHmac('sha256', Buffer.from(callbackSigningSecret(workspace), 'hex'))
      .update(`${headers['x-flo-timestamp']}.${payload}`).digest('hex');
    assert.equal(headers['x-flo-signature'], `sha256=${expected}`);
    assert.equal(JSON.parse(payload).event_id, event.event_id);
    return { ok: true, status: 200 };
  };
  const job = { workspace_id: workspace, application_id: item.application_id, event_id: event.event_id };
  await deliverFloCallback(job, { floStore: store, resolve: async () => [{ address: '8.8.8.8', family: 4 }], post });
  await deliverFloCallback(job, { floStore: store, resolve: async () => [{ address: '8.8.8.8', family: 4 }], post });
  assert.equal(sent, 1);
  const saved = await store.getCase(workspace, item.application_id);
  assert.equal(saved.events.filter((row) => row.type === 'callback_attempt').length, 1);
  assert.equal(saved.events.filter((row) => row.type === 'callback_delivered').length, 1);
});

test('retry preserves the original callback payload version', async () => {
  const store = new MemoryFloStore(); const workspace = '1234567890abcdef';
  const { case: item } = await store.createCase(workspace,
    { customer_reference: 'OLD', supplier_email: 'a@example.com', prefill: {} },
    'old-12345678', 'c'.repeat(64), { callback_url: 'https://buyer.example/callback' });
  const event = callbackEvent(item, 'submitted', 'supplier');
  event.payload.schema_version = '1.0.0';
  event.payload.gemini_review = { status: 'not_run' }; delete event.payload.ai7edd_review;
  await store.updateCase(workspace, item.application_id, (current) => { current.events.push(event); return current; });
  let delivered;
  await deliverFloCallback({ workspace_id: workspace, application_id: item.application_id, event_id: event.event_id },
    { floStore: store, resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      post: async (_url, _address, _family, _headers, payload) => {
        delivered = JSON.parse(payload).data; return { ok: true, status: 200 };
      } });
  assert.equal(delivered.schema_version, '1.0.0');
  assert.deepEqual(delivered.gemini_review, { status: 'not_run' });
});

test('callback rejects private resolved addresses before sending', async () => {
  const store = new MemoryFloStore(); const workspace = '1234567890abcdef';
  const { case: item } = await store.createCase(workspace, { customer_reference: 'REF', supplier_email: 'a@example.com', prefill: {} },
    'idem-12345678', 'a'.repeat(64), { callback_url: 'https://buyer.example/callback' });
  const event = callbackEvent(item, 'submitted', 'supplier');
  await store.updateCase(workspace, item.application_id, (current) => { current.events.push(event); return current; });
  await assert.rejects(deliverFloCallback({ workspace_id: workspace, application_id: item.application_id,
    event_id: event.event_id }, { floStore: store, resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    post: async () => { throw new Error('must_not_send'); } }), /private/);
});

test('callback document and report URLs use the staging buyer origin', async () => {
  const previous = process.env.APP_PUBLIC_BASE_URL;
  process.env.APP_PUBLIC_BASE_URL = 'https://app-staging.kycprobe.com';
  try {
    const store = new MemoryFloStore(); const workspace = '1234567890abcdef';
    const { case: item } = await store.createCase(workspace,
      { customer_reference: 'STAGE', supplier_email: 'supplier@example.com', prefill: {} },
      'stage-12345678', 'b'.repeat(64), {});
    item.documents.push({ document_id: 'doc-1', type: 'tradeLicenceFile' });
    item.reports.push({ report_id: 'report-1', version: 1 });
    const payload = callbackEvent(item, 'review_ready', 'flo_worker').payload;
    assert.equal(payload.documents[0].download_url,
      `https://app-staging.kycprobe.com/portal/api/flo/cases/${item.application_id}/documents/doc-1`);
    assert.equal(payload.reports[0].download_url,
      `https://app-staging.kycprobe.com/portal/api/flo/cases/${item.application_id}/reports/1`);
    assert.doesNotMatch(JSON.stringify(payload), /app\.kycprobe\.com\/portal/);
  } finally {
    if (previous === undefined) delete process.env.APP_PUBLIC_BASE_URL;
    else process.env.APP_PUBLIC_BASE_URL = previous;
  }
});

test('callback hides underlying AI model metadata in OCR processing', async () => {
  const store = new MemoryFloStore();
  const { case: item } = await store.createCase('1234567890abcdef',
    { customer_reference: 'BRAND', supplier_email: 'a@example.com', prefill: {} },
    'brand-12345678', 'd'.repeat(64), {});
  item.documents.push({ document_id: 'doc-1', type: 'trade_licence',
    extraction_result: { processing: { ai_model: 'gemini-3.5-flash-lite',
      provider_calls: { azure: 1, gemini: 1 } } } });
  const payload = callbackEvent(item, 'review_ready', 'flo_worker').payload;
  assert.equal(payload.documents[0].extraction_result.processing.ai_model, 'AI7EDD');
  assert.deepEqual(payload.documents[0].extraction_result.processing.provider_calls,
    { azure: 1, ai7edd: 1 });
  assert.doesNotMatch(JSON.stringify(payload), /gemini/i);
});
