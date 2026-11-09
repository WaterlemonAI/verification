// Every browser/API view is assembled from an allowlist. New case fields stay private by default.
import { supplierRequirements } from './templates/supplier-onboarding-v1/rules.mjs';
const caseFields = [
  'application_id', 'workspace_id', 'flow_id', 'template_version', 'definition_hash',
  'customer_reference', 'supplier_email', 'prefill', 'status', 'created_at', 'updated_at',
  'submitted_at', 'expires_at', 'link_expires_at', 'link_redeemed_at', 'configuration',
  'draft', 'documents', 'facts', 'subjects', 'checks', 'check_history', 'comparisons',
  'gemini_review', 'reports', 'events', 'preview_issues', 'preview_ready_at', 'diagnostic'
];

function select(source, fields) {
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(source || {}, key)).map((key) => [key, source[key]]));
}

const documentFields = [
  'document_id', 'type', 'mime_type', 'size', 'sha256', 'uploaded_at', 'scan_result',
  'extraction_state', 'extraction_reason'
];
const extractedFields = {
  trade_licence: ['company_name_english', 'license_number', 'license_status', 'expiry_date', 'address', 'business_activity'],
  formation_document: ['company_name', 'registration_number', 'shareholders', 'business_objectives'],
  utility_bill: ['address', 'bill_issued_to', 'bill_date'],
  power_of_attorney: ['name_of_poa', 'entity', 'period'],
  identity_document: ['full_name_english', 'given_names', 'surnames', 'expiry_date'],
  bank_letter: ['business_name', 'account_holder', 'bank_name', 'iban', 'issue_date'],
  ejari: ['status', 'fields'],
  aoa: ['company_name', 'registration_number', 'directors', 'share_structure'],
  vat_certificate: ['trn', 'registered_name', 'effective_date'],
  board_resolution: ['business_name', 'company_name', 'authorised_people', 'signatories', 'authorised_signatories', 'resolution_date'],
  incorporation_certificate: ['business_names', 'company_name', 'registration_number', 'incorporation_date'],
  location_evidence: ['addresses', 'business_names', 'address', 'tenant_name', 'evidence_date']
};
Object.assign(extractedFields, {
  tradeLicenceFile: extractedFields.trade_licence,
  moaFile: extractedFields.formation_document,
  aoaFile: extractedFields.aoa,
  identityFile: extractedFields.identity_document,
  poaFile: extractedFields.power_of_attorney,
  locationEvidenceFile: [...new Set([...extractedFields.ejari, ...extractedFields.utility_bill, ...extractedFields.location_evidence])],
  bankConfirmationFile: extractedFields.bank_letter,
  vatFile: extractedFields.vat_certificate,
  brFile: extractedFields.board_resolution,
  incorporationFile: extractedFields.incorporation_certificate
});

function supplierDocument(document) {
  const visible = select(document, documentFields);
  const data = document.extraction_result?.data;
  if (data && typeof data === 'object') {
    const safe = select(data, extractedFields[document.type] || []);
    for (const key of ['shareholders', 'directors', 'authorised_people', 'signatories']) {
      if (Array.isArray(safe[key])) safe[key] = safe[key].slice(0, 50).map((person) => {
        if (typeof person === 'string') return person.slice(0, 200);
        const entry = select(person, ['name', 'shareholding_percent', 'role']);
        return Object.fromEntries(Object.entries(entry).filter(([, value]) => typeof value === 'string' || typeof value === 'number')
          .map(([field, value]) => [field, typeof value === 'string' ? value.slice(0, 200) : value]));
      });
    }
    if (safe.fields && typeof safe.fields === 'object')
      safe.fields = Object.fromEntries(Object.entries(select(safe.fields,
        ['tenant_name', 'building_name', 'unit_number', 'makani_number', 'end_date', 'unit_usage']))
        .filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value.slice(0, 2000)]));
    for (const [key, value] of Object.entries(safe)) {
      if (typeof value === 'string') safe[key] = value.slice(0, 2000);
      if (Array.isArray(value) && !['shareholders', 'directors', 'authorised_people', 'signatories'].includes(key))
        safe[key] = value.filter((entry) => typeof entry === 'string').slice(0, 50).map((entry) => entry.slice(0, 200));
      if (value && typeof value === 'object' && !Array.isArray(value) && key !== 'fields') delete safe[key];
    }
    if (Object.keys(safe).length) visible.extraction_result = { data: safe };
  }
  return visible;
}

export function supplierCase(item) {
  const checkStatus = (subjectId, serviceId) => {
    const check = (item.checks || []).find((entry) => entry.subject_id === subjectId && entry.service_id === serviceId);
    if (!check) return 'not_run';
    return check.transport === 'completed' ? 'review' : 'unavailable';
  };
  return {
    application_id: item.application_id, flow_id: item.flow_id, template_version: item.template_version,
    status: item.status, draft: item.draft || {},
    documents: (item.documents || []).filter((doc) => doc.type !== 'ejari_certificate').map(supplierDocument),
    comparisons: (item.comparisons || []).map((value) => select(value, ['rule', 'outcome', 'reason', 'score'])),
    preview_issues: (item.preview_issues || []).map((issue) => select(issue,
      ['code', 'field', 'step', 'severity', 'message'])),
    screening_summary: { enabled: (item.checks || []).length > 0,
      subjects: (item.subjects || []).map((subject) => ({ name: subject.name, type: subject.type,
        roles: subject.roles || [], aml: checkStatus(subject.subject_id,
          subject.subject_id === item.application_id ? 'entity-aml' : 'stakeholder-aml'),
        adverseMedia: checkStatus(subject.subject_id,
          subject.subject_id === item.application_id ? 'entity-adverse-media' : 'stakeholder-adverse-media') })) },
    preview_ready_at: item.preview_ready_at || null,
    brand_name: item.configuration?.brand_name || 'KYCProbe'
  };
}

export function customerCase(item) { return select(item, caseFields); }
export function buyerCase(item) {
  const visible = select(item, caseFields);
  visible.review_requirements = item.flow_id === 'supplier-onboarding-v1'
    ? supplierRequirements(item.draft || {})
    : { text: ['business_name', 'licence_number', 'company_type', 'activities', 'registered_address'],
      documents: ['trade_licence', 'formation_document', 'bank_letter'] };
  return visible;
}
