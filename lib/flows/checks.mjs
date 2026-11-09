import { randomUUID } from 'node:crypto';
import { sha256 } from './crypto.mjs';

export function unavailableCheck(serviceId, subjectId, reason = 'adapter_unavailable') {
  return { check_id: randomUUID(), subject_id: subjectId, service_id: serviceId,
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    transport: 'not_run', coverage: 'unavailable', business_result: 'could_not_complete',
    http_status: null, reason_codes: [reason], raw_response: null };
}

export async function executeCheck(serviceId, subjectId, input, call) {
  const started = new Date().toISOString();
  const checkId = randomUUID();
  const fingerprint = sha256(JSON.stringify(input));
  try {
    const result = await call(serviceId, input);
    const success = result.httpStatus >= 200 && result.httpStatus < 300;
    const response = result.response;
    const explicitFailure = response?.status === 'Error' || response?.status === 'failed'
      || response?.success === false || response?.error != null;
    const complete = success && !explicitFailure && (response?.coverage?.complete === true
      || /^(success|completed)$/i.test(String(response?.status || '')));
    return { check_id: checkId, subject_id: subjectId, service_id: serviceId, request_fingerprint: fingerprint,
      started_at: started, completed_at: new Date().toISOString(), http_status: result.httpStatus,
      transport: success ? 'completed' : 'failed', coverage: complete ? 'complete' : success && !explicitFailure ? 'partial' : 'unavailable',
      business_result: success && !explicitFailure ? 'requires_review' : 'could_not_complete',
      reason_codes: explicitFailure ? ['provider_business_error'] : complete ? [] : success ? ['coverage_not_confirmed'] : ['provider_http_error'],
      raw_response: response };
  } catch {
    return { check_id: checkId, subject_id: subjectId, service_id: serviceId, request_fingerprint: fingerprint,
      started_at: started, completed_at: new Date().toISOString(), http_status: null,
      transport: 'failed', coverage: 'unavailable', business_result: 'could_not_complete',
      reason_codes: ['provider_unavailable'], raw_response: null };
  }
}
