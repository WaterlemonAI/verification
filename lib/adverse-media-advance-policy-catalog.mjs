// Stable event-policy IDs. A policy is a versioned rule applied to a classified
// event; its label is never evidence that the event happened.
export const ADVANCE_POLICY_CATALOG_VERSION = '2026-11-21.1';

const FAMILIES = [
  ['FIN', 'financial_crime', [
    ['fraud', 'Fraud', 'escalate'],
    ['embezzlement', 'Embezzlement', 'escalate'],
    ['bribery', 'Bribery', 'escalate'],
    ['money_laundering', 'Money laundering', 'escalate'],
    ['tax_evasion', 'Tax evasion', 'escalate'],
    ['accounting_irregularity', 'Accounting irregularity', 'review'],
    ['market_abuse', 'Market abuse', 'escalate'],
    ['sanctions_evasion', 'Sanctions evasion', 'escalate']
  ]],
  ['REG', 'regulatory_governance', [
    ['regulatory_fine', 'Regulatory fine', 'review'],
    ['licence_suspension', 'Licence suspension', 'escalate'],
    ['compliance_failure', 'Compliance failure', 'review'],
    ['audit_qualification', 'Audit qualification', 'review'],
    ['false_disclosure', 'False disclosure', 'escalate'],
    ['procurement_collusion', 'Procurement collusion', 'escalate'],
    ['competition_enforcement', 'Competition enforcement', 'review'],
    ['debarment', 'Debarment', 'escalate']
  ]],
  ['EMP', 'employee_leadership', [
    ['isolated_employee_fraud', 'Isolated employee fraud', 'review'],
    ['executive_fraud', 'Executive fraud', 'escalate'],
    ['harassment', 'Harassment', 'review'],
    ['discrimination', 'Discrimination', 'review'],
    ['whistleblower_retaliation', 'Whistleblower retaliation', 'review'],
    ['conflict_of_interest', 'Conflict of interest', 'review'],
    ['wage_theft', 'Wage theft', 'review'],
    ['employee_conviction', 'Employee conviction', 'review']
  ]],
  ['HSE', 'health_safety', [
    ['workplace_fatality', 'Workplace fatality', 'escalate'],
    ['serious_injury', 'Serious injury', 'review'],
    ['safety_citation', 'Safety citation', 'review'],
    ['product_recall', 'Product recall', 'review'],
    ['transport_accident', 'Transport accident', 'review'],
    ['fire_incident', 'Fire incident', 'review'],
    ['food_safety_breach', 'Food safety breach', 'review'],
    ['public_health_breach', 'Public health breach', 'review']
  ]],
  ['CYB', 'cyber_privacy', [
    ['customer_data_breach', 'Customer data breach', 'review'],
    ['ransomware_incident', 'Ransomware incident', 'review'],
    ['privacy_enforcement', 'Privacy enforcement', 'review'],
    ['insider_data_theft', 'Insider data theft', 'review'],
    ['credential_exposure', 'Credential exposure', 'review'],
    ['service_outage', 'Service outage', 'review'],
    ['third_party_breach', 'Third-party breach', 'review'],
    ['security_negligence', 'Security negligence', 'review']
  ]],
  ['ENV', 'environment', [
    ['pollution_enforcement', 'Pollution enforcement', 'review'],
    ['hazardous_waste', 'Hazardous waste', 'review'],
    ['emissions_violation', 'Emissions violation', 'review'],
    ['water_contamination', 'Water contamination', 'review'],
    ['land_damage', 'Land damage', 'review'],
    ['biodiversity_harm', 'Biodiversity harm', 'review'],
    ['climate_disclosure', 'Climate disclosure', 'review'],
    ['environmental_permit_breach', 'Environmental permit breach', 'review']
  ]],
  ['STB', 'financial_stability', [
    ['debt_default', 'Debt default', 'review'],
    ['insolvency', 'Insolvency', 'escalate'],
    ['bankruptcy', 'Bankruptcy', 'escalate'],
    ['going_concern', 'Going concern', 'review'],
    ['liquidity_crisis', 'Liquidity crisis', 'review'],
    ['missed_payroll', 'Missed payroll', 'review'],
    ['creditor_litigation', 'Creditor litigation', 'review'],
    ['restructuring', 'Restructuring', 'review']
  ]],
  ['HUM', 'human_rights_security', [
    ['forced_labour', 'Forced labour', 'escalate'],
    ['child_labour', 'Child labour', 'escalate'],
    ['human_trafficking', 'Human trafficking', 'escalate'],
    ['organised_crime_ties', 'Organised crime ties', 'escalate'],
    ['terrorism_financing', 'Terrorism financing', 'escalate'],
    ['security_force_violence', 'Security-force violence', 'escalate'],
    ['export_control_breach', 'Export-control breach', 'escalate'],
    ['conflict_minerals', 'Conflict minerals', 'review']
  ]]
];

const catalog = Object.freeze(FAMILIES.flatMap(([prefix, family, entries]) =>
  entries.map(([event_type, label, default_action], index) => Object.freeze({
    id: prefix + '-' + String(index + 1).padStart(2, '0'),
    family,
    event_type,
    label,
    default_action
  }))));
if (catalog.length !== 64 || new Set(catalog.map((item) => item.id)).size !== 64
  || new Set(catalog.map((item) => item.event_type)).size !== 64) {
  throw new Error('advance_policy_catalog_invalid');
}

const byId = new Map(catalog.map((item) => [item.id, item]));
export const ADVANCE_POLICY_IDS = Object.freeze(catalog.map((item) => item.id));

export function listAdvancePolicies() {
  return catalog.map((item) => ({ ...item, catalog_version: ADVANCE_POLICY_CATALOG_VERSION }));
}

export function getAdvancePolicy(id) {
  return byId.get(id) || null;
}
