import { sha256 } from './crypto.mjs';
import { kysTemplate } from './templates/kys-v1.mjs';
import { supplierTemplate } from './templates/supplier-onboarding-v1/index.mjs';
import { genericTemplate, schemaHash } from './template-schema.mjs';

const packages = Object.freeze([kysTemplate, supplierTemplate]);
const idPattern = /^[a-z][a-z0-9-]{2,63}$/;

function checked(template) {
  if (!idPattern.test(template.flow_id) || !/^\d+\.\d+\.\d+$/.test(template.version)
    || !/^[a-z][a-z0-9-]{2,63}$/.test(template.supplierBundle)
    || typeof template.validateDraft !== 'function' || typeof template.submissionGaps !== 'function'
    || typeof template.process !== 'function' || !Array.isArray(template.allowedDocumentTypes))
    throw new Error('invalid_flow_package');
  return Object.freeze({ ...template, definition_hash: sha256(JSON.stringify(template.definition)) });
}

const registry = new Map(packages.map((entry) => {
  const template = checked(entry);
  return [`${template.flow_id}@${template.version}`, template];
}));

export function validFlowId(value) { return idPattern.test(value || ''); }
export function resolveTemplate(flowId, version) {
  return registry.get(`${flowId}@${version}`) || null;
}
export function latestTemplate(flowId) {
  return [...registry.values()].filter((entry) => entry.flow_id === flowId)
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0] || null;
}
export function listTemplates() { return [...registry.values()].map(({ flow_id, version, definition, definition_hash }) =>
  ({ flow_id, version, definition, definition_hash })); }

export async function resolveCaseTemplate(item, store) {
  const legacy = resolveTemplate(item.flow_id, item.template_version);
  if (legacy) return !item.definition_hash || item.definition_hash === legacy.definition_hash ? legacy : null;
  const schema = item.workflow_schema || await store.getWorkflowVersion(item.flow_id, item.template_version);
  if (!schema || schemaHash(schema) !== item.definition_hash) return null;
  return genericTemplate(item.flow_id, item.template_version, schema);
}
