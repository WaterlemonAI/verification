// ICAO Doc 9303 Parts 3, 4 and 5. MRZ checks validate transcription integrity,
// not the physical document, chip signature, holder identity, or authenticity.
const WEIGHTS = [7, 3, 1];

export function mrzCheckDigit(value) {
  if (!/^[A-Z0-9<]*$/.test(value)) throw new Error('invalid_mrz_characters');
  let sum = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const numeric = character === '<' ? 0 : character >= '0' && character <= '9'
      ? character.charCodeAt(0) - 48 : character.charCodeAt(0) - 55;
    sum += numeric * WEIGHTS[index % 3];
  }
  return String(sum % 10);
}

function check(value, observed, { fillerAllowed = false } = {}) {
  const calculated = mrzCheckDigit(value);
  return {
    observed,
    calculated,
    status: observed === calculated || (fillerAllowed && /^<+$/.test(value) && observed === '<') ? 'Passed' : 'FAILED'
  };
}

function clean(value) { return value.replace(/<+$/g, '').replaceAll('<', ' ').trim() || null; }

function names(value) {
  const [surname = '', given = ''] = value.split('<<', 2);
  return { surnames: clean(surname), given_names: clean(given) };
}

function linesFrom(value) {
  const lines = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  return lines.map((line) => String(line).trim().toUpperCase()).filter(Boolean);
}

function result(format, lines, fields, checks) {
  return { format, raw_lines: lines, fields, checks,
    integrity_status: Object.values(checks).every((item) => item.status === 'Passed') ? 'Passed' : 'FAILED',
    limitation: 'MRZ check digits verify encoded-data consistency only; they do not authenticate the document.' };
}

export function parseTd3Mrz(value) {
  const lines = linesFrom(value);
  if (lines.length !== 2 || lines.some((line) => line.length !== 44 || !/^[A-Z0-9<]{44}$/.test(line))) {
    return { format: 'TD3', raw_lines: lines, integrity_status: 'NOT_IDENTIFIED', checks: {}, fields: null };
  }
  const [upper, lower] = lines;
  if (!upper.startsWith('P')) return { format: 'TD3', raw_lines: lines, integrity_status: 'NOT_IDENTIFIED', checks: {}, fields: null };
  const checks = {
    passport_number: check(lower.slice(0, 9), lower[9]),
    date_of_birth: check(lower.slice(13, 19), lower[19]),
    date_of_expiry: check(lower.slice(21, 27), lower[27]),
    personal_number: check(lower.slice(28, 42), lower[42], { fillerAllowed: true }),
    // Part 4 includes expiry and personal-number positions 22-43 in this check.
    composite: check(lower.slice(0, 10) + lower.slice(13, 20) + lower.slice(21, 43), lower[43])
  };
  return result('TD3', lines, {
    document_code: clean(upper.slice(0, 2)),
    issuing_country_code: upper.slice(2, 5),
    ...names(upper.slice(5)),
    passport_number: clean(lower.slice(0, 9)),
    nationality_code: lower.slice(10, 13),
    date_of_birth_yymmdd: lower.slice(13, 19),
    gender_code: lower[20] === '<' ? null : lower[20],
    date_of_expiry_yymmdd: lower.slice(21, 27),
    personal_number: clean(lower.slice(28, 42))
  }, checks);
}

export function parseTd1Mrz(value) {
  const lines = linesFrom(value);
  if (lines.length !== 3 || lines.some((line) => line.length !== 30 || !/^[A-Z0-9<]{30}$/.test(line))) {
    return { format: 'TD1', raw_lines: lines, integrity_status: 'NOT_IDENTIFIED', checks: {}, fields: null };
  }
  const [upper, middle, lower] = lines;
  const longNumber = upper[14] === '<' ? /^([A-Z0-9]{1,13})([0-9])<+$/.exec(upper.slice(15, 30)) : null;
  const documentNumber = upper.slice(5, 14) + (longNumber?.[1] || '');
  const documentNumberDigit = longNumber?.[2] || upper[14];
  const checks = {
    document_number: check(documentNumber, documentNumberDigit),
    date_of_birth: check(middle.slice(0, 6), middle[6]),
    date_of_expiry: check(middle.slice(8, 14), middle[14]),
    composite: check(upper.slice(5, 30) + middle.slice(0, 7) + middle.slice(8, 15) + middle.slice(18, 29), middle[29])
  };
  return result('TD1', lines, {
    document_code: clean(upper.slice(0, 2)),
    issuing_country_code: upper.slice(2, 5),
    document_number: clean(documentNumber),
    date_of_birth_yymmdd: middle.slice(0, 6),
    gender_code: middle[7] === '<' ? null : middle[7],
    date_of_expiry_yymmdd: middle.slice(8, 14),
    nationality_code: middle.slice(15, 18),
    ...names(lower)
  }, checks);
}
