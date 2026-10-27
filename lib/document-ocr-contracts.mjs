const text = (description) => ({ type: 'string', description: `${description} Return "Not Found" if absent, or "Not Readable" if present but illegible or ambiguous.` });
const list = (description, properties) => ({ type: 'array', description,
  items: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } });

function definition(id, name, path, fields, { maxFiles = 1, maxPages = 20, documentKind = '' } = {}) {
  return Object.freeze({ id, name, publicPath: path, fields, maxFiles, maxPages, documentKind });
}

export const DOCUMENT_OCR_APIS = Object.freeze([
  definition('uae-trade-license-ocr', 'UAE Trade License OCR (All Emirates)', '/service/uae_trade_license_ocr', {
    issuing_authority: text('Organization that issued the trade license.'),
    license_number: text('Trade license number exactly as printed.'),
    company_name_english: text('Company legal name in English, when printed.'),
    company_name_arabic: text('Company legal name in Arabic, when printed. Preserve Arabic script.'),
    formation_number: text('Company formation or registration number.'),
    address: text('Complete business address from the document.'),
    issue_date: text('License issue date in DD/MM/YYYY when an unambiguous full date is printed.'),
    expiry_date: text('License expiry date in DD/MM/YYYY when an unambiguous full date is printed.'),
    managers: { type: 'array', description: 'Names of managers explicitly identified in the document.', items: { type: 'string' } },
    business_activity: { type: 'array', description: 'Business activities printed on the license.', items: { type: 'string' } },
    directors_business_owners: list('Only people explicitly labeled as directors, shareholders, or business owners. A manager is not an owner unless the document says so. Preserve printed shareholding percentages; return [] if none are listed.', {
      name: text('Name as printed.'), shareholding_percent: text('Printed percentage including the percent sign, if available.')
    }),
    company_type: text('Legal company type, such as sole establishment or limited liability company.')
  }, { documentKind: 'trade_license' }),
  definition('passport-icao-ocr', 'Global Passport ICAO OCR & MRZ Verification', '/service/passport_icao_ocr', {
    document_type: { type: 'string', enum: ['Passport', 'Not Identified as Passport'] },
    issuing_country: text('Issuing state as a three-letter ISO/ICAO code printed or encoded in MRZ.'),
    passport_number: text('Passport number exactly as printed.'),
    surnames: text('Surname or surnames as printed.'),
    given_names: text('Given name or names as printed.'),
    nationality: text('Nationality as a three-letter ISO/ICAO code printed or encoded in MRZ.'),
    date_of_birth: text('Date of birth in DD/MM/YYYY only when the century is explicit in the visual zone.'),
    gender: { type: 'string', enum: ['M', 'F', 'O', 'Not Found', 'Not Readable'],
      description: 'M, F or O only when explicitly printed. An MRZ filler means unspecified, not O; use Not Found or Not Readable when appropriate.' },
    date_of_expiry: text('Expiry date in DD/MM/YYYY only when the century is explicit in the visual zone.'),
    date_of_issue: text('Issue date in DD/MM/YYYY when printed.'),
    place_of_birth: text('City, state or region printed as place of birth.'),
    mrz_lines: { type: 'array', description: 'Exactly two raw 44-character TD3 MRZ lines copied character for character. Empty if not legible.', items: { type: 'string' } }
  }, { maxPages: 4, documentKind: 'passport' }),
  definition('uae-poa-ocr', 'UAE POA (All Emirates)', '/service/uae_poa_ocr', {
    power_of_attorney: { type: 'string', enum: ['POA Determined', 'Document can not be classified'] },
    issuing_authority: text('Issuing or attesting authority printed on the POA.'),
    entity: text('Name of the principal entity granting power of attorney.'),
    name_of_poa: text('Name of the person or entity receiving power of attorney.'),
    period: text('From DD/MM/YYYY to DD/MM/YYYY when both dates are printed; otherwise Not Found or Not Readable.'),
    id_number: text('ID number of the attorney-in-fact.'),
    nationality: text('Nationality of the attorney-in-fact as printed.')
  }, { documentKind: 'power_of_attorney' }),
  definition('uae-utility-bill-ocr', 'UAE Utility Bill (All Emirates)', '/service/uae_utility_bill_ocr', {
    utility_service_provider: text('Name of utility service provider.'),
    account_type: { type: 'string', enum: ['Residential', 'Commercial', 'Govt', 'Not Found', 'Not Readable'],
      description: 'Residential, Commercial, or Govt. only when supported by the bill; otherwise Not Found or Not Readable.' },
    address: text('Entire service or billing address as printed.'),
    emirate: text('UAE emirate associated with the bill.'),
    bill_date: text('Bill date in DD/MM/YY format. When the bill prints a four-digit year, use its last two digits.'),
    bill_issued_to: text('Person or entity named as account holder.'),
    utility_bill_amount: text('Total billed amount, with currency if printed.')
  }, { documentKind: 'utility_bill' }),
  definition('cheque-ocr', 'Cheque OCR', '/service/cheque_ocr', {
    cheque_number: text('Cheque number as printed.'),
    bank_name: text('Bank name as printed.'),
    payee_name: text('Payee name as printed.'),
    cheque_date: text('Cheque date in DD/MM/YYYY when unambiguous.'),
    amount: text('Cheque amount and currency as printed; do not infer a numeric amount from words unless unambiguous.'),
    micr_number: text('MICR number if present and legible.')
  }, { maxPages: 2, documentKind: 'cheque' }),
  definition('moa-analysis', 'MOA Analysis', '/service/moa_analysis', {
    company_name: text('Legal company name.'),
    registration_number: text('Company registration number.'),
    business_objectives: { type: 'array', description: 'Business objectives stated in the memorandum.', items: { type: 'string' } },
    authorized_capital: text('Authorized capital and currency, if stated.'),
    date_of_incorporation: text('Incorporation date in DD/MM/YYYY when unambiguous.'),
    shareholders: list('One row for each explicitly named shareholder.', {
      name: text('Shareholder name.'), shareholding_percent: text('Shareholding percentage, if printed.'),
      nationality: text('Nationality, if printed.'), id_number: text('ID number, if printed.'),
      phone_number: text('Phone number, if printed.')
    })
  }, { maxPages: 50, documentKind: 'memorandum_of_association' }),
  definition('articles-of-association-ocr', 'Articles of Association OCR', '/service/articles_of_association_ocr', {
    company_name: text('Legal company name.'),
    registration_number: text('Company registration number.'),
    company_rules: { type: 'array', description: 'Key company rules actually stated in the articles.', items: { type: 'string' } },
    share_structure: text('Share classes and ownership structure actually stated.'),
    director_requirements: text('Requirements for directors, if stated.')
  }, { maxPages: 50, documentKind: 'articles_of_association' }),
  definition('emirates-id-ocr', 'Emirates ID OCR', '/service/emirates_id_ocr', {
    emirates_id_number: text('15-digit Emirates ID number from the front.'),
    full_name_english: text('Cardholder full English name.'),
    full_name_arabic: text('Cardholder full Arabic name, preserving Arabic script.'),
    nationality_english: text('Nationality as printed in English.'),
    nationality_arabic: text('Nationality as printed in Arabic.'),
    date_of_birth: text('Date of birth in DD/MM/YYYY when printed.'),
    gender: text('Gender as printed.'),
    issue_date: text('Card issue date in DD/MM/YYYY when printed.'),
    expiry_date: text('Card expiry date in DD/MM/YYYY when printed.'),
    card_number: text('Physical card number from the back, distinct from Emirates ID number.'),
    occupation_english: text('Occupation in English.'),
    occupation_arabic: text('Occupation in Arabic.'),
    employer_name_english: text('Employer or sponsor in English.'),
    employer_name_arabic: text('Employer or sponsor in Arabic.'),
    place_of_issue_english: text('Place of issue in English.'),
    place_of_issue_arabic: text('Place of issue in Arabic.'),
    mrz_lines: { type: 'array', description: 'Raw MRZ lines from the back, each copied character for character. Empty if not legible.', items: { type: 'string' } }
  }, { maxFiles: 2, maxPages: 4, documentKind: 'emirates_id' })
]);

