import { randomUUID } from 'node:crypto';
import { lookup, resolveTxt } from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { privateIp } from './callback.mjs';
import { renderFloEmail } from './email-templates.mjs';
import { hashSecret } from './session.mjs';

const smtpHost = (value) => typeof value === 'string' && value.length <= 253
  && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(value) && !value.toLowerCase().endsWith('.local');
const email = (value) => typeof value === 'string' && value.length <= 254
  && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value);
export function validateFloSmtp(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_smtp');
  if (input.enabled === false) return { enabled: false, configured: false };
  if (!smtpHost(input.host) || Number(input.port) !== 465 || !email(input.user) || !email(input.from_email)
    || typeof input.password !== 'string' || !input.password || input.password.length > 512
    || typeof input.from_name !== 'string' || input.from_name.length > 100 || /[\r\n<>]/.test(input.from_name)
    || !/^[A-Za-z0-9_-]{1,63}$/.test(input.dkim_selector || ''))
    throw new Error('invalid_smtp');
  return { enabled: true, configured: true, host: input.host.toLowerCase(), port: 465,
    user: input.user, from_email: input.from_email, from_name: input.from_name.trim(),
    dkim_selector: input.dkim_selector, password: input.password };
}
export function emailEvent(item, kind) {
  return { event_id: randomUUID(), type: 'email_requested', email_type: kind,
    at: new Date().toISOString(), actor: 'flo', application_revision: item.application_revision || 1 };
}
export async function verifyFloSenderDns(meta, resolveText = resolveTxt) {
  const domain = meta.from_email.split('@').at(-1).toLowerCase();
  try {
    const [spf, dmarc, dkim] = await Promise.all([
      resolveText(domain), resolveText(`_dmarc.${domain}`),
      resolveText(`${meta.dkim_selector}._domainkey.${domain}`)
    ]);
    if (![spf, dmarc, dkim].every((rows) => Array.isArray(rows))) throw new Error('flo_sender_domain_unverified');
    const joined = (rows) => rows.map((parts) => parts.join('')).join(' ');
    if (!/\bv=spf1\b/i.test(joined(spf)) || !/\bv=dmarc1\b/i.test(joined(dmarc))
      || !/\bp\s*=\s*[^;\s]+/i.test(joined(dkim))) throw new Error('flo_sender_domain_unverified');
  } catch { throw new Error('flo_sender_domain_unverified'); }
  return true;
}
async function smtpTransport(meta, password, { resolve = lookup, resolveText = resolveTxt,
  transportFactory = nodemailer.createTransport } = {}) {
  await verifyFloSenderDns(meta, resolveText);
  const addresses = await resolve(meta.host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => privateIp(entry.address))) throw new Error('flo_smtp_destination_private');
  return transportFactory({ host: addresses[0].address, port: 465, secure: true,
    auth: { user: meta.user, pass: password }, tls: { servername: meta.host,
      minVersion: 'TLSv1.2', rejectUnauthorized: true }, connectionTimeout: 10000,
    greetingTimeout: 10000, socketTimeout: 15000, disableFileAccess: true, disableUrlAccess: true });
}
export async function sendFloTest({ workspaceId, flowId, to, config, platformStore, mailer,
  resolve, resolveText, transportFactory }) {
  if (!email(to)) throw new Error('invalid_test_recipient');
  const content = renderFloEmail('receipt', { brand_name: config.brand_name || 'KYCProbe',
    customer_reference: 'delivery test', status: 'test', application_id: 'test', application_revision: 0 },
  config.email_templates || {});
  if (config.smtp?.enabled) {
    const password = await platformStore.getFloSmtp(workspaceId, flowId);
    if (!password) throw new Error('flo_smtp_secret_missing');
    const transport = await smtpTransport(config.smtp, password, { resolve, resolveText, transportFactory });
    await transport.sendMail({ from: `${config.smtp.from_name} <${config.smtp.from_email}>`, to, ...content });
  } else if (mailer?.sendFloStatus) await mailer.sendFloStatus({ to, ...content });
  else throw new Error('flo_mailer_unavailable');
}
export async function deliverFloEmail(job, { floStore, platformStore, mailer, resolve, resolveText, transportFactory }) {
  const item = await floStore.getCase(job.workspace_id, job.application_id);
  const event = item?.events.find((entry) => entry.event_id === job.event_id && entry.type === 'email_requested');
  if (!event || item.events.some((entry) => ['email_delivered', 'email_skipped'].includes(entry.type)
    && entry.source_event_id === event.event_id)) return;
  const variables = { brand_name: item.configuration?.brand_name || 'KYCProbe',
    customer_reference: item.customer_reference, status: item.status,
    application_id: item.application_id, application_revision: event.application_revision,
    secure_link: ['link', 'restart'].includes(event.email_type) ? item.notification_links?.[event.event_id] || '' : '' };
  if (['link', 'restart'].includes(event.email_type) && !variables.secure_link) throw new Error('flo_email_link_unavailable');
  if (variables.secure_link) {
    const token = variables.secure_link.split('/').at(-1);
    if (!item.link_hash || item.link_hash !== hashSecret(token) || item.link_redeemed_at) {
      await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
        current.events.push({ event_id: randomUUID(), type: 'email_skipped', source_event_id: event.event_id,
          at: new Date().toISOString(), actor: 'flo_worker', reason_code: 'link_superseded' });
        if (current.notification_links) delete current.notification_links[event.event_id];
        return current;
      });
      return;
    }
  }
  const content = renderFloEmail(event.email_type, variables, item.configuration?.email_templates || {});
  const claimId = randomUUID();
  const claimed = await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
    if (current.events.some((entry) => ['email_delivered', 'email_skipped'].includes(entry.type)
      && entry.source_event_id === event.event_id)) return null;
    if (variables.secure_link && (current.link_hash !== hashSecret(variables.secure_link.split('/').at(-1))
      || current.link_redeemed_at)) return null;
    current.notification_claims ||= {};
    const prior = current.notification_claims[event.event_id];
    if (prior && Date.parse(prior.expires_at) > Date.now()) return null;
    current.notification_claims[event.event_id] = { id: claimId, expires_at: new Date(Date.now() + 60_000).toISOString() };
    return current;
  });
  if (claimed?.notification_claims?.[event.event_id]?.id !== claimId) return;
  let failure = null;
  try {
    if (item.configuration?.smtp?.enabled) {
      const password = await platformStore.getFloSmtp(item.workspace_id, item.flow_id);
      if (!password) throw new Error('flo_smtp_secret_missing');
      const transport = await smtpTransport(item.configuration.smtp, password, { resolve, resolveText, transportFactory });
      await transport.sendMail({ from: `${item.configuration.smtp.from_name} <${item.configuration.smtp.from_email}>`,
        to: item.supplier_email, ...content });
    } else if (mailer?.sendFloStatus) await mailer.sendFloStatus({ to: item.supplier_email, ...content });
    else throw new Error('flo_mailer_unavailable');
  } catch (error) {
    failure = ({ flo_smtp_destination_private: 'destination_private',
      flo_sender_domain_unverified: 'sender_domain_unverified',
      flo_smtp_secret_missing: 'smtp_secret_missing',
      flo_mailer_unavailable: 'platform_mail_unavailable' })[error.message] || 'delivery_failed';
    throw error;
  }
  finally { await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
    current.events.push({ event_id: randomUUID(), type: 'email_attempt', source_event_id: event.event_id,
      at: new Date().toISOString(), actor: 'flo_worker', reason_code: failure });
    if (['link', 'restart'].includes(event.email_type)) current.link_delivery = failure ? 'failed' : 'sent';
    if (failure && current.notification_claims?.[event.event_id]?.id === claimId) delete current.notification_claims[event.event_id];
    return current;
  }); }
  await floStore.updateCase(item.workspace_id, item.application_id, (current) => {
    if (!current.events.some((entry) => entry.type === 'email_delivered' && entry.source_event_id === event.event_id))
      current.events.push({ event_id: randomUUID(), type: 'email_delivered', source_event_id: event.event_id,
        at: new Date().toISOString(), actor: 'flo_worker' });
    if (current.notification_claims?.[event.event_id]?.id === claimId) delete current.notification_claims[event.event_id];
    if (['link', 'restart'].includes(event.email_type) && current.notification_links)
      delete current.notification_links[event.event_id];
    return current;
  });
}

