const FIELD_TYPES = new Set(['text', 'textarea', 'email', 'url', 'number', 'date', 'select', 'country', 'boolean']);
const SERVICE_CONTENT_TYPES = new Set(['application/json']);
const PLACEHOLDER = /^\{\{([a-z][a-z0-9_]*)\}\}$/;
const EMBEDDED_PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g;

function cleanText(value, maximum) {
  return String(value ?? '').trim().slice(0, maximum);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function placeholders(value, output = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(EMBEDDED_PLACEHOLDER)) output.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) placeholders(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) placeholders(item, output);
  }
  return output;
}

function validateField(input, used) {
  const key = cleanText(input?.key, 64).toLowerCase();
  const label = cleanText(input?.label, 100);
  const type = cleanText(input?.type || 'text', 20).toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(key)) throw new Error('Each field key must use lowercase letters, numbers, and underscores.');
  if (used.has(key)) throw new Error(`Field key ${key} is duplicated.`);
  if (label.length < 2) throw new Error(`Field ${key} needs a display label.`);
  if (!FIELD_TYPES.has(type)) throw new Error(`Field ${key} has an unsupported type.`);
  const options = type === 'select'
    ? [...new Set((Array.isArray(input.options) ? input.options : []).map((item) => cleanText(item, 100)).filter(Boolean))].slice(0, 100)
    : [];
  if (type === 'select' && !options.length) throw new Error(`Select field ${key} needs at least one option.`);
  used.add(key);
  return {
    key,
    label,
    type,
    required: input.required === true,
    description: cleanText(input.description, 300),
    placeholder: cleanText(input.placeholder, 150),
    options
  };
}

function validateService(input, integrationIds, fieldKeys) {
  const serviceId = cleanText(input?.service_id, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(serviceId)) throw new Error('Every service needs a valid service_id.');
  if (!integrationIds.has(serviceId)) throw new Error(`Service ${serviceId} is not available in the API engine.`);
  const inputTemplate = input?.input_template;
  if (!inputTemplate || typeof inputTemplate !== 'object' || Array.isArray(inputTemplate)) {
    throw new Error(`Service ${serviceId} needs an input_template JSON object.`);
  }
  const unknown = [...placeholders(inputTemplate)].filter((key) => !fieldKeys.has(key));
  if (unknown.length) throw new Error(`Service ${serviceId} maps unknown field(s): ${unknown.join(', ')}.`);
  const contentType = cleanText(input.content_type || 'application/json', 64).toLowerCase();
  if (!SERVICE_CONTENT_TYPES.has(contentType)) throw new Error(`Service ${serviceId} must use application/json in Forms.`);
  return { service_id: serviceId, content_type: contentType, input_template: clone(inputTemplate) };
}

function validateAiAction(input, fields, services) {
  if (input == null || input.enabled !== true) return undefined;
  const fieldKeys = new Set(fields.map((field) => field.key));
  const serviceIds = new Set(services.map((service) => service.service_id));
  const task = String(input.task || '').trim();
  if (task.length < 10 || task.length > 2_000) throw new Error('AI Action task must contain 10–2,000 characters.');
  const selected = (name, available, maximum) => {
    const values = input[name];
    if (!Array.isArray(values) || values.length > maximum || new Set(values).size !== values.length
      || values.some((value) => typeof value !== 'string' || !available.has(value)))
      throw new Error(`AI Action ${name} contains an invalid selection.`);
    return [...values];
  };
  const inputFields = selected('input_fields', fieldKeys, 20);
  const resultServices = selected('result_services', serviceIds, 10);
  const ocrJobFields = selected('ocr_job_fields', new Set(fields.filter((field) => field.type === 'text').map((field) => field.key)), 8);
  if (!inputFields.length && !resultServices.length && !ocrJobFields.length)
    throw new Error('AI Action needs at least one selected data source.');
  return { enabled: true, version: 1, task, input_fields: inputFields,
    result_services: resultServices, ocr_job_fields: ocrJobFields };
}

