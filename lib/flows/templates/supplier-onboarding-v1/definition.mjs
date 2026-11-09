export const SUPPLIER_FLOW_ID = 'supplier-onboarding-v1';
export const SUPPLIER_VERSION = '1.0.0';

export const SUPPLIER_DEFINITION = Object.freeze({
  flow_id: SUPPLIER_FLOW_ID, version: SUPPLIER_VERSION,
  stages: ['business_documents', 'people_and_premises', 'tax_and_banking',
    'supply_and_declaration', 'verification_review'],
  required_documents: ['identityFile', 'locationEvidenceFile', 'bankConfirmationFile'],
  conditional_documents: ['tradeLicenceFile', 'poaFile', 'brFile', 'authorisationFile', 'vatFile'],
  optional_documents: ['incorporationFile', 'moaFile', 'aoaFile', 'corporateTaxFile',
    'thirdPartyAgreementFile', 'clientRecommendations', 'goodsEvidenceFile',
    'intermediaryAgreementFile', 'transactionFile'],
  checks: ['trade_licence_verification', 'iban_verification', 'ejari_verification',
    'entity_aml', 'entity_adverse_media', 'person_aml', 'person_adverse_media'],
  ejari_tenant_name_match_threshold: 0.7,
  accepts_executable_uploads: false
});
