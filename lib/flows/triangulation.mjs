import { randomUUID } from 'node:crypto';
import { sha256 } from './crypto.mjs';
import { documentOwnerDetails, verifiedLicencePeople, verifiedManagerNames } from './stakeholder-discovery.mjs';

function normalize(value) {
  return String(value || '').toLocaleLowerCase('en').normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function normalizeCompanyType(value) {
  const type = normalize(value).replaceAll(' ', '');
  if (['llc', 'limitedliabilitycompany'].includes(type)) return 'llc';
  if (['fzco', 'freezonecompany'].includes(type)) return 'fzco';
  return type;
}
function normalizeShareholding(value) {
  const number = Number(String(value || '').replace(/[%\s,]/g, ''));
  return Number.isFinite(number) ? String(number) : normalize(value);
}
function normalizeLicenceStatus(value) {
  const status = normalize(value);
  if (['active', 'current', 'valid'].includes(status)) return 'active';
  if (['expired', 'inactive', 'cancelled', 'canceled', 'revoked'].includes(status)) return 'inactive';
  return status;
}

function similarity(a, b) {
  const left = normalize(a); const right = normalize(b);
  if (!left || !right) return 0;
  const longer = left.length > right.length ? left : right;
  const shorter = left.length > right.length ? right : left;
  let previous = Array.from({ length: shorter.length + 1 }, (_, i) => i);
  for (let i = 1; i <= longer.length; i++) {
    const row = [i];
    for (let j = 1; j <= shorter.length; j++)
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (longer[i - 1] === shorter[j - 1] ? 0 : 1));
    previous = row;
  }
  return 1 - previous[shorter.length] / longer.length;
}

