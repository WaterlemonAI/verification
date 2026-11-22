import { createHash } from 'node:crypto';
import { validateAdverseMediaRequest } from './adverse-media.mjs';
import { compileAdvancePolicySet } from './adverse-media-advance-policy.mjs';

const PUBLIC_FIELDS = new Set([
  'entity_type', 'name', 'aliases', 'countries', 'languages', 'max_results',
  'callback_url', 'callback_access_key', 'customer_logo_url',
  'policy_selection', 'policy_ids', 'identifiers'
]);
const IDENTIFIER_FIELDS = new Set([
  'registration_numbers', 'trade_licence_numbers', 'tax_numbers', 'lei',
  'domains', 'addresses', 'date_of_birth', 'nationalities', 'associated_organisations'
]);
// Advance adds the locally relevant language to the caller's choices. Keep
// the shared screening API's language defaults and five-language ceiling.
const COUNTRY_LANGUAGES = Object.freeze({
  AE: 'ar', AR: 'es', BE: 'fr', BH: 'ar', BR: 'pt', CA: 'fr', CH: 'de', CN: 'zh',
  DE: 'de', EG: 'ar', ES: 'es', FR: 'fr', HK: 'zh', ID: 'id', IN: 'hi', IR: 'fa',
  IT: 'it', KW: 'ar', MX: 'es', NL: 'nl', OM: 'ar', PK: 'ur', PL: 'pl', QA: 'ar',
  RU: 'ru', SA: 'ar', TR: 'tr', TW: 'zh', UA: 'uk'
});

export function advanceLanguages(countries = [], requested) {
  const languages = requested === undefined ? ['en', 'ar'] : [...requested];
  for (const country of countries || []) {
    const language = COUNTRY_LANGUAGES[String(country).toUpperCase()];
    if (language && !languages.includes(language)) languages.push(language);
  }
  if (languages.length > 5) throw new TypeError('advance_languages_limit_exceeded');
  return languages;
}

function strings(value, maxItems, maxLength, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) =>
    typeof item !== 'string' || !item.trim() || item.length > maxLength || /[\u0000-\u001f]/.test(item))) {
    throw new TypeError(`${label}_invalid`);
  }
  const normalized = value.map((item) => item.trim());
  if (new Set(normalized.map((item) => item.toLowerCase())).size !== normalized.length) {
    throw new TypeError(`${label}_invalid`);
  }
  return normalized;
}

function identifiers(value, entityType) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !IDENTIFIER_FIELDS.has(key))) {
    throw new TypeError('identifiers_invalid');
  }
  const parsed = {};
  for (const [key, maxItems, maxLength] of [
    ['registration_numbers', 10, 100], ['trade_licence_numbers', 10, 100],
    ['tax_numbers', 10, 100], ['domains', 10, 253], ['addresses', 5, 300],
    ['nationalities', 10, 2], ['associated_organisations', 10, 200]
  ]) {
    const values = strings(value[key], maxItems, maxLength, key);
    if (values.length) parsed[key] = values;
  }
  if (value.lei !== undefined) {
    if (typeof value.lei !== 'string' || !/^[A-Z0-9]{20}$/.test(value.lei)) throw new TypeError('lei_invalid');
    parsed.lei = value.lei;
  }
  if (value.date_of_birth !== undefined) {
    if (typeof value.date_of_birth !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date_of_birth)
      || Number.isNaN(Date.parse(`${value.date_of_birth}T00:00:00Z`))
      || new Date(`${value.date_of_birth}T00:00:00Z`).toISOString().slice(0, 10) !== value.date_of_birth) {
      throw new TypeError('date_of_birth_invalid');
    }
    parsed.date_of_birth = value.date_of_birth;
  }
  if (parsed.domains?.some((domain) => !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(domain))) {
    throw new TypeError('domains_invalid');
  }
  if (parsed.nationalities?.some((code) => !/^[A-Z]{2}$/.test(code))) throw new TypeError('nationalities_invalid');
  if (entityType === 'business' && (parsed.date_of_birth || parsed.nationalities)) throw new TypeError('identifiers_invalid');
  if (entityType === 'individual' && (parsed.registration_numbers || parsed.trade_licence_numbers || parsed.lei || parsed.domains)) {
    throw new TypeError('identifiers_invalid');
  }
  return parsed;
}

export function validateAdvanceRequest(input, { trustedRules = {} } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !PUBLIC_FIELDS.has(key))) {
    throw new TypeError('advance_request_invalid');
  }
  if (!input.callback_url) throw new TypeError('callback_url_required');
  if (!Array.isArray(input.countries)) throw new TypeError('countries_required_use_empty_array_for_global');
  const searchRequest = validateAdverseMediaRequest({
    entity_type: input.entity_type, name: input.name, aliases: input.aliases,
    countries: input.countries,
    languages: advanceLanguages(input.countries, input.languages), max_results: input.max_results,
    callback_url: input.callback_url, customer_logo_url: input.customer_logo_url,
    search_plus: true, deep_research: true, archive_review: true
  });
  const policySet = compileAdvancePolicySet({
    ...(input.policy_selection !== undefined ? { policy_selection: input.policy_selection } : {}),
    ...(input.policy_ids !== undefined ? { policy_ids: input.policy_ids } : {})
  }, { trustedRules });
  return { searchRequest, policySet, identifiers: identifiers(input.identifiers, searchRequest.entity_type) };
}

export function advanceRequestDigest({ searchRequest, policySet, identifiers }, callbackAccessKey = '') {
  const callbackKeyHash = callbackAccessKey
    ? createHash('sha256').update(callbackAccessKey).digest('hex') : '';
  const stableSearch = searchRequest.archive_all_stored
    ? { ...searchRequest, date_from: '', date_to: '' } : searchRequest;
  return createHash('sha256').update(JSON.stringify({ searchRequest: stableSearch, policy_hash: policySet.sha256,
    identifiers, callback_key_hash: callbackKeyHash })).digest('hex');
}
