import { FLOW_ID, TEMPLATE_VERSION } from './contract.mjs';

export const KYS_DEFINITION = Object.freeze({
  flow_id: FLOW_ID, version: TEMPLATE_VERSION,
  stages: ['business_information', 'stakeholders', 'documents', 'evidence_review', 'submission'],
  required_documents: ['trade_licence', 'formation_document', 'bank_letter'],
  optional_documents: ['tax_certificate', 'ejari', 'utility_bill', 'board_resolution', 'power_of_attorney', 'identity_document'],
  checks: ['trade_licence_verification', 'iban_verification', 'ejari_verification', 'entity_aml', 'entity_adverse_media', 'stakeholder_aml', 'stakeholder_adverse_media'],
  ejari_tenant_name_match_threshold: 0.7
});
