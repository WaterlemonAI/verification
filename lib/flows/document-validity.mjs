// OCR is evidence, not authentication. These guards keep an unreadable or expired
// time-limited document from being accepted by the Al Naboodah workflow.
const names = Object.freeze({
  trade_licence: 'Trade licence', incorporation_record: 'Incorporation record',
  natural_identity: 'Natural person ID or passport', identity_document: 'Representative ID or passport',
  ejari: 'Ejari certificate', premises_evidence: 'Address proof',
  bank_letter: 'Bank confirmation letter', bank_statement: 'Bank statement',
  goods_origin_evidence: 'Goods origin evidence', payment_agreement: 'Payment agreement'
});
const missing = (value) => !value || ['not found', 'not readable', 'n/a'].includes(String(value).trim().toLowerCase());
const isoDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const dataOf = (document) => document.extraction_result?.data?.data || document.extraction_result?.data || {};

export function documentValidityIssues(item, { now = new Date() } = {}) {
  if (!item.workflow_schema?.document_policy?.ocr_required) return [];
  const issues = []; const today = now.toISOString().slice(0, 10);
  const selectedProof = item.draft?.address_proof_type;
  const active = [...new Map((item.documents || [])
    .filter((document) => document.scan_result !== 'source_generated')
    .map((document) => [document.type, document])).values()]
    .filter((document) => document.type !== 'ejari' || selectedProof === 'Ejari')
    .filter((document) => document.type !== 'premises_evidence' || selectedProof !== 'Ejari');
  for (const document of active) {
    const name = names[document.type] || 'Document';
    if (document.extraction_state !== 'completed') {
      issues.push({ document_id: document.document_id, type: document.type, code: 'ocr_incomplete',
        message: `${name} could not be read yet; please upload a legible copy or retry extraction.` });
      continue;
    }
    const data = dataOf(document);
    const requiredFacts = {
      trade_licence: ['company_name_english', 'license_number', 'company_type'],
      incorporation_record: ['company_name', 'registration_number'],
      natural_identity: ['identity_type', 'full_name_english', 'document_number'],
      identity_document: ['identity_type', 'full_name_english', 'document_number'],
      premises_evidence: ['evidence_type', 'address'],
      bank_letter: ['account_holder', 'bank_name', 'letterhead_bank_name'],
      bank_statement: ['account_holder', 'bank_name'],
      goods_origin_evidence: ['document_kind'], payment_agreement: ['document_kind']
    }[document.type] || [];
    for (const field of requiredFacts) if (missing(data[field])) issues.push({ document_id: document.document_id,
      type: document.type, code: 'ocr_field_unreadable',
      message: `${name} ${field.replaceAll('_', ' ')} could not be read; please upload a legible document.` });
    if (['bank_letter', 'bank_statement'].includes(document.type)
      && missing(data.iban) && missing(data.account_number)) issues.push({ document_id: document.document_id,
        type: document.type, code: 'account_unreadable',
        message: `${name} account number or IBAN could not be read; please upload a legible document.` });
    if (document.type === 'ejari' && data.status !== 'verified') issues.push({ document_id: document.document_id,
      type: document.type, code: 'ejari_unverified', message: 'Ejari certificate could not be verified; please provide current address proof.' });
    const lease = document.type === 'premises_evidence'
      && (selectedProof === 'Tenancy or lease' || data.evidence_type === 'Tenancy or lease');
    const expiry = document.type === 'ejari' ? data.fields?.end_date || data.expiry_date
      : lease ? data.period_end_date || data.expiry_date : data.expiry_date;
    const requiresExpiry = ['trade_licence', 'natural_identity', 'identity_document', 'ejari'].includes(document.type)
      || lease;
    if (requiresExpiry && !isoDate(expiry)) {
      issues.push({ document_id: document.document_id, type: document.type, code: 'expiry_unreadable',
        message: `${name} expiry could not be verified; please upload a legible current document.` });
    } else if (!missing(expiry) && !isoDate(expiry)) {
      issues.push({ document_id: document.document_id, type: document.type, code: 'expiry_unreadable',
        message: `${name} expiry could not be verified; please upload a legible current document.` });
    } else if (isoDate(expiry) && expiry < today) {
      issues.push({ document_id: document.document_id, type: document.type, code: 'expired',
        message: `${name} is expired, please update recent` });
    }
    if (lease && isoDate(data.period_end_date)
      && isoDate(data.expiry_date) && data.period_end_date !== data.expiry_date)
      issues.push({ document_id: document.document_id, type: document.type, code: 'validity_date_mismatch',
        message: 'Address proof has conflicting validity dates; please provide a clear current document.' });
    for (const printedDate of [data.expiry_date, document.type === 'ejari' ? data.fields?.end_date : null]) {
      if (isoDate(printedDate) && printedDate < today && printedDate !== expiry)
        issues.push({ document_id: document.document_id, type: document.type, code: 'expired',
          message: `${name} is expired, please update recent` });
    }
    if (document.type === 'bank_letter') {
      const issued = data.issue_date;
      if (!isoDate(issued)) issues.push({ document_id: document.document_id, type: document.type,
        code: 'issue_date_unreadable', message: 'Bank confirmation letter issue date could not be verified; please upload a legible recent letter.' });
      else {
        const reference = item.submitted_at ? new Date(item.submitted_at) : now;
        const submittedDay = reference.toISOString().slice(0, 10);
        const cutoff = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - 1,
          Math.min(reference.getUTCDate(), new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 0)).getUTCDate())))
          .toISOString().slice(0, 10);
        if (issued < cutoff || issued > submittedDay) issues.push({ document_id: document.document_id,
          type: document.type, code: 'bank_letter_not_recent',
          message: 'Bank confirmation letter is not dated within one month of submission; please upload a recent letter.' });
      }
    }
    if (document.type === 'premises_evidence') {
      if (missing(data.address)) issues.push({ document_id: document.document_id, type: document.type,
        code: 'address_unreadable', message: 'Address proof address could not be read; please upload a legible document.' });
      const expected = ['Utility bill', 'Tenancy or lease', 'Title deed', 'Other official address evidence'].includes(selectedProof)
        ? selectedProof : null;
      if (expected && !missing(data.evidence_type) && data.evidence_type !== expected)
        issues.push({ document_id: document.document_id, type: document.type,
          code: 'address_proof_type_mismatch', message: 'Address proof type differs from your selection; please correct the selection or document.' });
    }
  }
  const latest = (type) => item.documents?.findLast((document) => document.type === type);
  for (const [field, type] of [['licence_expiry', 'trade_licence'], ['natural_id_expiry', 'natural_identity'],
    ['representative_id_expiry', 'identity_document']]) {
    const document = latest(type); const entered = item.draft?.[field];
    const extracted = document ? dataOf(document).expiry_date : null;
    if (entered && isoDate(extracted) && entered !== extracted) issues.push({ document_id: document.document_id,
      type, code: 'expiry_mismatch', message: `${names[type]} expiry differs from the uploaded document; please correct the date or replace the document.` });
  }
  return issues;
}
