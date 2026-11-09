// The catalog is the only source of executable checks for schema-defined flows.
export const CHECK_CATALOG_VERSION = '1.0.0';
export const CHECK_CATALOG = Object.freeze({
  'uae-trade-licence': { adapter: 'uae-trade-licence', version: '1.0.0', inputs: ['business_name', 'licence_number'], documents: ['trade_licence'], cost_class: 'flo' },
  'iban-verification': { adapter: 'iban-verification', version: '1.0.0', inputs: ['business_name', 'iban'], documents: ['bank_letter'], cost_class: 'flo' },
  'entity-aml': { adapter: 'entity-aml', version: '1.0.0', inputs: ['business_name'], documents: [], cost_class: 'flo' },
  'entity-adverse-media': { adapter: 'entity-adverse-media', version: '1.0.0', inputs: ['business_name'], documents: [], cost_class: 'flo' },
  'stakeholder-aml': { adapter: 'stakeholder-aml', version: '1.0.0', inputs: ['stakeholders'], documents: [], cost_class: 'flo' },
  'stakeholder-adverse-media': { adapter: 'stakeholder-adverse-media', version: '1.0.0', inputs: ['stakeholders'], documents: [], cost_class: 'flo' },
  'merchant-screening': { adapter: 'merchant-screening', version: '1.0.0', inputs: ['website_url'], documents: [], cost_class: 'flo' },
  'ejari-verification': { adapter: 'ejari-verification', version: '1.0.0', inputs: [], documents: ['ejari'], cost_class: 'flo' }
});

export function validateChecks(checks, allowed = Object.keys(CHECK_CATALOG)) {
  if (!Array.isArray(checks) || checks.length > 16 || new Set(checks).size !== checks.length)
    throw new Error('invalid_checks');
  for (const id of checks) {
    const entry = CHECK_CATALOG[id];
    if (!entry || !entry.adapter || !entry.version || !entry.cost_class) throw new Error(`unknown_check:${id}`);
    if (!allowed.includes(id)) throw new Error(`check_not_entitled:${id}`);
  }
  return checks;
}
