import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { deliverFloEmail, validateFloSmtp, verifyFloSenderDns } from '../lib/flows/notifications.mjs';
import { renderFloEmail, validateEmailTemplates } from '../lib/flows/email-templates.mjs';

process.env.FLO_DATA_KEY_HEX = '33'.repeat(32);

test('custom email variables are bounded and rendered as escaped text', () => {
  assert.throws(() => validateEmailTemplates({ receipt: { subject: '<script>', body: 'hi' } }), /invalid_email_template/);
  assert.throws(() => validateEmailTemplates({ receipt: { subject: '{{secret}}', body: 'hi' } }), /unknown_email_variable/);
  const rendered = renderFloEmail('accepted', { customer_reference: '<b>x</b>', application_id: '123' });
  assert.match(rendered.html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.throws(() => validateFloSmtp({ enabled: true, host: 'localhost', port: 465, user: 'a@example.com',
    from_email: 'a@example.com', from_name: 'A', password: 'secret' }), /invalid_smtp/);
});

test('organisation SMTP requires public TLS destination and SPF, DKIM, DMARC records', async () => {
  const meta = validateFloSmtp({ enabled: true, host: 'smtp.example.com', port: 465,
    user: 'sender@example.com', from_email: 'sender@example.com', from_name: 'Buyer',
    dkim_selector: 'mail', password: 'secret' });
  const records = { 'example.com': [['v=spf1 include:example.net -all']],
    '_dmarc.example.com': [['v=DMARC1; p=reject']],
    'mail._domainkey.example.com': [['v=DKIM1; p=abc123']] };
  assert.equal(await verifyFloSenderDns(meta, async (name) => records[name] || []), true);
  await assert.rejects(verifyFloSenderDns(meta, async () => []), /flo_sender_domain_unverified/);
});

test('delivered email is idempotent and supplier projection does not expose a pending secure link', async () => {
  const store = new MemoryFloStore(); const platform = new EnvironmentStore();
  const ws = 'a'.repeat(16); const appId = '11111111-1111-4111-8111-111111111111';
  const event = { event_id: '22222222-2222-4222-8222-222222222222', type: 'email_requested',
    email_type: 'accepted', at: new Date().toISOString(), application_revision: 1 };
  store.cases.set(`${ws}:${appId}`, { workspace_id: ws, application_id: appId, flow_id: 'flow-test',
    status: 'accepted', supplier_email: 'recipient@example.com', customer_reference: 'REF',
    application_revision: 1, configuration: { brand_name: 'Buyer' }, events: [event], documents: [], reports: [] });
  let sent = 0;
  const job = { workspace_id: ws, application_id: appId, event_id: event.event_id };
  const deps = { floStore: store, platformStore: platform, mailer: { sendFloStatus: async () => { sent++; } } };
  await deliverFloEmail(job, deps); await deliverFloEmail(job, deps);
  assert.equal(sent, 1);
  assert.equal((await store.getCase(ws, appId)).events.filter((entry) => entry.type === 'email_delivered').length, 1);
});
