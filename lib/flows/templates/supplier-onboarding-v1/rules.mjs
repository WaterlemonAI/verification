import { SUPPLIER_DEFINITION } from './definition.mjs';

const textFields = new Set([
  'supplierType', 'tradingName', 'formerNames', 'website', 'representativeEmail', 'representativePhone',
  'representativeTitle', 'identityType', 'authorityBasis', 'meetingAvailability', 'ownershipComplete',
  'locationEvidenceType', 'registeredAddressSame', 'operatingAddress', 'siteActivities', 'fulfilmentLocations',
  'addressChanges', 'keyPersonChanges', 'addressChangeExplanation', 'keyPersonExplanation',
  'vatRegistered', 'vatReason', 'thirdPartyPayments', 'thirdPartyDetail', 'cashPayment', 'cashDetail',
  'recommendationNote', 'supplyType', 'staffCount', 'supplyDescription', 'unusualCapacity', 'capacityDetail',
  'goodsOrigin', 'goodsRights', 'goodsRightsDetail', 'intermediary', 'intermediaryDetail', 'priceExplanation'
]);
const booleanFields = new Set(['accuracyDeclaration', 'screeningConsent', 'controlledTest', 'testDeclaration']);
const optionValues = {
  supplierType: ['legal_entity', 'natural_person'],
  identityType: ['emirates_id', 'passport'], ownershipComplete: ['yes', 'no'],
  authorityBasis: ['director', 'power_of_attorney', 'board_resolution', 'employee_authorisation'],
  locationEvidenceType: ['ejari', 'tenancy', 'ownership', 'utility', 'other'],
  registeredAddressSame: ['yes', 'no'], vatRegistered: ['yes', 'no'],
  thirdPartyPayments: ['yes', 'no'], cashPayment: ['yes', 'no'],
  unusualCapacity: ['yes', 'no'], intermediary: ['yes', 'no'],
  supplyType: ['goods', 'services', 'both'], goodsRights: ['own', 'right_to_dispose', 'other']
};
const requiredText = ['supplierType', 'representativeEmail', 'representativePhone', 'identityType',
  'locationEvidenceType', 'registeredAddressSame', 'siteActivities', 'addressChanges',
  'keyPersonChanges', 'vatRegistered', 'thirdPartyPayments', 'cashPayment', 'supplyType',
  'staffCount', 'supplyDescription', 'unusualCapacity', 'intermediary'];

export function validateSupplierDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_draft');
  const draft = {};
  for (const [key, value] of Object.entries(input)) {
    if (textFields.has(key)) {
      if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u001f]/.test(value)) throw new Error(`invalid_${key}`);
      const trimmed = value.trim();
      if (optionValues[key] && trimmed && !optionValues[key].includes(trimmed)) throw new Error(`invalid_${key}`);
      if (key === 'representativeEmail' && trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
        throw new Error('invalid_representativeEmail');
      if (key === 'website' && trimmed) {
        let url;
        try { url = new URL(trimmed); } catch { throw new Error('invalid_website'); }
        if (!['https:', 'http:'].includes(url.protocol) || !url.hostname.includes('.')) throw new Error('invalid_website');
      }
      if (['staffCount', 'addressChanges', 'keyPersonChanges'].includes(key) && trimmed
        && (!/^[0-9]+$/.test(trimmed) || Number(trimmed) > 1000000)) throw new Error(`invalid_${key}`);
      draft[key] = trimmed;
    } else if (booleanFields.has(key)) {
      if (typeof value !== 'boolean') throw new Error(`invalid_${key}`);
      draft[key] = value;
    } else if (key === 'owners') {
      if (!Array.isArray(value) || value.length > 50) throw new Error('invalid_owners');
      draft.owners = value.map((owner) => {
        if (!owner || typeof owner !== 'object' || Array.isArray(owner)) throw new Error('invalid_owner');
        const result = {};
        for (const field of ['fullName', 'role', 'share', 'nationality']) {
          if (owner[field] == null) continue;
          if (typeof owner[field] !== 'string' || owner[field].length > 200) throw new Error('invalid_owner');
          result[field] = owner[field].trim();
          if (field === 'share' && result[field] && (!/^(?:100(?:\.0+)?|[0-9]{1,2}(?:\.[0-9]{1,2})?)$/.test(result[field])))
            throw new Error('invalid_owner_share');
        }
        return result;
      });
    } else throw new Error('invalid_draft_field');
  }
  return draft;
}

export function supplierRequirements(draft) {
  const text = [...requiredText];
  const documents = [...SUPPLIER_DEFINITION.required_documents];
  if (draft.supplierType === 'legal_entity') {
    text.push('representativeTitle', 'authorityBasis', 'ownershipComplete');
    documents.push('tradeLicenceFile');
    if (draft.authorityBasis === 'power_of_attorney') documents.push('poaFile');
    if (draft.authorityBasis === 'board_resolution') documents.push('brFile');
    if (draft.authorityBasis === 'employee_authorisation') documents.push('authorisationFile');
  } else if (draft.supplierType === 'natural_person') text.push('meetingAvailability');
  if (draft.vatRegistered === 'yes') documents.push('vatFile');
  if (draft.vatRegistered === 'no') text.push('vatReason');
  if (draft.registeredAddressSame === 'no') text.push('operatingAddress');
  if (Number(draft.addressChanges) > 0) text.push('addressChangeExplanation');
  if (Number(draft.keyPersonChanges) > 0) text.push('keyPersonExplanation');
  if (draft.thirdPartyPayments === 'yes') text.push('thirdPartyDetail');
  if (draft.cashPayment === 'yes') text.push('cashDetail');
  if (draft.unusualCapacity === 'yes') text.push('capacityDetail');
  if (['goods', 'both'].includes(draft.supplyType)) {
    text.push('goodsOrigin', 'goodsRights');
    if (draft.goodsRights === 'other') text.push('goodsRightsDetail');
  }
  if (draft.intermediary === 'yes') text.push('intermediaryDetail');
  return { text, documents };
}

export function supplierSubmissionGaps(item) {
  const draft = item.draft || {};
  const { text, documents } = supplierRequirements(draft);
  const gaps = text.filter((field) => !String(draft[field] ?? '').trim());
  gaps.push(...documents.filter((field) => !(item.documents || []).some((doc) => doc.type === field)));
  if (draft.ownershipComplete === 'no'
    && (!Array.isArray(draft.owners) || !draft.owners.length || draft.owners.some((owner) => !owner.fullName || !owner.role)))
    gaps.push('owners');
  if (draft.controlledTest === true) gaps.push('controlledTest');
  if (draft.accuracyDeclaration !== true) gaps.push('accuracyDeclaration');
  if (draft.screeningConsent !== true) gaps.push('screeningConsent');
  return [...new Set(gaps)];
}
