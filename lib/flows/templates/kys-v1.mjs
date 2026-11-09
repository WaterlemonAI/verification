import { FLOW_ID, TEMPLATE_VERSION, submissionGaps, validateDraft } from '../contract.mjs';
import { KYS_DEFINITION } from '../definition.mjs';
import { processFloApplication } from '../processor.mjs';

export const kysTemplate = Object.freeze({
  flow_id: FLOW_ID, version: TEMPLATE_VERSION, definition: KYS_DEFINITION,
  validateDraft, submissionGaps,
  allowedDocumentTypes: Object.freeze([...KYS_DEFINITION.required_documents, ...KYS_DEFINITION.optional_documents]),
  process: processFloApplication,
  supplierBundle: 'kys-v1'
});
