import { DOCUMENT_OCR_APIS } from './document-ocr-contracts.mjs';

export const CASE_SCHEMA_VERSION = 1;
export const CASE_POLICY_VERSION = 1;
export const CASE_OUTCOMES = Object.freeze([
  'pending', 'passed', 'failed', 'review_required', 'extracted', 'analyzed',
  'not_run', 'could_not_complete', 'unclassified'
]);
export const CASE_REQUEST_STATUSES = Object.freeze(['succeeded', 'failed', 'pending', 'other']);

export function caseRequestStatus(httpStatus) {
  if (!Number.isInteger(httpStatus) || httpStatus <= 0) return 'pending';
  if (httpStatus >= 200 && httpStatus < 300) return 'succeeded';
  if (httpStatus >= 400 && httpStatus < 600) return 'failed';
  return 'other';
}

const DIRECT_SERVICES = Object.freeze([
  { path: '/service/uae_tlv', service: 'uae-tlv', mode: 'synchronous' },
  { path: '/service/iban_verification', service: 'iban-verification', mode: 'synchronous' },
  { path: '/service/entity_search', service: 'entity-search', mode: 'synchronous' },
  { path: '/service/adverse_media', service: 'adverse-media', mode: 'synchronous-or-async' },
  { path: '/service/merchant_screening', service: 'merchant-screening', mode: 'synchronous' },
  { path: '/service/bank_statement_analysis', service: 'bank-statement-analysis', mode: 'asynchronous' },
  { path: '/service/dubai_ejari_verification', service: 'ejari-verification', mode: 'asynchronous', ocr: true },
  ...DOCUMENT_OCR_APIS.map(({ publicPath, id }) => ({ path: publicPath, service: id, mode: 'asynchronous', ocr: true }))
]);

export const CASE_DIRECT_SERVICES = DIRECT_SERVICES;
const BY_PATH = new Map(DIRECT_SERVICES.map((item) => [item.path, item]));

export function classifyCaseSubmission(method, pathname, dynamicIntegration = null) {
  if (method !== 'POST') return null;
  const direct = BY_PATH.get(pathname);
  if (direct) return direct;
  const form = /^\/forms\/([a-z0-9-]+)\/submissions$/.exec(pathname);
  if (form) return { path: pathname, service: 'forms', formId: form[1], mode: 'asynchronous' };
  if (dynamicIntegration?.publicPath === pathname && dynamicIntegration?.method === method && dynamicIntegration?.enabled !== false) {
    return { path: pathname, service: dynamicIntegration.id, mode: 'synchronous', dynamic: true };
  }
  return null;
}

export function effectiveCaseTtlDays(ttlDays, { ocr = false, formHasOcr = false } = {}) {
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 45) throw new RangeError('Case TTL must be an integer from 1 to 45 days.');
  return ocr || formHasOcr ? Math.min(ttlDays, 30) : ttlDays;
}

export function caseExpiresAt(acceptedAt, ttlDays, service = {}) {
  const accepted = new Date(acceptedAt);
  if (!Number.isFinite(accepted.getTime())) throw new TypeError('acceptedAt must be a valid date.');
  return new Date(accepted.getTime() + effectiveCaseTtlDays(ttlDays, service) * 86_400_000).toISOString();
}

export function caseIsReadable(caseRecord, at = new Date()) {
  const now = new Date(at).getTime();
  return Number.isFinite(now) && now < new Date(caseRecord.expires_at).getTime()
    && caseRecord.deleted_at == null;
}

// This describes the encrypted payload. Index entities are deliberately a smaller non-PII projection.
export const CASE_PAYLOAD_SCHEMA = Object.freeze({
  $id: 'https://kycprobe.com/schemas/case-manager/v1',
  type: 'object',
  required: ['schema_version', 'case_id', 'workspace_id', 'service_id', 'accepted_at', 'expires_at', 'state', 'outcome', 'attempt_ids'],
  properties: {
    schema_version: { const: CASE_SCHEMA_VERSION },
    case_id: { type: 'string', format: 'uuid' },
    workspace_id: { type: 'string' },
    service_id: { type: 'string' },
    accepted_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    state: { enum: ['pending', 'complete', 'incomplete', 'deleted'] },
    outcome: { enum: CASE_OUTCOMES },
    outcome_reason_codes: { type: 'array', items: { type: 'string' } },
    attempt_ids: { type: 'array', items: { type: 'string' } },
    original_artifact_owner: { type: ['string', 'null'] },
    source_id: { type: ['string', 'null'] },
    artifact_refs: { type: 'array', items: { type: 'object' } },
    final_response: { type: ['object', 'array', 'string', 'null'] },
    final_content_type: { type: ['string', 'null'] },
    final_http_status: { type: ['integer', 'null'] },
    capture_error_code: { type: ['string', 'null'] }
  },
  additionalProperties: true
});
