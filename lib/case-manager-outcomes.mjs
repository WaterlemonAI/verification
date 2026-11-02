import { DOCUMENT_OCR_BY_ID } from './document-ocr-contracts.mjs';

const result = (outcome, reasonCodes = []) => ({ outcome, reasonCodes });
const normalized = (value) => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
const negativeLicenceStatuses = new Set(['expired', 'cancelled', 'canceled', 'revoked', 'suspended', 'inactive', 'closed']);
const negativeMatchValues = new Set(['mismatch', 'no match', 'not matched']);

function tradeLicenceOutcome(response) {
  const licence = response.uae_tl_verification || response.trade_licence_verification_api;
  if (!licence || typeof licence !== 'object' || normalized(response.status) !== 'success') {
    return result('unclassified', ['LICENCE_RESULT_UNKNOWN']);
  }
  const status = normalized(licence.license_status);
  if (negativeLicenceStatuses.has(status)) return result('failed', ['LICENCE_NOT_ACTIVE']);
  if (status !== 'active') return result('review_required', ['LICENCE_STATUS_UNKNOWN']);
  if (licence.moec_status && normalized(licence.moec_status) !== 'active') {
    return result('review_required', ['LICENCE_STATUS_CONFLICT']);
  }
  if (!String(licence.uae_licence_number || licence.license_number || '').trim()
    || !String(licence.licence_registration_name || licence.company_name || '').trim()) {
    return result('review_required', ['LICENCE_IDENTITY_INCOMPLETE']);
  }
  if (licence.expiration_date) {
    const date = String(licence.expiration_date);
    if (!/^\d{4}-\d\d-\d\d$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
      return result('review_required', ['LICENCE_EXPIRY_UNKNOWN']);
    }
    if (Date.parse(`${date}T23:59:59.999Z`) < Date.now()) return result('review_required', ['LICENCE_STATUS_CONFLICT']);
  }
  return result('passed', ['LICENCE_ACTIVE']);
}

function ibanOutcome(response) {
  if (response.status === 0) return result('could_not_complete', ['IBAN_PROVIDER_NOT_SUCCESSFUL']);
  if (response.status !== 1) return result('unclassified', ['IBAN_PROVIDER_STATUS_UNKNOWN']);
  const checks = response.data?.results;
  if (!checks || typeof checks !== 'object') return result('review_required', ['IBAN_MATCH_UNKNOWN']);
  const overall = normalized(checks.result);
  const components = [checks.bank, checks.bankCode, checks.completeName, checks.bankAccountNumber].map(normalized);
  if (['no match', 'not matched', 'account owner mismatch', 'bank account number mismatch'].includes(overall)
    || components.some((value) => negativeMatchValues.has(value))) return result('failed', ['IBAN_MISMATCH']);
  if (!['full bank and account owner match', 'full match'].includes(overall)) {
    return result('review_required', ['IBAN_MATCH_UNKNOWN']);
  }
  if (normalized(checks.completeName) !== 'match' || normalized(checks.bankAccountNumber) !== 'match'
    || components.some((value) => value && value !== 'match')) {
    return result('review_required', ['IBAN_MATCH_INCOMPLETE']);
  }
  return result('passed', ['IBAN_FULL_OWNER_ACCOUNT_MATCH']);
}

function entitySearchOutcome(response) {
  if (normalized(response.message) !== 'search successful') {
    return result('review_required', ['ENTITY_SEARCH_INCOMPLETE']);
  }
  const data = response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return result('review_required', ['ENTITY_SEARCH_RESULT_UNKNOWN']);
  }
  const known = new Set(['profiles', 'aml', 'russiabridge', 'apc']);
  const groups = Object.keys(data);
  if (!groups.length || groups.some((key) => !known.has(key))) {
    return result('review_required', ['ENTITY_SEARCH_RESULT_UNKNOWN']);
  }
  if ((Object.hasOwn(data, 'profiles') && (response.profiles_success !== true || !Array.isArray(data.profiles)))
    || (Object.hasOwn(data, 'apc') && response.apc_success !== true)) {
    return result('review_required', ['ENTITY_SEARCH_INCOMPLETE']);
  }
  const noRecords = Object.values(data).every((value) => Array.isArray(value) ? value.length === 0
    : value && typeof value === 'object' && Object.keys(value).length === 0);
  return noRecords ? result('passed', ['ENTITY_SEARCH_NO_CANDIDATES'])
    : result('review_required', ['ENTITY_SEARCH_CANDIDATES']);
}

