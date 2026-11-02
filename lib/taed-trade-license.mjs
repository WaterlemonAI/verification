const NOT_FOUND = 'Not Found';
const MAX_TEXT = 20_000;
const MAX_ROWS = 200;
const invalid = () => new Error('document_ocr_taed_trade_license_invalid');
const normalized = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

function field(record, ...names) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw invalid();
  const values = new Map(Object.entries(record).map(([key, value]) => [normalized(key), value]));
  for (const name of names) if (values.has(normalized(name))) return values.get(normalized(name));
  return undefined;
}

function text(value) {
  if (value === null || value === undefined || value === '') return NOT_FOUND;
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid();
  const output = String(value).trim();
  if (output.length > MAX_TEXT) throw invalid();
  return !output || /^(null|none|n\/a)$/i.test(output) ? NOT_FOUND : output;
}

function entries(value) {
  if (value === null || value === undefined || value === ''
    || (typeof value === 'string' && /^(null|none|n\/a)$/i.test(value.trim()))) return NOT_FOUND;
  let parsed = value;
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try { parsed = JSON.parse(value); }
    catch { throw invalid(); }
  }
  const result = Array.isArray(parsed) ? parsed : [parsed];
  if (result.length > MAX_ROWS) throw invalid();
  return result.length ? result : NOT_FOUND;
}

function names(value, commaSeparated = false) {
  const values = entries(value);
  if (values === NOT_FOUND) return NOT_FOUND;
  return values.flatMap((item) => {
    const value = text(typeof item === 'object' ? field(item, 'name', 'manager name', 'activity') : item);
    return commaSeparated && value !== NOT_FOUND ? value.split(/\s*,\s*/).map(text) : [value];
  }).filter((item) => item !== NOT_FOUND);
}

function labeledEntries(value) {
  if (typeof value === 'string' && /^(null|none|n\/a)$/i.test(value.trim())) return NOT_FOUND;
  if (typeof value !== 'string' || /^[\[{]/.test(value.trim())) return entries(value);
  const rows = value.split(/\s*\|\s*/).filter(Boolean);
  if (rows.length > MAX_ROWS) throw invalid();
  return rows.map((item) => {
    if (!/^\s*name\s*:/i.test(item)) return { name: item };
    const record = {};
    for (const part of item.split(/,\s*(?=(?:name|nationality|id number|phone number|email|shareholding percentage)\s*:)/i)) {
      const match = /^\s*([^:]+):\s*(.*)\s*$/.exec(part);
      if (!match) throw invalid();
      record[match[1].trim()] = match[2].trim();
    }
    return record;
  });
}

function people(value, owner = false) {
  const values = labeledEntries(value);
  if (values === NOT_FOUND) return NOT_FOUND;
  return values.map((item) => {
    const row = typeof item === 'string' ? { name: item } : item;
    const mapped = {
      name: text(field(row, 'name')),
      nationality: text(field(row, 'nationality')),
      id_number: text(field(row, 'id number', 'id_number')),
      phone_number: text(field(row, 'phone number', 'phone_number')),
      email: text(field(row, 'email', 'email address'))
    };
    if (owner) mapped.shareholding_percent = text(field(row,
      'shareholding percentage', 'shareholding_percent', '% share', 'percentage'));
    return mapped;
  });
}

function entities(value) {
  const values = labeledEntries(value);
  if (values === NOT_FOUND) return NOT_FOUND;
  return values.map((item) => {
    const row = typeof item === 'string' ? { name: item } : item;
    return { name: text(field(row, 'name', 'entity name', 'parent entity')),
      shareholding_percent: text(field(row, 'shareholding percentage', 'shareholding_percent', '% share', 'percentage')) };
  });
}

export function tradeLicenseDataFromTaed(payload) {
  const data = payload?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
  const mapped = {
    issuing_authority: text(field(data, 'Issuing Authority')),
    license_number: text(field(data, 'License Number')),
    company_name_english: text(field(data, 'Company Name (English)')),
    company_name_arabic: text(field(data, 'Company Name (Arabic)')),
    formation_number: text(field(data, 'Formation Number')),
    address: text(field(data, 'Address')),
    issue_date: text(field(data, 'Issue Date')),
    expiry_date: text(field(data, 'Expiry Date')),
    managers: names(field(data, 'Managers'), true),
    business_activity: names(field(data, 'Business Activity')),
    directors_business_owners: people(field(data, 'Directors/Business Owner'), true),
    company_type: NOT_FOUND,
    business_managers: people(field(data, 'Business Manager')),
    emirates: text(field(data, 'Emirates')),
    authorizing_authority: text(field(data, 'Authorizing Authority')),
    parent_entity: entities(field(data, 'Parent Entity')),
    sanction_country: text(field(data, 'Sanction Country'))
  };
  if (Object.values(mapped).every((value) => value === NOT_FOUND)) throw invalid();
  return mapped;
}
