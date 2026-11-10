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

const labels = Object.freeze({
  'uae-trade-licence': ['UAE trade licence', 'Verify the registered name and licence number.'],
  'iban-verification': ['IBAN verification', 'Compare the bank account against the supplied bank letter.'],
  'entity-aml': ['Business AML', 'Screen the business against AML sources.'],
  'entity-adverse-media': ['Business adverse media', 'Review adverse media for the business.'],
  'stakeholder-aml': ['Stakeholder AML', 'Screen declared stakeholders.'],
  'stakeholder-adverse-media': ['Stakeholder adverse media', 'Review adverse media for declared stakeholders.'],
  'merchant-screening': ['Website screening', 'Review the declared business website.'],
  'ejari-verification': ['Ejari verification', 'Verify the supplied Dubai tenancy document.']
});

export function visibleCheckCatalog(allowed = Object.keys(CHECK_CATALOG)) {
  return Object.entries(CHECK_CATALOG).filter(([id]) => allowed.includes(id)).map(([id, entry]) => ({
    id, label: labels[id][0], description: labels[id][1],
    required_fields: [...entry.inputs], required_documents: [...entry.documents],
    version: entry.version, cost_class: entry.cost_class
  }));
}

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