export function triangulateCase(item) {
  const facts = [];
  const checkIds = new Set((item.checks || []).map((check) => check.check_id));
  function add(path, value, sourceId, sourcePath) {
    if (value === undefined || value === null || value === '' || value === 'Not Found' || value === 'Not Readable') return null;
    const fact = { fact_id: randomUUID(), field_path: path, value, source_id: sourceId,
      source_path: sourcePath, extraction_method: sourceId === 'supplier' ? 'declared'
        : checkIds.has(sourceId) ? 'verification_api' : 'document_ocr',
      observed_at: new Date().toISOString(), confidence: 'unreviewed' };
    facts.push(fact); return fact;
  }
  const declaredName = add('business.name', item.draft.business_name, 'supplier', 'draft.business_name');
  const declaredNumber = add('business.licence_number', item.draft.licence_number, 'supplier', 'draft.licence_number');
  add('supplier.supply_description', item.draft.supply_description, 'supplier', 'draft.supply_description');
  const licenceDoc = item.documents.findLast((doc) => doc.type === 'trade_licence');
  const licence = licenceDoc?.extraction_result?.data || {};
  const licenceName = add('licence.name', licence.company_name_english, licenceDoc?.document_id, 'data.company_name_english');
  const licenceNumber = add('licence.number', licence.license_number, licenceDoc?.document_id, 'data.license_number');
  const licenceType = add('licence.company_type', licence.company_type, licenceDoc?.document_id, 'data.company_type');
  const licenceStatus = add('licence.status', licence.license_status, licenceDoc?.document_id, 'data.license_status');
  const licenceExpiry = add('licence.expiry_date', licence.expiry_date, licenceDoc?.document_id, 'data.expiry_date');
  const licenceAddress = add('licence.address', licence.address, licenceDoc?.document_id, 'data.address');
  const licenceManagers = add('licence.business_manager_names', licence.business_manager_names,
    licenceDoc?.document_id, 'data.business_manager_names');
  add('licence.activities', licence.business_activity, licenceDoc?.document_id, 'data.business_activity');
  const incorporationDoc = item.documents.findLast((doc) => doc.type === 'incorporation_record');
  const incorporation = incorporationDoc?.extraction_result?.data || {};
  const incorporationName = add('incorporation.name', incorporation.company_name,
    incorporationDoc?.document_id, 'data.company_name');
  add('incorporation.activities', incorporation.business_activities,
    incorporationDoc?.document_id, 'data.business_activities');
  const identityDoc = item.documents.findLast((doc) => doc.type === 'natural_identity');
  const identity = identityDoc?.extraction_result?.data || {};
  const identityName = add('identity.name', identity.full_name_english, identityDoc?.document_id, 'data.full_name_english');
  const identityExpiry = add('identity.expiry_date', identity.expiry_date, identityDoc?.document_id, 'data.expiry_date');
  const representativeDoc = item.documents.findLast((doc) => doc.type === 'identity_document');
  const representative = representativeDoc?.extraction_result?.data || {};
  const representativeExpiry = add('representative.expiry_date', representative.expiry_date,
    representativeDoc?.document_id, 'data.expiry_date');
  const premisesDoc = item.documents.findLast((doc) => doc.type === 'premises_evidence');
  const premises = premisesDoc?.extraction_result?.data || {};
  const premisesAddress = add('premises.address', premises.address, premisesDoc?.document_id, 'data.address');
  const premisesTenant = add('premises.tenant_name', premises.tenant_name, premisesDoc?.document_id, 'data.tenant_name');
  add('premises.period_end_date', premises.period_end_date || premises.expiry_date,
    premisesDoc?.document_id, 'data.period_end_date');
  const moaDoc = item.documents.findLast((doc) => doc.type === 'formation_document');
  const moa = moaDoc?.extraction_result?.data || {};
  const moaName = add('formation.name', moa.company_name, moaDoc?.document_id, 'data.company_name');
  const moaNumber = add('formation.number', moa.registration_number, moaDoc?.document_id, 'data.registration_number');
  const utilityDoc = item.documents.findLast((doc) => doc.type === 'utility_bill');
  const utility = utilityDoc?.extraction_result?.data || {};
  const utilityAddress = add('utility.address', utility.address, utilityDoc?.document_id, 'data.address');
  const utilityName = add('utility.account_name', utility.bill_issued_to, utilityDoc?.document_id, 'data.bill_issued_to');
  const bankDoc = item.documents.findLast((doc) => doc.type === 'bank_letter');
  const bank = bankDoc?.extraction_result?.data || {};
  const bankOwner = add('bank_letter.business_name', bank.business_name, bankDoc?.document_id, 'data.business_name');
  const bankAccountHolder = add('bank_letter.account_holder', bank.account_holder, bankDoc?.document_id, 'data.account_holder');
  const bankName = add('bank_letter.bank_name', bank.bank_name, bankDoc?.document_id, 'data.bank_name');
  const letterheadName = add('bank_letter.letterhead_bank_name', bank.letterhead_bank_name,
    bankDoc?.document_id, 'data.letterhead_bank_name');
  const bankDate = add('bank_letter.issue_date', bank.issue_date, bankDoc?.document_id, 'data.issue_date');
  const bankIban = add('bank_letter.iban', bank.iban, bankDoc?.document_id, 'data.iban');
  const bankAccountNumber = add('bank_letter.account_number', bank.account_number,
    bankDoc?.document_id, 'data.account_number');
  const bankBranch = add('bank_letter.branch_name', bank.branch_name,
    bankDoc?.document_id, 'data.branch_name');
  const statementDoc = item.documents.findLast((doc) => doc.type === 'bank_statement');
  const statement = statementDoc?.extraction_result?.data || {};
  const statementHolder = add('bank_statement.account_holder', statement.account_holder,
    statementDoc?.document_id, 'data.account_holder');
  const statementBank = add('bank_statement.bank_name', statement.bank_name,
    statementDoc?.document_id, 'data.bank_name');
  const statementIban = add('bank_statement.iban', statement.iban,
    statementDoc?.document_id, 'data.iban');
  const statementAccountNumber = add('bank_statement.account_number', statement.account_number,
    statementDoc?.document_id, 'data.account_number');
  const statementBranch = add('bank_statement.branch_name', statement.branch_name,
    statementDoc?.document_id, 'data.branch_name');
  const statementCountry = add('bank_statement.bank_country', statement.bank_country,
    statementDoc?.document_id, 'data.bank_country');
  const bankCountry = add('bank_letter.bank_country', bank.bank_country, bankDoc?.document_id, 'data.bank_country');
  const tlvCheck = item.checks?.findLast((check) => check.service_id === 'uae-trade-licence');
  const tlv = tlvCheck?.raw_response?.uae_tl_verification
    || tlvCheck?.raw_response?.trade_licence_verification_api || {};
  const tlvSource = tlvCheck?.check_id;
  const tlvName = add('tlv.name', tlv.licence_registration_name, tlvSource, 'raw_response.uae_tl_verification.licence_registration_name');
  const tlvNumber = add('tlv.number', tlv.uae_licence_number, tlvSource, 'raw_response.uae_tl_verification.uae_licence_number');
  const tlvType = add('tlv.company_type', tlv.legal_type_from_entity, tlvSource, 'raw_response.uae_tl_verification.legal_type_from_entity');
  const tlvStatus = add('tlv.status', tlv.license_status, tlvSource, 'raw_response.uae_tl_verification.license_status');
  const tlvAddress = add('tlv.address', tlv.licence_registration_address, tlvSource, 'raw_response.uae_tl_verification.licence_registration_address');
  const tlvExpiry = add('tlv.expiry_date', tlv.expiration_date, tlvSource, 'raw_response.uae_tl_verification.expiration_date');
  const tlvManagers = add('tlv.business_managers', verifiedManagerNames(item).join('; '), tlvSource,
    'raw_response');
  const declaredIban = add('business.iban', item.draft.iban, 'supplier', 'draft.iban');
  const ejariDoc = item.documents.findLast((doc) => doc.type === 'ejari');
  const ejari = ejariDoc?.extraction_result?.data?.fields || {};
  const ejariTenant = add('ejari.tenant_name', ejari.tenant_name, ejariDoc?.document_id, 'data.fields.tenant_name');
  const comparisons = [];
  function compare(rule, left, right, threshold = 1, normalizeValue = normalize) {
    const leftValue = rule.includes('iban') && left ? normalize(left.value).replaceAll(' ', '') : left ? normalizeValue(left.value) : null;
    const rightValue = rule.includes('iban') && right ? normalize(right.value).replaceAll(' ', '') : right ? normalizeValue(right.value) : null;
    const score = leftValue && rightValue ? rule.includes('iban') ? Number(leftValue === rightValue)
      : similarity(leftValue, rightValue) : null;
    comparisons.push({ comparison_id: randomUUID(), rule_version: '1.0.0', rule,
      left_fact_id: left?.fact_id || null, right_fact_id: right?.fact_id || null,
      normalized_left: leftValue, normalized_right: rightValue,
      score, outcome: score === null ? 'unavailable' : score >= threshold ? 'match' : 'mismatch',
      reason: score === null ? 'source_unavailable' : score >= threshold ? 'normalized_values_match' : 'normalized_values_differ' });
  }
  compare('supplier_licence_name', declaredName, licenceName);
  compare('supplier_incorporation_name', declaredName, incorporationName);
  compare('supplier_natural_identity_name', declaredName, identityName);
  compare('supplier_licence_number', declaredNumber, licenceNumber);
  compare('licence_tlv_name', licenceName, tlvName);
  compare('licence_tlv_number', licenceNumber, tlvNumber);
  compare('licence_tlv_company_type', licenceType, tlvType, 1, normalizeCompanyType);
  compare('licence_tlv_status', licenceStatus, tlvStatus, 1, normalizeLicenceStatus);
  compare('licence_tlv_address', licenceAddress, tlvAddress, 0.75);
  compare('licence_tlv_business_manager', licenceManagers, tlvManagers, 0.8);
  for (const owner of documentOwnerDetails(item)) {
    const verified = verifiedLicencePeople(item).owners.find((person) =>
      normalize(person?.name || person?.full_name || person?.fullName || '') === normalize(owner.name));
    const printedPercent = owner.shareholding_percent;
    const verifiedPercent = verified?.shareholding_percent || verified?.shareholding_percentage;
    if (!printedPercent || printedPercent === 'Not Found' || !verifiedPercent || verifiedPercent === 'Not Found') continue;
    const key = sha256(normalize(owner.name)).slice(0, 16);
    const printed = add(`owners.${key}.printed_shareholding`, printedPercent, owner.source_id, 'data.owner_details');
    const provider = add(`owners.${key}.verified_shareholding`, verifiedPercent, tlvSource, 'raw_response');
    compare('owner_shareholding_tlv', printed, provider, 1, normalizeShareholding);
  }
  compare('licence_tlv_expiry', licenceExpiry, tlvExpiry);
  compare('supplier_licence_expiry', add('supplier.licence_expiry', item.draft.licence_expiry, 'supplier', 'draft.licence_expiry'), licenceExpiry);
  compare('supplier_identity_expiry', add('supplier.natural_id_expiry', item.draft.natural_id_expiry, 'supplier', 'draft.natural_id_expiry'), identityExpiry);
  compare('supplier_representative_expiry', add('supplier.representative_id_expiry', item.draft.representative_id_expiry, 'supplier', 'draft.representative_id_expiry'), representativeExpiry);
  compare('licence_formation_name', licenceName, moaName);
  compare('licence_formation_number', licenceNumber, moaNumber);
  compare('licence_utility_address', licenceAddress, utilityAddress);
  compare('licence_utility_name', licenceName, utilityName);
  compare('licence_premises_address', licenceAddress, premisesAddress);
  compare('declared_premises_address', add('supplier.operating_address', item.draft.operating_address,
    'supplier', 'draft.operating_address'), premisesAddress, 0.75);
  compare('licence_premises_tenant', licenceName, premisesTenant);
  compare('licence_bank_owner_name', licenceName, bankOwner);
  compare('supplier_bank_account_holder', declaredName, bankAccountHolder);
  compare('bank_letterhead_name', bankName, letterheadName);
  compare('declared_bank_letter_iban', declaredIban, bankIban);
  compare('bank_statement_account_holder', bankAccountHolder, statementHolder);
  compare('bank_statement_bank_name', bankName, statementBank);
  compare('bank_statement_iban', bankIban, statementIban);
  compare('bank_statement_account_number', bankAccountNumber, statementAccountNumber);
  compare('bank_statement_branch', bankBranch, statementBranch, 0.85);
  compare('bank_statement_country', bankCountry, statementCountry);
  if (bankDoc) {
    const submitted = item.submitted_at ? new Date(item.submitted_at) : new Date();
    const issued = /^\d{4}-\d{2}-\d{2}$/.test(bankDate?.value || '') ? new Date(`${bankDate.value}T00:00:00Z`) : null;
    const cutoff = new Date(Date.UTC(submitted.getUTCFullYear(), submitted.getUTCMonth() - 1,
      Math.min(submitted.getUTCDate(), new Date(Date.UTC(submitted.getUTCFullYear(), submitted.getUTCMonth(), 0)).getUTCDate())));
    const current = issued && !Number.isNaN(issued.valueOf()) && issued >= cutoff && issued <= submitted;
    comparisons.push({ comparison_id: randomUUID(), rule_version: '1.0.0', rule: 'bank_letter_freshness',
      left_fact_id: bankDate?.fact_id || null, right_fact_id: null,
      outcome: !issued ? 'unavailable' : current ? 'match' : 'mismatch',
      reason: !issued ? 'issue_date_unavailable' : current ? 'dated_within_one_calendar_month' : 'issue_date_outside_window' });
  }
  // The 70% rule is limited to Ejari tenant name versus the trade licence.
  compare('ejari_tenant_licence_name', ejariTenant, licenceName, 0.7);
  const moaShareholders = Array.isArray(moa.shareholders) ? moa.shareholders : [];
  for (const person of item.draft.stakeholders || []) {
    const identity = sha256(normalize(person.name)).slice(0, 16);
    const declared = add(`stakeholders.${identity}.name`, person.name, 'supplier', `draft.stakeholders.${identity}.name`);
    const named = moaShareholders.find((candidate) => normalize(candidate.name) === normalize(person.name));
    const documentFact = named ? add(`formation.shareholders.${identity}.name`, named.name, moaDoc?.document_id, 'data.shareholders') : null;
    compare('shareholder_name_formation', declared, documentFact);
    const declaredOwnership = add(`stakeholders.${identity}.ownership`, person.ownership_percentage, 'supplier', 'draft.stakeholders.ownership_percentage');
    const documentOwnership = named ? add(`formation.shareholders.${identity}.ownership`, named.shareholding_percent, moaDoc?.document_id, 'data.shareholders.shareholding_percent') : null;
    compare('shareholder_ownership_formation', declaredOwnership, documentOwnership);
  }
  return { facts, comparisons };
}