export function validateFormDefinition(input, integrations = []) {
  const id = cleanText(input?.id, 64).toLowerCase();
  const name = cleanText(input?.name, 100);
  const description = cleanText(input?.description, 600);
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new Error('Form ID must use lowercase letters, numbers, and hyphens.');
  if (name.length < 3) throw new Error('Form name must be between 3 and 100 characters.');
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 50) throw new Error('A Form must define between 1 and 50 fields.');
  if (!Array.isArray(input.services) || input.services.length < 1 || input.services.length > 10) throw new Error('A Form must run between 1 and 10 APIs.');
  const used = new Set();
  const fields = input.fields.map((field) => validateField(field, used));
  const integrationIds = new Set(integrations.filter((item) => item.enabled !== false && item.formsCompatible !== false && !item.internal && item.method === 'POST'
    && (item.native === true || item.acceptedContentTypes?.includes('application/json'))).map((item) => item.id));
  const services = input.services.map((service) => validateService(service, integrationIds, used));
  if (new Set(services.map((service) => service.service_id)).size !== services.length) throw new Error('A Form cannot run the same API more than once.');
  const aiAction = validateAiAction(input.ai_action, fields, services);
  const form = {
    id,
    name,
    description,
    fields,
    services,
    enabled: input.enabled !== false,
    default_logo_url: cleanText(input.default_logo_url, 2048)
  };
  if (aiAction) form.ai_action = aiAction;
  if (Buffer.byteLength(JSON.stringify(form)) > 20 * 1024) throw new Error('The Form definition is too large. Reduce fields, options, or mappings.');
  return form;
}

function validateValue(field, raw) {
  if (raw === undefined || raw === null || raw === '') {
    if (field.required) throw new Error(`${field.label} is required.`);
    return undefined;
  }
  if (field.type === 'boolean') {
    if (typeof raw !== 'boolean') throw new Error(`${field.label} must be true or false.`);
    return raw;
  }
  if (field.type === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${field.label} must be a number.`);
    return value;
  }
  const value = String(raw).trim();
  const maximum = field.type === 'textarea' ? 20_000 : 2_000;
  if (!value || value.length > maximum) throw new Error(`${field.label} is invalid or too long.`);
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`${field.label} must be a valid email address.`);
  if (field.type === 'url') {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error(`${field.label} must be a valid URL.`); }
    if (parsed.protocol !== 'https:') throw new Error(`${field.label} must use HTTPS.`);
  }
  if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field.label} must use YYYY-MM-DD.`);
  if (field.type === 'country' && !/^[A-Z]{2}$/.test(value.toUpperCase())) throw new Error(`${field.label} must be a two-letter country code.`);
  if (field.type === 'select' && !field.options.includes(value)) throw new Error(`${field.label} must be one of its configured options.`);
  return field.type === 'country' ? value.toUpperCase() : value;
}

export function validateFormSubmission(form, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The request body must contain a JSON object.');
  const source = input.data;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('data must be a JSON object.');
  const allowed = new Set(form.fields.map((field) => field.key));
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown form field(s): ${unknown.join(', ')}.`);
  const data = {};
  for (const field of form.fields) {
    const value = validateValue(field, source[field.key]);
    if (value !== undefined) data[field.key] = value;
  }
  return {
    data,
    callback_url: cleanText(input.callback_url, 2048),
    customer_logo_url: cleanText(input.customer_logo_url || form.default_logo_url, 2048)
  };
}

function resolveValue(value, data) {
  if (typeof value === 'string') {
    const exact = PLACEHOLDER.exec(value);
    if (exact) return Object.hasOwn(data, exact[1]) ? data[exact[1]] : undefined;
    return value.replace(EMBEDDED_PLACEHOLDER, (_all, key) => Object.hasOwn(data, key) ? String(data[key]) : '');
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, data)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, resolveValue(item, data)])
      .filter(([, item]) => item !== undefined));
  }
  return value;
}

export function resolveFormServiceInput(service, data) {
  return resolveValue(service.input_template, data);
}

export function publicFormDefinition(form, integrations = []) {
  const names = new Map(integrations.map((item) => [item.id, item.name]));
  return {
    id: form.id,
    name: form.name,
    description: form.description,
    fields: clone(form.fields),
    services: form.services.map((service) => ({ service_id: service.service_id, name: names.get(service.service_id) || service.service_id })),
    enabled: form.enabled,
    version: form.version,
    created_at: form.created_at,
    updated_at: form.updated_at
  };
}

export const formsConfig = Object.freeze({ maximumFields: 50, maximumServices: 10, supportedFieldTypes: [...FIELD_TYPES] });
