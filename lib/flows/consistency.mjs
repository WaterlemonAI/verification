const criticalRules = new Set([
  'supplier_licence_name', 'supplier_incorporation_name', 'supplier_natural_identity_name',
  'licence_tlv_name', 'licence_tlv_number', 'licence_tlv_company_type', 'licence_tlv_status', 'licence_tlv_expiry',
  'supplier_bank_account_holder', 'bank_letterhead_name', 'declared_bank_letter_iban',
  'bank_statement_iban', 'bank_statement_account_number', 'bank_statement_account_holder',
  'bank_statement_bank_name', 'bank_statement_country'
]);

export function criticalConsistencyIssues(item, { now = new Date() } = {}) {
  if (!item.workflow_schema?.document_policy) return [];
  const issues = (item.comparisons || []).filter((comparison) => criticalRules.has(comparison.rule)
    && comparison.outcome === 'mismatch').map((comparison) => ({ code: comparison.rule,
    message: `Resolve ${comparison.rule.replaceAll('_', ' ')} mismatch before acceptance.` }));
  const isUaeCompany = item.draft?.supplier_type === 'Company or other Legal person'
    && item.draft?.registration_jurisdiction === 'United Arab Emirates';
  if (isUaeCompany) {
    const check = item.checks?.findLast((entry) => entry.service_id === 'uae-trade-licence');
    const result = check?.raw_response?.uae_tl_verification
      || check?.raw_response?.trade_licence_verification_api;
    if (check?.coverage !== 'complete' || !result) issues.push({ code: 'tlv_unverified',
      message: 'UAE trade licence verification must complete before acceptance.' });
    else {
      if (String(result.license_status || '').toLowerCase() !== 'active'
        || String(result.moec_status || '').toLowerCase() !== 'active')
        issues.push({ code: 'tlv_inactive', message: 'UAE trade licence verification reports an inactive or unresolved licence.' });
      const expiry = result.expiration_date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry || '') || expiry < now.toISOString().slice(0, 10))
        issues.push({ code: 'tlv_expired', message: 'UAE trade licence verification expiry is missing or past.' });
    }
  }
  return issues;
}
