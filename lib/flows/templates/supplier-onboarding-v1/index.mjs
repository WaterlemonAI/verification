import { processFloApplication } from '../../processor.mjs';
import { SUPPLIER_DEFINITION, SUPPLIER_FLOW_ID, SUPPLIER_VERSION } from './definition.mjs';
import { supplierSubmissionGaps, validateSupplierDraft } from './rules.mjs';

export const supplierTemplate = Object.freeze({
  flow_id: SUPPLIER_FLOW_ID, version: SUPPLIER_VERSION, definition: SUPPLIER_DEFINITION,
  validateDraft: validateSupplierDraft, submissionGaps: supplierSubmissionGaps,
  allowedDocumentTypes: Object.freeze([...SUPPLIER_DEFINITION.required_documents,
    ...SUPPLIER_DEFINITION.conditional_documents, ...SUPPLIER_DEFINITION.optional_documents]),
  process: (job, dependencies) => processFloApplication(job, { ...dependencies, profile: SUPPLIER_FLOW_ID }),
  supplierBundle: 'supplier-onboarding-v1'
});
