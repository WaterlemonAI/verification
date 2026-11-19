import { sha256 } from './crypto.mjs';

const normalized = (value) => String(value || '').normalize('NFKC').trim()
  .replace(/\s+/g, ' ').toLocaleLowerCase('en');
const nameOf = (value) => typeof value === 'string' ? value
  : value?.full_name_english || value?.full_name || value?.fullName || value?.name || '';
const printedNames = (value) => typeof value === 'string' && value !== 'Not Found'
  ? value.split(/[;\n]+/).map((name) => name.trim()).filter(Boolean) : [];

export function hasDocumentOwnerNames(item) {
  return ['trade_licence', 'incorporation_record'].some((type) => {
    const doc = item.documents?.findLast((entry) => entry.type === type);
    return printedNames(doc?.extraction_result?.data?.stakeholder_names).length > 0;
  });
}

export function discoverGenericStakeholders(item) {
  if (item.draft?.supplier_type === 'Natural person') return [];
  const people = new Map();
  const business = normalized(item.draft?.business_name);
  function add(value, role, sourceId) {
    const name = String(nameOf(value)).trim().replace(/\s+/g, ' ');
    const key = normalized(name);
    if (!key || key === business || key === 'not found' || name.length > 150 || name.length < 2) return;
    if (!people.has(key)) people.set(key, { subject_id: sha256(`${item.application_id}:${key}`).slice(0, 32),
      name, type: 'individual', roles: [], source_ids: [] });
    const subject = people.get(key);
    if (!subject.roles.includes(role)) subject.roles.push(role);
    if (sourceId && !subject.source_ids.includes(sourceId)) subject.source_ids.push(sourceId);
  }
  for (const person of Array.isArray(item.draft?.stakeholders) ? item.draft.stakeholders : [])
    add(person, person.role || 'declared stakeholder', 'supplier');
  for (const [type, role] of [['trade_licence', 'licence owner or director'],
    ['incorporation_record', 'registry owner or director']]) {
    const doc = item.documents?.findLast((entry) => entry.type === type);
    for (const name of printedNames(doc?.extraction_result?.data?.stakeholder_names))
      add(name, role, doc.document_id);
  }
  const representative = item.documents?.findLast((entry) => entry.type === 'identity_document');
  add(representative?.extraction_result?.data?.full_name_english,
    'representative', representative?.document_id);
  const tlvCheck = item.checks?.findLast((check) => check.service_id === 'uae-trade-licence');
  const tlv = tlvCheck?.raw_response?.uae_tl_verification
    || tlvCheck?.raw_response?.trade_licence_verification_api || {};
  for (const key of ['directors_business_owners', 'directors', 'owners', 'business_managers']) {
    const values = tlv[key];
    for (const person of Array.isArray(values) ? values : printedNames(values))
      add(person, key.replaceAll('_', ' '), tlvCheck?.check_id);
  }
  return [...people.values()].slice(0, 25);
}
