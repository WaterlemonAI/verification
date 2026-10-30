// A display-only projection. Outcome classification remains with the server.
const names = {
  'adverse-media': 'Adverse media', 'merchant-screening': 'Merchant screening',
  'uae-tlv': 'UAE trade licence', 'iban-verification': 'IBAN verification',
  'entity-search': 'Entity search', 'bank-statement-analysis': 'Bank statement analysis',
  forms: 'Form submission', 'uae-trade-license-ocr': 'UAE trade licence OCR',
  'passport-icao-ocr': 'Passport and MRZ OCR', 'uae-poa-ocr': 'UAE POA OCR',
  'uae-utility-bill-ocr': 'UAE utility bill OCR', 'cheque-ocr': 'Cheque OCR',
  'moa-analysis': 'MOA analysis', 'articles-of-association-ocr': 'Articles of association OCR',
  'emirates-id-ocr': 'Emirates ID OCR'
};

export function serviceName(id = '') {
  return names[id] || id.replace(/-ocr$/, ' OCR').replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function fieldName(key) {
  return String(key).replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
    .replace(/\b(id|iban|mrz|pdf|url|api|ocr|aml|kyc|bsa)\b/gi, (word) => word.toUpperCase())
    .replace(/^./, (letter) => letter.toUpperCase());
}

function scalar(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return null;
}

function fields(object, keys = null, max = 24) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return [];
  return (keys || Object.keys(object)).slice(0, max).flatMap((key) => {
    const value = scalar(object[key]);
    return value === null ? [] : [{ label: fieldName(key), value }];
  });
}

function extractedFields(object, limit = 40) {
  const result = [];
  const visit = (value, path = '', depth = 0) => {
    if (result.length >= limit || value == null) return;
    const display = scalar(value);
    if (display !== null) {
      result.push({ label: path, value: display });
      return;
    }
    if (Array.isArray(value)) {
      if (value.every((entry) => scalar(entry) !== null)) {
        result.push({ label: path, value: value.slice(0, 6).map(scalar).join(', ') || 'None' });
        return;
      }
      if (depth >= 2) return;
      value.slice(0, 4).forEach((entry, index) => visit(entry, `${path} ${index + 1}`, depth + 1));
      return;
    }
    if (typeof value !== 'object' || depth >= 3) return;
    for (const [key, entry] of Object.entries(value)) {
      visit(entry, path ? `${path} · ${fieldName(key)}` : fieldName(key), depth + 1);
      if (result.length >= limit) break;
    }
  };
  visit(object);
  return result;
}

function formCheckFields(check) {
  const response = check.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) return [];
  switch (check.service_id) {
    case 'adverse-media':
      return fields(response.summary, ['risk_level', 'potentially_relevant_results', 'decision_eligible']);
    case 'merchant-screening':
      return fields(response.summary, ['risk_level', 'decision_eligible', 'human_review_required']);
    case 'uae-tlv':
      return fields(response.uae_tl_verification || response.trade_licence_verification_api,
        ['licence_registration_name', 'uae_licence_number', 'license_status']);
    case 'iban-verification':
      return fields(response.data?.results, ['result', 'bank', 'completeName']);
    default:
      return fields(response, ['status', 'message', 'result', 'matched']);
  }
}