function formOutcome(response) {
  if (response.status === 'failed') return result('could_not_complete', ['FORM_FAILED']);
  if (response.status !== 'completed' || response.summary?.decision_eligible !== true
    || !Array.isArray(response.services) || response.services.length === 0
    || response.summary.total !== response.services.length) {
    return result('review_required', ['FORM_REVIEW_REQUIRED']);
  }
  const outcomes = response.services.map((service) => {
    if (service.transport?.completed !== true || service.coverage?.complete !== true
      || service.eligibility?.decision_eligible !== true) return 'review_required';
    const serviceId = service.service_id === 'uae-trade-licence' ? 'uae-tlv' : service.service_id;
    if (serviceId === 'forms') return 'review_required';
    return caseOutcome(serviceId, service.response, { httpStatus: service.http_status }).outcome;
  });
  if (outcomes.includes('failed')) return result('failed', ['FORM_CHILD_FAILED']);
  if (outcomes.every((outcome) => outcome === 'passed')) return result('passed', ['FORM_ALL_CHECKS_PASSED']);
  return result('review_required', ['FORM_CHILD_REVIEW_REQUIRED']);
}

export function caseOutcome(serviceId, response, { httpStatus = 0, final = true } = {}) {
  if (!final || httpStatus === 202) return result('pending');
  if (serviceId === 'ejari-verification') {
    if (response?.status === 'verified') return result('passed', ['DLD_CERTIFICATE_FIELDS_MATCH']);
    if (response?.status === 'not_found') return result('failed', ['DLD_NO_RECORD']);
    if (response?.status === 'review_required') return result('review_required', response.reasonCodes || []);
    if (response?.status === 'could_not_complete') return result('could_not_complete', response.reasonCodes || []);
  }
  if (DOCUMENT_OCR_BY_ID.has(serviceId) && (response?.status === 'failed' || response?.job?.status === 'failed')) {
    return result('could_not_complete', ['OCR_FAILED']);
  }
  if (serviceId === 'bank-statement-analysis' && (response?.status === 'failed' || response?.job?.status === 'failed')) {
    return result('could_not_complete', ['BSA_FAILED']);
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return result(httpStatus >= 400 && httpStatus < 500 && ![408, 429].includes(httpStatus)
      ? 'not_run' : 'could_not_complete', ['HTTP_ERROR']);
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) return result('unclassified', ['NON_JSON_RESPONSE']);
  if (DOCUMENT_OCR_BY_ID.has(serviceId)) {
    if (response.status === 'failed' || response.job?.status === 'failed') return result('could_not_complete', ['OCR_FAILED']);
    if (response.status === 'review_required' || response.job?.status === 'review_required') return result('review_required', ['OCR_REVIEW_REQUIRED']);
    if (response.status === 'completed' || response.job?.status === 'completed' || response.data) return result('extracted');
    return result('unclassified', ['OCR_STATUS_UNKNOWN']);
  }
  if (serviceId === 'bank-statement-analysis') {
    if (response.status === 'failed') return result('could_not_complete', ['BSA_FAILED']);
    if (response.status === 'partial') return result('review_required', ['BSA_REVIEW_REQUIRED']);
    if (response.status === 'completed') return result('analyzed', ['ANALYSIS_NOT_CREDIT_APPROVAL']);
    return result('unclassified', ['BSA_STATUS_UNKNOWN']);
  }
  if (serviceId === 'adverse-media') {
    if (response.status !== 'completed' || response.coverage?.complete !== true || response.summary?.decision_eligible !== true) {
      return result('review_required', ['SCREENING_INCOMPLETE']);
    }
    if (['no_material_results', 'safe'].includes(response.summary?.outcome) && response.summary?.human_review_required === false) {
      return result('passed');
    }
    return result('review_required', ['SCREENING_REVIEW_REQUIRED']);
  }
  if (serviceId === 'adverse-media-search-plus') {
    return result('review_required', ['SEARCH_PLUS_SCREENING_REVIEW_REQUIRED']);
  }
  if (serviceId === 'merchant-screening') {
    if (response.status !== 'completed' || response.summary?.decision_eligible !== true) return result('review_required', ['SCREENING_INCOMPLETE']);
    if (response.summary?.risk_level === 'safe' && response.summary?.human_review_required === false) return result('passed');
    return result('review_required', ['SCREENING_REVIEW_REQUIRED']);
  }
  if (serviceId === 'forms') {
    return formOutcome(response);
  }
  if (serviceId === 'uae-tlv') return tradeLicenceOutcome(response);
  if (serviceId === 'iban-verification') return ibanOutcome(response);
  if (serviceId === 'entity-search') return entitySearchOutcome(response);
  // Provider adapters and future integrations need a separately reviewed business mapping.
  return result('unclassified', ['MAPPING_NOT_REVIEWED']);
}
