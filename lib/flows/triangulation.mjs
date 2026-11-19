import { randomUUID } from 'node:crypto';
import { sha256 } from './crypto.mjs';

function normalize(value) {
  return String(value || '').toLocaleLowerCase('en').normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
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
  function add(path, value, sourceId, sourcePath) {
    if (value === undefined || value === null || value === '' || value === 'Not Found' || value === 'Not Readable') return null;
    const fact = { fact_id: randomUUID(), field_path: path, value, source_id: sourceId,
      source_path: sourcePath, extraction_method: sourceId === 'supplier' ? 'declared' : 'document_ocr',
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
  const licenceAddress = add('licence.address', licence.address, licenceDoc?.document_id, 'data.address');
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
  const premisesDoc = item.documents.findLast((doc) => doc.type === 'premises_evidence');
  const premises = premisesDoc?.extraction_result?.data || {};
  const premisesAddress = add('premises.address', premises.address, premisesDoc?.document_id, 'data.address');
  const premisesTenant = add('premises.tenant_name', premises.tenant_name, premisesDoc?.document_id, 'data.tenant_name');
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
  add('bank_letter.branch_name', bank.branch_name, bankDoc?.document_id, 'data.branch_name');
  const bankIban = add('bank_letter.iban', bank.iban, bankDoc?.document_id, 'data.iban');
  const declaredIban = add('business.iban', item.draft.iban, 'supplier', 'draft.iban');
  const ejariDoc = item.documents.findLast((doc) => doc.type === 'ejari');
  const ejari = ejariDoc?.extraction_result?.data?.fields || {};
  const ejariTenant = add('ejari.tenant_name', ejari.tenant_name, ejariDoc?.document_id, 'data.fields.tenant_name');
  const comparisons = [];
  function compare(rule, left, right, threshold = 1) {
    const leftValue = rule.includes('iban') && left ? normalize(left.value).replaceAll(' ', '') : left ? normalize(left.value) : null;
    const rightValue = rule.includes('iban') && right ? normalize(right.value).replaceAll(' ', '') : right ? normalize(right.value) : null;
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
  compare('licence_formation_name', licenceName, moaName);
  compare('licence_formation_number', licenceNumber, moaNumber);
  compare('licence_utility_address', licenceAddress, utilityAddress);
  compare('licence_utility_name', licenceName, utilityName);
  compare('licence_premises_address', licenceAddress, premisesAddress);
  compare('licence_premises_tenant', licenceName, premisesTenant);
  compare('licence_bank_owner_name', licenceName, bankOwner);
  compare('supplier_bank_account_holder', declaredName, bankAccountHolder);
  compare('bank_letterhead_name', bankName, letterheadName);
  compare('declared_bank_letter_iban', declaredIban, bankIban);
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
