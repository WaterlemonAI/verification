const allowed = new Set(['brand_name', 'customer_reference', 'status', 'application_id', 'application_revision', 'secure_link']);
const kinds = ['link', 'receipt', 'accepted', 'rejected', 'restart'];
const defaults = Object.freeze({
  link: { subject: '{{brand_name}} onboarding link', body: 'Complete your supplier application for {{customer_reference}}: {{secure_link}}' },
  receipt: { subject: 'Application received: {{customer_reference}}', body: 'Your application {{application_id}} was received. Your buyer will review it.' },
  accepted: { subject: 'Application accepted: {{customer_reference}}', body: 'Your application {{application_id}} was accepted.' },
  rejected: { subject: 'Application update: {{customer_reference}}', body: 'Your application {{application_id}} was not accepted. Contact your buyer for details.' },
  restart: { subject: 'Changes requested: {{customer_reference}}', body: 'Your buyer requested changes to application {{application_id}}. Use this secure one-time link: {{secure_link}}' }
});
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export function validateEmailTemplates(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !kinds.includes(key)))
    throw new Error('invalid_email_templates');
  for (const [kind, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !['subject', 'body'].includes(key))) throw new Error(`invalid_email_template:${kind}`);
    for (const [field, maximum] of [['subject', 180], ['body', 2000]]) {
      const text = value[field];
      if (typeof text !== 'string' || !text.trim() || text.length > maximum || /[<>\u0000-\u0008\u000e-\u001f]/.test(text))
        throw new Error(`invalid_email_template:${kind}.${field}`);
      for (const match of text.matchAll(/{{([^}]+)}}/g)) if (!allowed.has(match[1])) throw new Error(`unknown_email_variable:${match[1]}`);
      if (text.replace(/{{[^}]+}}/g, '').includes('{{') || text.replace(/{{[^}]+}}/g, '').includes('}}'))
        throw new Error('invalid_email_variable');
    }
    if (['link', 'restart'].includes(kind) && !value.body.includes('{{secure_link}}')) throw new Error('email_link_required');
  }
  return structuredClone(input);
}
export function renderFloEmail(kind, variables, custom = {}) {
  if (!kinds.includes(kind)) throw new Error('invalid_email_kind');
  const template = { ...defaults[kind], ...(custom[kind] || {}) };
  validateEmailTemplates({ [kind]: template });
  const interpolate = (value) => value.replace(/{{([^}]+)}}/g, (_, key) => String(variables[key] ?? ''));
  const subject = interpolate(template.subject).replace(/[\r\n]/g, ' ');
  const text = interpolate(template.body);
  const html = `<!doctype html><html><body><h1>${escape(subject)}</h1><p style="white-space:pre-wrap">${escape(text)}</p></body></html>`;
  return { subject, text, html };
}
export const defaultFloEmailTemplates = () => structuredClone(defaults);
