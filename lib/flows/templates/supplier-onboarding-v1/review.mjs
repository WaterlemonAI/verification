import { randomUUID } from 'node:crypto';
import { triangulateCase } from '../../triangulation.mjs';

function normalized(value) { return String(value || '').normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function isExpired(value) { const time = Date.parse(value || ''); return Number.isFinite(time) && time < Date.now(); }

export function reviewSupplierCase(item) {
  const docs = item.documents || [];
  const find = (type) => docs.findLast((doc) => doc.type === type);
  const value = (type) => find(type)?.extraction_result?.data?.data || find(type)?.extraction_result?.data || {};
  const licence = value('tradeLicenceFile'); const moa = value('moaFile'); const aoa = value('aoaFile');
  const identity = value('identityFile'); const vat = value('vatFile');
  const location = value('locationEvidenceFile'); const bank = value('bankConfirmationFile');
  const virtual = { ...item,
    draft: { ...item.draft, business_name: licence.company_name_english || item.draft?.tradingName,
      licence_number: licence.license_number, iban: bank.iban,
      stakeholders: (item.draft?.owners || []).map((owner) => ({ name: owner.fullName, role: owner.role,
        ownership_percentage: owner.share ? Number(owner.share) : null })) },
    documents: docs.map((doc) => ({ ...doc, type: {
      tradeLicenceFile: 'trade_licence', moaFile: 'formation_document',
      bankConfirmationFile: 'bank_letter', poaFile: 'power_of_attorney',
      locationEvidenceFile: item.draft?.locationEvidenceType === 'ejari' ? 'ejari'
        : item.draft?.locationEvidenceType === 'utility' ? 'utility_bill' : 'location_evidence'
    }[doc.type] || doc.type }))
  };
  const mapped = triangulateCase(virtual);
  const comparisons = mapped.comparisons;
  const issues = [];
  function compare(rule, left, right, sourceType, field, step) {
    const leftValue = normalized(left); const rightValue = normalized(right);
    const outcome = !leftValue || !rightValue ? 'unavailable' : leftValue === rightValue ? 'match' : 'mismatch';
    comparisons.push({ comparison_id: randomUUID(), rule_version: 'supplier-1.0.0', rule,
      source_ids: [find(sourceType)?.document_id].filter(Boolean), normalized_left: leftValue,
      normalized_right: rightValue, outcome, reason: outcome === 'unavailable' ? 'source_unavailable'
        : outcome === 'match' ? 'normalized_values_match' : 'normalized_values_differ' });
    if (outcome === 'mismatch') issues.push({ code: `${rule.toUpperCase()}_MISMATCH`, field, step,
      severity: 'review', message: 'The submitted documents show different values. Check the evidence before submission.' });
  }
  compare('licence_moa_name', licence.company_name_english, moa.company_name, 'moaFile', 'moaFile', 0);
  compare('licence_aoa_name', licence.company_name_english, aoa.company_name, 'aoaFile', 'aoaFile', 0);
  compare('licence_vat_name', licence.company_name_english,
    vat.registered_name || vat.business_name || vat.company_name, 'vatFile', 'vatFile', 2);
  compare('bank_holder_name', licence.company_name_english || item.draft?.tradingName,
    bank.account_holder || bank.business_name, 'bankConfirmationFile', 'bankConfirmationFile', 2);
  if (isExpired(licence.expiry_date)) issues.push({ code: 'LICENCE_EXPIRED', field: 'tradeLicenceFile', step: 0,
    severity: 'error', message: 'The trade licence appears expired. Upload a current document.' });
  if (isExpired(identity.expiry_date)) issues.push({ code: 'IDENTITY_EXPIRED', field: 'identityFile', step: 1,
    severity: 'error', message: 'The identity document appears expired. Upload a current document.' });
  if (item.draft?.locationEvidenceType === 'ejari' && isExpired(location.fields?.end_date))
    issues.push({ code: 'EJARI_EXPIRED', field: 'locationEvidenceFile', step: 1,
      severity: 'error', message: 'The tenancy evidence appears expired.' });
  return { facts: mapped.facts, comparisons, preview_issues: issues };
}
