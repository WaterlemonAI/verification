import { sha256 } from '../../crypto.mjs';

const normalize = (value) => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
const personName = (value) => typeof value === 'string' ? value.trim()
  : String(value?.full_name_english || value?.full_name || value?.fullName || value?.name
    || value?.name_english || value?.manager_name || '').trim();
const list = (value) => Array.isArray(value) ? value : [];

export function discoverSupplierSubjects(item) {
  const documents = item.documents || [];
  const doc = (type) => documents.findLast((entry) => entry.type === type);
  const data = (type) => doc(type)?.extraction_result?.data?.data || doc(type)?.extraction_result?.data || {};
  const licence = data('tradeLicenceFile');
  const moa = data('moaFile'); const aoa = data('aoaFile');
  const identity = data('identityFile'); const poa = data('poaFile'); const board = data('brFile');
  const supplierName = licence.company_name_english || moa.company_name || item.draft?.tradingName
    || identity.full_name_english || '';
  const subjects = [];
  if (supplierName) subjects.push({ subject_id: item.application_id, name: supplierName,
    type: item.draft?.supplierType === 'natural_person' ? 'individual' : 'business',
    roles: ['supplier'], source_ids: ['supplier', doc('tradeLicenceFile')?.document_id].filter(Boolean) });
  const people = new Map();
  function add(value, role, sourceId) {
    const name = personName(value);
    if (!name || item.draft?.supplierType === 'natural_person' && normalize(name) === normalize(supplierName)) return;
    const key = normalize(name);
    if (!people.has(key)) people.set(key, { subject_id: sha256(`${item.application_id}:${key}`).slice(0, 32),
      name, type: 'individual', roles: [], source_ids: [] });
    const person = people.get(key);
    if (!person.roles.includes(role)) person.roles.push(role);
    if (sourceId && !person.source_ids.includes(sourceId)) person.source_ids.push(sourceId);
  }
  add(identity.full_name_english || [identity.given_names, identity.surnames].filter(Boolean).join(' '),
    'representative', doc('identityFile')?.document_id);
  for (const owner of list(item.draft?.owners)) add(owner.fullName, owner.role || 'declared owner', 'supplier');
  for (const person of list(licence.business_managers || licence.managers)) add(person, 'business manager', doc('tradeLicenceFile')?.document_id);
  for (const person of list(licence.directors_business_owners)) add(person, 'director or owner', doc('tradeLicenceFile')?.document_id);
  for (const person of list(moa.shareholders)) add(person, 'MOA shareholder', doc('moaFile')?.document_id);
  for (const person of list(aoa.directors)) add(person, 'AOA director', doc('aoaFile')?.document_id);
  const boardSignatories = board.authorised_people || board.signatories || board.authorised_signatories;
  for (const person of Array.isArray(boardSignatories) ? boardSignatories
    : typeof boardSignatories === 'string' && boardSignatories !== 'Not Found'
      ? boardSignatories.split(/[,;\n]+/).map((value) => value.trim()).filter(Boolean) : [])
    add(person, 'board signatory', doc('brFile')?.document_id);
  add(poa.name_of_poa, 'power of attorney holder', doc('poaFile')?.document_id);
  subjects.push(...people.values());
  return subjects;
}
