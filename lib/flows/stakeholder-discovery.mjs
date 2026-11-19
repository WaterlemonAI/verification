import { sha256 } from './crypto.mjs';

const normalized = (value) => String(value || '').normalize('NFKC').trim()
  .replace(/\s+/g, ' ').toLocaleLowerCase('en');
const nameOf = (value) => typeof value === 'string'
  ? /^name\s*:/i.test(value) ? value.replace(/^name\s*:/i, '').split(/[,|]/)[0].trim() : value
  : value?.full_name_english || value?.full_name || value?.fullName || value?.name
    || value?.manager_name || value?.person_name || '';
const printedNames = (value) => typeof value === 'string' && value !== 'Not Found'
  ? value.split(/[;\n]+/).map((name) => name.trim()).filter(Boolean) : [];
const personRows = (value) => Array.isArray(value) ? value
  : value && typeof value === 'object' ? [value] : printedNames(value);
const ownerRows = (value) => printedNames(value).map((entry) => {
  const [name = '', role = '', shareholding_percent = ''] = entry.split('|').map((part) => part.trim());
  return { name, role, shareholding_percent };
}).filter((row) => row.name);
const usable = (value) => typeof value === 'string' && value.trim()
  && !['not found', 'not readable'].includes(value.trim().toLowerCase());
const sourceValues = (record, keys) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  const desired = new Set(keys.map((key) => key.replace(/[^a-z0-9]/gi, '').toLowerCase()));
  return Object.entries(record).filter(([key]) => desired.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase()))
    .map(([, value]) => value);
};

export function verifiedLicencePeople(item) {
  const check = item.checks?.findLast((entry) => entry.service_id === 'uae-trade-licence');
  const response = check?.raw_response || {};
  const result = response.uae_tl_verification || response.trade_licence_verification_api || {};
  const managerKeys = ['business_managers', 'managers', 'business_manager', 'manager', 'business_manager_name'];
  const ownerKeys = ['directors_business_owners', 'directors', 'owners', 'shareholders'];
  const managers = [...sourceValues(result, managerKeys), ...sourceValues(response, managerKeys)].flatMap(personRows);
  const owners = [...sourceValues(result, ownerKeys), ...sourceValues(response, ownerKeys)].flatMap(personRows);
  return { managers, owners, source_id: check?.check_id || null };
}

export function verifiedManagerNames(item) {
  return [...new Set(verifiedLicencePeople(item).managers.map((person) => String(nameOf(person)).trim())
    .filter((name) => name && !['not found', 'not readable', 'none', 'null'].includes(name.toLowerCase())))]
    .sort((a, b) => a.localeCompare(b));
}

export function hasDocumentOwnerNames(item) {
  return ['trade_licence', 'incorporation_record'].some((type) => {
    const doc = item.documents?.findLast((entry) => entry.type === type);
    const data = doc?.extraction_result?.data || {};
    return printedNames(data.stakeholder_names).length > 0 || ownerRows(data.owner_details).length > 0;
  });
}

export function documentOwnerDetails(item) {
  return ['trade_licence', 'incorporation_record'].flatMap((type) => {
    const doc = item.documents?.findLast((entry) => entry.type === type);
    return ownerRows(doc?.extraction_result?.data?.owner_details)
      .map((row) => ({ ...row, source_id: doc.document_id }));
  });
}

export function discoverGenericStakeholders(item) {
  if (item.draft?.supplier_type === 'Natural person') return [];
  const people = new Map();
  const business = normalized(item.draft?.business_name);
  function add(value, role, sourceId) {
    const name = String(nameOf(value)).trim().replace(/\s+/g, ' ');
    const key = normalized(name);
    if (!key || key === business || ['not found', 'not readable', 'none', 'null', 'n a'].includes(key)
      || name.length > 150 || name.length < 2) return;
    if (!people.has(key)) people.set(key, { subject_id: sha256(`${item.application_id}:${key}`).slice(0, 32),
      name, type: 'individual', roles: [], source_ids: [] });
    const subject = people.get(key);
    if (!subject.roles.includes(role)) subject.roles.push(role);
    if (sourceId && !subject.source_ids.includes(sourceId)) subject.source_ids.push(sourceId);
    const shareholding = value && typeof value === 'object'
      ? value.shareholding_percent || value.shareholding_percentage || value.ownership_percentage : null;
    if (usable(String(shareholding || '')) && !subject.shareholding_percent)
      subject.shareholding_percent = String(shareholding).slice(0, 30);
  }
  for (const person of Array.isArray(item.draft?.stakeholders) ? item.draft.stakeholders : [])
    add(person, person.role || 'declared stakeholder', 'supplier');
  for (const [type, role] of [['trade_licence', 'licence owner or director'],
    ['incorporation_record', 'registry owner or director']]) {
    const doc = item.documents?.findLast((entry) => entry.type === type);
    const data = doc?.extraction_result?.data || {};
    for (const name of printedNames(data.stakeholder_names))
      add(name, role, doc.document_id);
    for (const person of ownerRows(data.owner_details))
      add(person, person.role && person.role !== 'Not Found' ? person.role : role, doc.document_id);
    for (const manager of printedNames(data.business_manager_names))
      add(manager, 'business manager', doc.document_id);
  }
  const representative = item.documents?.findLast((entry) => entry.type === 'identity_document');
  add(representative?.extraction_result?.data?.full_name_english,
    'representative', representative?.document_id);
  const verified = verifiedLicencePeople(item);
  for (const person of verified.owners) add(person, 'verified licence owner or director', verified.source_id);
  for (const person of verified.managers) add(person, 'verified business manager', verified.source_id);
  return [...people.values()].slice(0, 25);
}