export async function reconcileFloNotifications(workspaceId, { floStore, enqueueEmail, enqueueCallback,
  caseRows = null, maxCases = 200, maxEvents = 50, startIndex = 0 } = {}) {
  if (!enqueueEmail && !enqueueCallback) return { queued: 0, nextIndex: 0 };
  const rows = caseRows || await floStore.listCases(workspaceId);
  const index = Number.isInteger(startIndex) && startIndex >= 0 && startIndex < rows.length ? startIndex : 0;
  const cases = rows.slice(index, index + maxCases);
  let queued = 0;
  for (const row of cases) {
    if (queued >= maxEvents) break;
    const item = await floStore.getCase(workspaceId, row.application_id);
    for (const event of item?.events || []) {
      if (queued >= maxEvents) break;
      const email = event.type === 'email_requested';
      if (!email && (!event.payload || !item.configuration?.callback_url)
        || email && !enqueueEmail || !email && !enqueueCallback) continue;
      if (item.events.some((entry) => entry.source_event_id === event.event_id
        && ['email_delivered', 'email_skipped', 'callback_delivered'].includes(entry.type))) continue;
      if (Date.now() - Date.parse(event.at || 0) < 60_000) continue;
      if (Date.now() - Date.parse(event.requeued_at || 0) < 300_000) continue;
      await floStore.updateCase(workspaceId, item.application_id, (current) => {
        const target = current.events.find((entry) => entry.event_id === event.event_id);
        if (!target) return null;
        target.requeued_at = new Date().toISOString(); return current;
      });
      try { await (email ? enqueueEmail : enqueueCallback)({ workspace_id: workspaceId,
        application_id: item.application_id, job_type: email ? 'email' : 'callback', attempt: 0,
        event_id: event.event_id }); queued++; }
      catch { /* The event remains durable and the next reconciliation can retry it. */ }
    }
  }
  return { queued, nextIndex: index + cases.length < rows.length ? index + cases.length : 0 };
}
