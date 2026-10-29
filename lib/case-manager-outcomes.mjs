import { DOCUMENT_OCR_BY_ID } from './document-ocr-contracts.mjs';

const result = (outcome, reasonCodes = []) => ({ outcome, reasonCodes });

export function caseOutcome(serviceId, response, { httpStatus = 0, final = true } = {}) {
  if (!final || httpStatus === 202) return result('pending');
  if (DOCUMENT_OCR_BY_ID.has(serviceId) && (response?.status === 'failed' || response?.job?.status === 'failed')) {
    return result('could_not_complete', ['OCR_FAILED']);
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
    if (response.status === 'partial' || response.decisionEligible === false) return result('review_required', ['BSA_REVIEW_REQUIRED']);
    return result('unclassified', ['ANALYSIS_NOT_CREDIT_APPROVAL']);
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
  if (serviceId === 'merchant-screening') {
    if (response.status !== 'completed' || response.summary?.decision_eligible !== true) return result('review_required', ['SCREENING_INCOMPLETE']);
    if (response.summary?.risk_level === 'safe' && response.summary?.human_review_required === false) return result('passed');
    return result('review_required', ['SCREENING_REVIEW_REQUIRED']);
  }
  if (serviceId === 'forms') {
    if (response.status === 'failed') return result('could_not_complete', ['FORM_FAILED']);
    if (response.status === 'partial' || response.summary?.decision_eligible !== true) return result('review_required', ['FORM_REVIEW_REQUIRED']);
    // Eligibility means a result can support a decision, not that every child is a pass.
    return result('unclassified', ['FORM_OUTCOME_NOT_APPROVAL']);
  }
  // Provider adapters and future integrations need a separately reviewed business mapping.
  return result('unclassified', ['MAPPING_NOT_REVIEWED']);
}
