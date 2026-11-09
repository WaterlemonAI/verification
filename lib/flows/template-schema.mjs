import { sha256 } from './crypto.mjs';
import { validateChecks, CHECK_CATALOG_VERSION } from './checks-catalog.mjs';
import { processGenericFloApplication } from './processor.mjs';
import { validateHttpsUrl } from './contract.mjs';

const id = /^[a-z][a-z0-9_]{1,63}$/;
const text = (value, max = 120) => typeof value === 'string' && value.trim() && value.length <= max
  && !/[<>\u0000-\u001f]/.test(value) && !/javascript:|data:|onerror\s*=|onload\s*=/i.test(value);
const exact = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj)
  && Object.keys(obj).every((key) => keys.includes(key));
function fail(path) { throw new Error(`invalid_schema:${path}`); }
function condition(value, path, earlier) {
  if (value == null) return null;
  if (!exact(value, ['field', 'equals']) || !earlier.has(value.field) || !text(value.equals, 200)) fail(path);
  return value;
}

export function validateWorkflowSchema(value, allowedChecks) {
  if (!exact(value, ['schema_version', 'name', 'stages', 'checks', 'report_sections', 'tokens'])
    || JSON.stringify(value).length > 65536 || value.schema_version !== '1.0.0'
    || !text(value.name, 100) || !Array.isArray(value.stages) || !value.stages.length || value.stages.length > 8)
    fail('root');
  const seen = new Set(); const earlier = new Set(); let fieldCount = 0; let docCount = 0;
  for (const [si, stage] of value.stages.entries()) {
    if (!exact(stage, ['id', 'title', 'description', 'fields', 'documents', 'declarations'])
      || !id.test(stage.id) || seen.has(stage.id) || !text(stage.title) || stage.description && !text(stage.description, 400)
      || !Array.isArray(stage.fields) || !Array.isArray(stage.documents) || !Array.isArray(stage.declarations)) fail(`stages.${si}`);
    seen.add(stage.id);
    for (const [fi, field] of stage.fields.entries()) {
      const path = `stages.${si}.fields.${fi}`;
      if (!exact(field, ['id', 'label', 'type', 'required', 'options', 'show_if', 'max_length'])
        || !id.test(field.id) || seen.has(field.id) || !text(field.label)
        || !['text', 'email', 'url', 'date', 'select', 'textarea', 'number', 'people'].includes(field.type)
        || typeof field.required !== 'boolean' || field.max_length != null
          && (!Number.isInteger(field.max_length) || field.max_length < 1 || field.max_length > 2000)) fail(path);
      if (field.type === 'select') {
        if (!Array.isArray(field.options) || !field.options.length || field.options.length > 40
          || new Set(field.options).size !== field.options.length || field.options.some((option) => !text(option, 100))) fail(`${path}.options`);
      } else if (field.options != null) fail(`${path}.options`);
      condition(field.show_if, `${path}.show_if`, earlier);
      seen.add(field.id); earlier.add(field.id); fieldCount++;
    }
    for (const [di, document] of stage.documents.entries()) {
      const path = `stages.${si}.documents.${di}`;
      if (!exact(document, ['id', 'label', 'required', 'show_if']) || !id.test(document.id)
        || seen.has(document.id) || !text(document.label) || typeof document.required !== 'boolean') fail(path);
      condition(document.show_if, `${path}.show_if`, earlier);
      seen.add(document.id); docCount++;
    }
    for (const [di, declaration] of stage.declarations.entries()) {
      if (!exact(declaration, ['id', 'label', 'required']) || !id.test(declaration.id)
        || seen.has(declaration.id) || !text(declaration.label, 500) || declaration.required !== true) fail(`stages.${si}.declarations.${di}`);
      seen.add(declaration.id);
    }
  }
  if (fieldCount > 80 || docCount > 30) fail('limits');
  validateChecks(value.checks, allowedChecks);
  const fields = new Map(value.stages.flatMap((stage) => stage.fields.map((field) => [field.id, field.type])));
  const docs = new Set(value.stages.flatMap((stage) => stage.documents.map((doc) => doc.id)));
  for (const check of value.checks) {
    if (['entity-aml', 'entity-adverse-media', 'uae-trade-licence', 'iban-verification'].includes(check)
      && !fields.has('business_name')) fail(`checks.${check}.business_name`);
    if (check === 'uae-trade-licence' && (!fields.has('licence_number') || !docs.has('trade_licence')))
      fail(`checks.${check}.evidence`);
    if (check === 'iban-verification' && (!docs.has('bank_letter') || !fields.has('iban'))) fail(`checks.${check}.evidence`);
    if (check === 'ejari-verification' && !docs.has('ejari')) fail(`checks.${check}.evidence`);
    if (check === 'merchant-screening' && !fields.has('website_url')) fail(`checks.${check}.website_url`);
    if (check.startsWith('stakeholder-') && fields.get('stakeholders') !== 'people') fail(`checks.${check}.stakeholders`);
  }
  if (value.report_sections != null && (!Array.isArray(value.report_sections) || value.report_sections.length > 20
    || value.report_sections.some((section) => !text(section)))) fail('report_sections');
  if (value.tokens != null && (!exact(value.tokens, ['primary_color', 'accent_color'])
    || Object.values(value.tokens).some((color) => !/^#[0-9a-fA-F]{6}$/.test(color)))) fail('tokens');
  return structuredClone(value);
}

export function schemaHash(schema) { return sha256(JSON.stringify(schema)); }
export function schemaPresentation(schema) {
  const { schema_version, name, stages, tokens } = schema;
  return { schema_version, name, stages, tokens: tokens || {} };
}
export function schemaDraft(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_draft');
  const fields = schema.stages.flatMap((stage) => stage.fields);
  const byId = new Map(fields.map((field) => [field.id, field]));
  if (Object.keys(input).some((key) => !byId.has(key))) throw new Error('invalid_draft_field');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const field = byId.get(key);
    if (field.type === 'people') {
      if (!Array.isArray(value) || value.length > 25) throw new Error(`invalid_draft:${key}`);
      out[key] = value.map((person) => {
        if (!person || typeof person !== 'object' || Array.isArray(person)
          || Object.keys(person).some((name) => !['name', 'role', 'ownership_percentage'].includes(name))
          || !text(person.name, 200) || !text(person.role, 100)
          || person.ownership_percentage != null && (!Number.isFinite(Number(person.ownership_percentage))
            || Number(person.ownership_percentage) < 0 || Number(person.ownership_percentage) > 100))
          throw new Error(`invalid_draft:${key}`);
        return { name: person.name.trim(), role: person.role.trim(),
          ownership_percentage: person.ownership_percentage == null ? null : Number(person.ownership_percentage) };
      });
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`invalid_draft:${key}`);
    const normalized = String(value).trim();
    if (normalized.length > (field.max_length || 2000) || /[\u0000-\u001f]/.test(normalized)) throw new Error(`invalid_draft:${key}`);
    if (field.type === 'select' && !field.options.includes(normalized)) throw new Error(`invalid_draft:${key}`);
    if (field.type === 'email' && normalized && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error(`invalid_draft:${key}`);
    if (field.type === 'url' && normalized) {
      try { validateHttpsUrl(normalized); } catch { throw new Error(`invalid_draft:${key}`); }
    }
    if (field.type === 'number' && normalized && !Number.isFinite(Number(normalized))) throw new Error(`invalid_draft:${key}`);
    if (field.type === 'date' && normalized && !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error(`invalid_draft:${key}`);
    out[key] = normalized;
  }
  return out;
}
export function schemaSubmissionGaps(schema, item) {
  const gaps = [];
  const draft = item.draft || {};
  const visible = (entry) => !entry.show_if || draft[entry.show_if.field] === entry.show_if.equals;
  for (const stage of schema.stages) {
    for (const field of stage.fields) if (visible(field) && field.required
      && (!draft[field.id] || Array.isArray(draft[field.id]) && !draft[field.id].length)) gaps.push(field.id);
    for (const document of stage.documents) if (visible(document) && document.required
      && !item.documents?.some((entry) => entry.type === document.id)) gaps.push(document.id);
    for (const declaration of stage.declarations) if (declaration.required && item.declarations?.[declaration.id] !== true) gaps.push(declaration.id);
  }
  return gaps;
}
export function genericTemplate(flowId, version, schema) {
  const definition_hash = schemaHash(schema);
  return { flow_id: flowId, version, definition: schema, definition_hash, supplierBundle: 'renderer',
    allowedDocumentTypes: schema.stages.flatMap((stage) => stage.documents.map((doc) => doc.id)),
    validateDraft: (input) => schemaDraft(schema, input),
    submissionGaps: (item) => schemaSubmissionGaps(schema, item),
    process: processGenericFloApplication, catalog_version: CHECK_CATALOG_VERSION };
}
