import { isIP } from 'node:net';

export const FLOW_ID = 'kys-v1';
export const TEMPLATE_VERSION = '1.0.0';
export const STATUSES = Object.freeze(['link_issued', 'in_progress', 'submitted', 'processing', 'needs_correction', 'pending_review', 'restarted', 'accepted', 'rejected', 'failed', 'link_expired']);
const transitions = {
  link_issued: ['in_progress', 'link_expired'], in_progress: ['submitted', 'link_expired'],
  submitted: ['processing'], processing: ['needs_correction', 'pending_review', 'failed'],
  needs_correction: ['in_progress', 'rejected', 'restarted'], pending_review: ['accepted', 'rejected', 'needs_correction', 'restarted'],
  restarted: ['submitted', 'link_expired', 'restarted'],
  accepted: [], rejected: [], failed: [], link_expired: []
};

export function canTransition(from, to) { return transitions[from]?.includes(to) === true; }

export function caseBucket(item) {
  if (item.status === 'accepted') return 'accepted';
  if (item.status === 'rejected') return 'rejected';
  if (['failed', 'link_expired'].includes(item.status)) return 'expired_failed';
  if (item.status === 'restarted') return 'restarted';
  if (item.status === 'link_issued') return 'open';
  if (item.status === 'in_progress') return 'in_progress';
  return 'processing_review';
}

export function validateRestart(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_restart');
  const comments = text(input.comments, 2000);
  const target = (value) => {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 40 || value.some((entry) => typeof entry !== 'string'
      || !/^[a-z][a-zA-Z0-9_]{1,63}$/.test(entry))) throw new Error('invalid_restart_targets');
    return [...new Set(value)];
  };
  return { comments, fields: target(input.fields), documents: target(input.documents) };
}

function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error('invalid_field');
  return value.trim();
}

export function validateHttpsUrl(value) {
  if (value == null || value === '') return null;
  const raw = text(value, 2048);
  let url;
  try { url = new URL(raw); } catch { throw new Error('invalid_url'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443'
    || isIP(host) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')
    || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new Error('invalid_url');
  return url.href;
}

export function validateFloConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_configuration');
  const enabled = input.enabled === true;
  const callback_url = validateHttpsUrl(input.callback_url);
  const success_url = validateHttpsUrl(input.success_url);
  const failure_url = validateHttpsUrl(input.failure_url);
  const brand_name = input.brand_name ? text(input.brand_name, 100) : 'KYCProbe';
  const support_url = validateHttpsUrl(input.support_url);
  const privacy_url = validateHttpsUrl(input.privacy_url);
  const primary_color = input.primary_color == null || input.primary_color === '' ? '#064b79' : input.primary_color;
  const accent_color = input.accent_color == null || input.accent_color === '' ? '#f1a12a' : input.accent_color;
  if (![primary_color, accent_color].every((value) => /^#[0-9a-fA-F]{6}$/.test(value))) throw new Error('invalid_brand_color');
  return { enabled, callback_url, success_url, failure_url, brand_name,
    support_url, privacy_url, primary_color, accent_color,
    updated_at: new Date().toISOString() };
}

export function validateLinkInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_link_request');
  const customer_reference = text(input.customer_reference, 128);
  const supplier_email = text(input.supplier_email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplier_email)) throw new Error('invalid_supplier_email');
  const prefill = input.prefill == null ? {} : input.prefill;
  if (typeof prefill !== 'object' || Array.isArray(prefill) || JSON.stringify(prefill).length > 8192) throw new Error('invalid_prefill');
  return { customer_reference, supplier_email, prefill };
}

export function validateDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_draft');
  const allowed = ['business_name', 'licence_number', 'company_type', 'activities', 'registered_address', 'operating_address', 'iban', 'website_url', 'stakeholders'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('invalid_draft_field');
  const draft = {};
  for (const key of allowed.filter((item) => item !== 'stakeholders')) {
    if (input[key] != null) draft[key] = text(input[key], 1000);
  }
  if (draft.website_url) draft.website_url = validateHttpsUrl(draft.website_url);
  if (input.stakeholders != null) {
    if (!Array.isArray(input.stakeholders) || input.stakeholders.length > 25) throw new Error('invalid_stakeholders');
    draft.stakeholders = input.stakeholders.map((item) => ({
      name: text(item?.name, 200), role: text(item?.role, 100),
      ownership_percentage: item.ownership_percentage == null ? null : Number(item.ownership_percentage)
    }));
    if (draft.stakeholders.some((item) => item.ownership_percentage != null
      && (!Number.isFinite(item.ownership_percentage) || item.ownership_percentage < 0 || item.ownership_percentage > 100))) throw new Error('invalid_ownership');
  }
  return draft;
}

export function submissionGaps(caseData) {
  const gaps = [];
  for (const key of ['business_name', 'licence_number', 'company_type', 'activities', 'registered_address'])
    if (!caseData.draft?.[key]) gaps.push(key);
  for (const type of ['trade_licence', 'formation_document', 'bank_letter'])
    if (!caseData.documents?.some((doc) => doc.type === type)) gaps.push(type);
  return gaps;
}
