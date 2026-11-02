const NOT_FOUND = 'Not Found';
const MAX_VALUE_LENGTH = 20_000;
const MAX_SHAREHOLDERS = 200;
const STATUS = new Set(['Active Shareholder', 'Removed Shareholder']);

function text(value) {
  if (value === null || value === undefined || value === '') return NOT_FOUND;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('document_ocr_taed_moa_invalid');
  const normalized = String(value).trim();
  if (normalized.length > MAX_VALUE_LENGTH) throw new Error('document_ocr_taed_moa_invalid');
  return normalized || NOT_FOUND;
}

function objectives(value) {
  if (value === null || value === undefined || value === '') return NOT_FOUND;
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n]/) : null;
  if (!entries || entries.length > 200) throw new Error('document_ocr_taed_moa_invalid');
  const cleaned = entries.map(text).filter((entry) => entry !== NOT_FOUND);
  return cleaned.length ? cleaned : NOT_FOUND;
}

function shareholders(value) {
  if (value === null || value === undefined || value === '') return NOT_FOUND;
  let rows = value;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); }
    catch { throw new Error('document_ocr_taed_moa_invalid'); }
  }
  if (!Array.isArray(rows) || rows.length > MAX_SHAREHOLDERS) throw new Error('document_ocr_taed_moa_invalid');
  if (!rows.length) return NOT_FOUND;
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('document_ocr_taed_moa_invalid');
    const currentStatus = text(row['current status']);
    if (currentStatus !== NOT_FOUND && !STATUS.has(currentStatus)) throw new Error('document_ocr_taed_moa_invalid');
    return {
      name: text(row.name),
      shareholding_percent: text(row['% share']),
      nationality: text(row.nationality),
      id_number: text(row['id number']),
      phone_number: NOT_FOUND,
      number_of_shares: text(row['# of shares']),
      date_of_joining: text(row['date of joining']),
      date_of_removal: text(row['date of removal']),
      current_status: currentStatus
    };
  });
}

export function moaDataFromTaed(payload) {
  const data = payload?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('document_ocr_taed_moa_invalid');
  const mapped = {
    company_name: text(data['Company Name']),
    registration_number: text(data['Registration Number']),
    business_objectives: objectives(data['Business Objectives']),
    authorized_capital: text(data['Authorized Capital']),
    date_of_incorporation: text(data['Date of Incorporation']),
    shareholders: shareholders(data.shareholders)
  };
  if (Object.values(mapped).every((value) => value === NOT_FOUND))
    throw new Error('document_ocr_taed_moa_invalid');
  return mapped;
}