export const DOCUMENT_OCR_BY_ID = new Map(DOCUMENT_OCR_APIS.map((item) => [item.id, item]));
export const DOCUMENT_OCR_BY_PATH = new Map(DOCUMENT_OCR_APIS.map((item) => [item.publicPath, item]));

export function documentOcrPublicCatalog() {
  return DOCUMENT_OCR_APIS.map(({ id, name, publicPath, fields, maxFiles, maxPages }) => ({
    id, name, publicPath,
    fields: Object.fromEntries(Object.entries(fields).map(([fieldName, field]) => [fieldName,
      field.type === 'array' ? { ...field, type: ['array', 'string'],
        description: `${field.description} In the API response, an absent list is "Not Found" and a visibly present but unreadable list is "Not Readable".` }
        : field])),
    maxFiles, maxPages
  }));
}

export function geminiExtractionSchema(definition, figureIds = []) {
  const listFields = Object.entries(definition.fields).filter(([, field]) => field.type === 'array').map(([name]) => name);
  return {
    type: 'object',
    properties: {
      document_classification: { type: 'string', enum: [definition.documentKind, 'unclassified'],
        description: 'Return the expected document kind only when the OCR text supports it; otherwise unclassified.' },
      data: { type: 'object', properties: definition.fields, required: Object.keys(definition.fields), additionalProperties: false },
      evidence: { type: 'array', description: 'Short verbatim OCR evidence for extracted data fields. Do not cite Not Found or Not Readable placeholders. No invented quotes.', items: {
        type: 'object', properties: {
          field: { type: 'string', enum: Object.keys(definition.fields) },
          page: { type: 'integer', minimum: 1 },
          quote: { type: 'string' }
        }, required: ['field', 'page', 'quote'], additionalProperties: false
      } },
      figure_roles: { type: 'array', description: 'Classify each supplied figure crop only. Use other unless the crop clearly isolates a cardholder portrait or handwritten signature.', items: {
        type: 'object', properties: {
          id: figureIds.length ? { type: 'string', enum: figureIds } : { type: 'string' },
          role: { type: 'string', enum: ['photo', 'signature', 'other'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
        }, required: ['id', 'role', 'confidence'], additionalProperties: false
      } },
      image_regions: { type: 'array', description: 'For Emirates ID full-page images only, locate a tight portrait or handwritten-signature region. Use an empty array if uncertain.', items: {
        type: 'object', properties: {
          id: figureIds.length ? { type: 'string', enum: figureIds } : { type: 'string' },
          role: { type: 'string', enum: ['photo', 'signature'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          x1: { type: 'integer', minimum: 0, maximum: 1000 },
          y1: { type: 'integer', minimum: 0, maximum: 1000 },
          x2: { type: 'integer', minimum: 0, maximum: 1000 },
          y2: { type: 'integer', minimum: 0, maximum: 1000 }
        }, required: ['id', 'role', 'confidence', 'x1', 'y1', 'x2', 'y2'], additionalProperties: false
      } },
      unreadable_list_fields: { type: 'array', description: 'Names of list fields visibly present in the document but not readable. Omit fields that are absent.',
        items: listFields.length ? { type: 'string', enum: listFields } : { type: 'string' } }
    }, required: ['document_classification', 'data', 'evidence', 'figure_roles', 'image_regions', 'unreadable_list_fields'], additionalProperties: false
  };
}