export function buildCasePresentation(item, response) {
  const view = { metrics: [], sections: [], note: '' };
  const service = item?.service_id || '';
  const addMetric = (label, value) => {
    const display = scalar(value);
    if (display !== null) view.metrics.push({ label, value: display });
  };
  const addFields = (title, object, keys, note) => {
    const entries = fields(object, keys);
    if (entries.length) view.sections.push({ title, fields: entries, note });
  };
  const addItems = (title, values, map, note, limit = 8) => {
    if (!Array.isArray(values) || !values.length) return;
    view.sections.push({ title, items: values.slice(0, limit).map(map),
      note: values.length > limit ? `Showing ${limit} of ${values.length}. Open Final response JSON for the complete list.` : note });
  };

  if (response == null) {
    view.note = 'The final response is still pending.';
    return view;
  }
  if (typeof response !== 'object' || Array.isArray(response)) {
    view.note = 'This service returned an unstructured response. Open Final response to inspect it.';
    return view;
  }

  if (service === 'adverse-media') {
    addMetric('Subject', response.entity?.name);
    addMetric('Risk level', response.summary?.risk_level);
    addMetric('Potentially relevant results', response.summary?.potentially_relevant_results ?? response.results?.length);
    addMetric('Coverage complete', response.coverage?.complete);
    addMetric('Decision eligible', response.summary?.decision_eligible);
    addFields('Assessment', response.summary, ['statement', 'outcome', 'threshold_status', 'human_review_required']);
    addItems('Public evidence', response.results, (result) => ({
      title: result.title || 'Untitled result',
      meta: [result.publisher, result.published_at, result.risk_level].filter(Boolean).join(' · '),
      description: result.excerpt || '', url: result.url,
      fields: fields(result, ['legal_stage', 'risk_score', 'review_required'])
    }), 'Evidence requires human review before a decision.');
    addItems('Source coverage', response.coverage?.sources, (source) => ({
      title: fieldName(source.source || 'Source'), meta: scalar(source.status) || '',
      description: source.reason || source.message || ''
    }));
    addFields('Coverage limitations', response.coverage, ['limitation', 'archive_window', 'retryable']);
  } else if (service === 'merchant-screening') {
    addMetric('Merchant', response.merchant_identity?.names?.[0]);
    addMetric('Domain', response.domain?.domain);
    addMetric('Risk level', response.summary?.risk_level);
    addMetric('Findings', response.findings?.length);
    addMetric('Decision eligible', response.summary?.decision_eligible);
    addFields('Assessment', response.summary, ['outcome', 'confidence', 'human_review_required', 'threshold_status']);
    addItems('Findings', response.findings, (finding) => ({
      title: finding.title || finding.label || fieldName(finding.code || finding.category || 'Finding'),
      meta: [finding.risk_level, finding.severity].filter(Boolean).join(' · '),
      description: finding.description || (typeof finding.evidence === 'string' ? finding.evidence : ''), url: finding.url
    }));
    addItems('Products and activity', response.products, (product) => ({
      title: product.name || product.title || 'Observed product', meta: product.risk_level || '',
      description: product.description || '',
      fields: fields(product.candidate_mcc, ['code', 'description'])
    }));
    addFields('Source coverage', response.summary?.coverage);
  } else if (service === 'uae-tlv') {
    const licence = response.uae_tl_verification || response.trade_licence_verification_api || {};
    addMetric('Registered company', licence.licence_registration_name || licence.company_name);
    addMetric('Licence number', licence.uae_licence_number || licence.license_number);
    addMetric('Licence status', licence.license_status);
    addMetric('Emirate', licence.emirate_name);
    addFields('Licence details', licence, ['legal_type_from_entity', 'governing_body_name', 'registration_date',
      'expiration_date', 'licence_registration_address', 'moec_status']);
    view.note = 'These are provider-returned licence details. The business outcome remains unclassified until its meaning is approved.';
  } else if (service === 'iban-verification') {
    const match = response.data?.results || {};
    addMetric('Provider result', match.result || response.msg);
    addMetric('Country', match.country);
    addFields('Match checks', match, ['bank', 'bankCode', 'completeName', 'bankAccountNumber']);
    view.note = 'Match values are shown as returned by the provider; no overall approval is inferred.';
  } else if (service === 'entity-search') {
    addMetric('Search status', response.message);
    addMetric('Profiles found', response.data?.profiles?.length);
    addMetric('Profiles search complete', response.profiles_success);
    addMetric('Public content complete', response.apc_success);
    addItems('Profiles', response.data?.profiles, (profile) => ({
      title: profile.name || profile.title || 'Profile',
      meta: [profile.type, profile.country, profile.source].filter(Boolean).join(' · '),
      description: profile.description || '', url: profile.url,
      fields: fields(profile, ['status', 'registration_number', 'jurisdiction'])
    }));
    view.note = 'Search hits are candidates for review, not verified matches.';
  } else if (service === 'bank-statement-analysis') {
    addMetric('Analysis status', response.status || response.analysis?.status);
    addMetric('Decision eligible', response.decisionEligible);
    addMetric('Accounts', response.accounts?.length);
    addMetric('Findings', response.findings?.length);
    addMetric('Transactions', response.coverage?.transactionCount);
    addMetric('Unsupported pages', response.coverage?.unsupportedPages?.length);
    addFields('Coverage', response.coverage, null);
    addItems('Accounts', response.accounts, (account) => ({
      title: account.name || account.account_name || account.account_id || 'Account',
      meta: [account.bank, account.currency, account.status].filter(Boolean).join(' · '),
      fields: fields(account, ['holder', 'product', 'period_start', 'period_end'])
    }));
    addItems('Findings', response.findings, (finding) => ({
      title: finding.title || fieldName(finding.reasonCode || finding.reason_code || 'Finding'),
      meta: finding.severity || '', description: finding.description || finding.message || ''
    }));
    addItems('Limitations', response.limitations, (value) => ({
      title: typeof value === 'string' ? value : value.title || fieldName(value.code || 'Limitation'),
      description: typeof value === 'string' ? '' : value.description || ''
    }));
    view.note = 'Financial analysis supports review; it is not a credit approval.';
  } else if (service === 'forms') {
    addMetric('Form status', response.status);
    addMetric('Selected checks', response.services?.length);
    addMetric('Decision eligible', response.summary?.decision_eligible);
    addFields('Coverage', response.summary, ['coverage_complete', 'total', 'threshold_status']);
    addItems('Selected checks', response.services, (check) => ({
      title: check.name || serviceName(check.service_id || 'Check'),
      meta: [check.transport?.status, check.coverage?.status, check.eligibility?.status].filter(Boolean).join(' · '),
      description: check.eligibility?.reason_codes?.map(fieldName).join(', ') || '',
      fields: formCheckFields(check)
    }), 'Each check has its own result and coverage. Open Final response JSON for all child responses.', 20);
  } else if (service.endsWith('-ocr') || service === 'moa-analysis') {
    addMetric('Extraction status', response.status || response.job?.status);
    addMetric('Document type', response.document_classification || response.data?.document_type);
    addMetric('Extracted fields', response.data && typeof response.data === 'object' ? Object.keys(response.data).length : null);
    addMetric('Review required', response.review_required);
    const extracted = extractedFields(response.data);
    if (extracted.length) view.sections.push({ title: 'Extracted information', fields: extracted,
      note: extracted.length === 40 ? 'Showing up to 40 fields. Open Final response JSON for the complete extraction.' : '' });
    addItems('Review flags', response.review_flags, (flag) => ({
      title: typeof flag === 'string' ? fieldName(flag) : fieldName(flag.code || flag.reason || 'Review flag'),
      description: typeof flag === 'string' ? '' : flag.message || ''
    }));
    addFields('MRZ check', response.mrz, ['verified', 'valid', 'reason'], 'A verified MRZ applies only to the MRZ check, not every extracted field.');
    view.note = 'Extracted values are transcribed from documents and may need human verification.';
  } else {
    addMetric('Response status', response.status);
    addFields('Response highlights', response, null);
    view.note = 'This integration has no tailored summary yet. Open Final response JSON for the complete result.';
  }

  if (!view.metrics.length && !view.sections.length && !view.note) {
    view.note = 'No displayable summary is available. Open Final response JSON for the complete result.';
  }
  return view;
}
