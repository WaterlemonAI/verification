import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PAGE = { width: 595.28, height: 841.89, margin: 46 };
const BRAND_LOGO = readFileSync(new URL('../site/assets/kycprobe-logo-dark.png', import.meta.url));
const C = {
  navy: rgb(17 / 255, 28 / 255, 54 / 255),
  purple: rgb(52 / 255, 43 / 255, 177 / 255),
  yellow: rgb(250 / 255, 197 / 255, 42 / 255),
  green: rgb(24 / 255, 114 / 255, 80 / 255),
  amber: rgb(160 / 255, 92 / 255, 12 / 255),
  red: rgb(158 / 255, 51 / 255, 55 / 255),
  muted: rgb(92 / 255, 105 / 255, 130 / 255),
  pale: rgb(245 / 255, 247 / 255, 252 / 255),
  line: rgb(222 / 255, 228 / 255, 239 / 255),
  white: rgb(1, 1, 1)
};
const CHECKS = {
  pep: 'Politically exposed persons',
  sanction: 'Sanctions',
  watchlist: 'Watchlists',
  aml: 'AML risk events',
  russiabridge: 'Russia exposure',
  dualgoods: 'Dual-use goods',
  sanctionedgoods: 'Sanctioned goods',
  apc: 'Adverse media',
  er_apc: 'Enhanced adverse media'
};
const DATA_KEYS = {
  sanction: ['sanction', 'sanctions'],
  watchlist: ['watchlist', 'watchlists'],
  dualgoods: ['dualgoods', 'dual_goods'],
  sanctionedgoods: ['sanctionedgoods', 'sanctioned_goods'],
  er_apc: ['er_apc', 'apc']
};

function pdfText(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"').replace(/[^\x20-\x7e]/g, '?').trim();
}

function stableJson(value) {
  try { return JSON.stringify(value, null, 2); } catch { return JSON.stringify({ value: String(value) }); }
}

function hash(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }
function compact(value, limit = 280) {
  const text = pdfText(value).replace(/\s+/g, ' ');
  return text.length > limit ? text.slice(0, limit - 3) + '...' : text;
}
function label(value) { return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function unique(values) { return [...new Set(values.map(v => pdfText(v)).filter(Boolean))]; }
function scalarValues(value) {
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(scalarValues);
  return value === null || value === undefined || value === '' ? [] : [String(value)];
}
export function entityProfileName(profile) {
  const basic = profile?.basic_details;
  if (basic && typeof basic === 'object') {
    const parts = [basic.first_name, basic.middle_name, basic.last_name]
      .map(value => String(value || '').trim()).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  const names = profile?.personal_details?.name;
  if (Array.isArray(names) && names.length) {
    const first = names[0];
    if (typeof first === 'string') return first;
    const parts = [first.first_name, first.middle_name, first.last_name].filter(Boolean);
    if (parts.length) return parts.join(' ');
    return first.full_name || first.name || 'Name not supplied';
  }
  return profile?.name || profile?.full_name || 'Name not supplied';
}
function recordType(profile) {
  return String(profile?.basic_details?.type || profile?.personal_details?.type || profile?.type || '').trim();
}
function typeFamily(value) {
  const type = String(value || '').toLowerCase();
  if (['organization', 'organisation', 'business', 'company', 'entity'].includes(type)) return 'organization';
  if (['individual', 'person', 'natural person'].includes(type)) return 'individual';
  return '';
}
function aliases(profile) {
  return unique([
    ...(profile?.personal_details?.aliases || []).map(item => typeof item === 'string' ? item : item?.alias_name || item?.name || ''),
    ...(profile?.basic_details?.aliases || []).map(item => typeof item === 'string' ? item : item?.alias_name || item?.name || ''),
    ...scalarValues(profile?.aliases || profile?.alias)
  ]);
}
const LEGAL_SUFFIXES = new Set(['pt', 'tbk', 'llc', 'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'pte', 'plc']);
function nameTokens(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
}
function comparableName(value) {
  return nameTokens(value).filter(token => !LEGAL_SUFFIXES.has(token)).sort().join(' ');
}
function nameRelation(request, profile) {
  const name = entityProfileName(profile);
  if (name === 'Name not supplied') return 'Identity cannot be assessed - record name absent';
  const returnedNames = [name, ...aliases(profile)].map(comparableName).filter(Boolean);
  const queryNames = [request?.name, ...(Array.isArray(request?.alias) ? request.alias : [])]
    .map(comparableName).filter(Boolean);
  if (returnedNames.some(candidate => queryNames.includes(candidate))) return 'Name text aligns - identity still unconfirmed';
  const candidateTokens = new Set(nameTokens(name).filter(token => !LEGAL_SUFFIXES.has(token)));
  const requestedTokens = nameTokens(request?.name).filter(token => !LEGAL_SUFFIXES.has(token));
  const overlap = requestedTokens.filter(token => candidateTokens.has(token));
  if (overlap.length >= 2 && overlap.length >= Math.ceil(requestedTokens.length / 2)) return 'Partial name overlap - review identifiers';
  return 'No direct name alignment - review before attributing';
}
function categories(profile) {
  return (Array.isArray(profile?.category) ? profile.category : [profile?.category])
    .map(value => String(value || '').toUpperCase()).filter(Boolean);
}
function profileMatches(profile, check) {
  const tags = categories(profile);
  if (check === 'pep') return tags.includes('PEP') || profile?.pep_status === true;
  if (check === 'sanction') return tags.some(tag => tag.includes('SAN')) || Boolean(profile?.sanctions?.authority?.length);
  if (check === 'watchlist') return tags.some(tag => /WLT|WATCH/.test(tag)) || Boolean(profile?.watchlists?.authority?.length);
  return false;
}
function asRecords(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value ? [value] : [];
  for (const key of ['matches', 'results', 'profiles', 'data', 'items']) if (Array.isArray(value[key])) return value[key];
  return Object.keys(value).length ? [value] : [];
}
function checkResult(data, response, check) {
  const profiles = Array.isArray(data?.profiles) ? data.profiles : null;
  if (['pep', 'sanction', 'watchlist'].includes(check) && profiles) {
    return { records: profiles.filter(profile => profileMatches(profile, check)), assessed: response?.profiles_success === true };
  }
  for (const key of DATA_KEYS[check] || [check]) {
    if (data && Object.hasOwn(data, key)) return { records: asRecords(data[key]), assessed: true };
  }
  return { records: [], assessed: false };
}
function sourceNames(profile) {
  const authorities = [
    ...(profile?.watchlists?.authority || []).map(item => item.watchlist_list_name || item.watchlist_authority),
    ...(profile?.sanctions?.authority || []).map(item => item.sanctions_list_name || item.sanction_authority)
  ];
  const named = unique(authorities);
  const descriptions = unique((profile?.sources_details || []).map(item => item.source_description))
    .filter(value => !/^(this source|this document|source provides)\b/i.test(value));
  if (named.length || descriptions.length) return named.length ? named : descriptions;
  return unique(sourceUrls(profile).map(value => {
    try { return new URL(value).hostname.replace(/^www\./, '') + ' (URL host; source name unavailable)'; }
    catch { return ''; }
  }));
}
function sourceUrls(profile) {
  return unique((profile?.sources_details || []).map(item => item.source)).filter(value => /^https?:\/\//i.test(value));
}
function birthDates(profile) {
  return unique((profile?.personal_details?.date_of_birth || []).map(item => {
    if (typeof item === 'string') return item;
    return [item.date_of_birth_year, item.date_of_birth_month, item.date_of_birth_date].filter(Boolean).join('-');
  }));
}
function profileRows(profile) {
  const person = profile?.personal_details || {};
  const basic = profile?.basic_details || {};
  const positions = (profile?.professional_details?.positions || []).map(item =>
    [item.position, item.organization_name].filter(Boolean).join(' - '));
  const programmes = (profile?.sanctions?.authority || []).map(item => item.sanction_programme_name).filter(Boolean);
  const remarks = (profile?.remarks || []).map(item => typeof item === 'string' ? item : item?.remarks || item?.description || '').filter(Boolean);
  const fines = (profile?.watchlist_fines_and_penalties || []).map(item =>
    [item?.watchlist_fine_amount_in_local_currency, item?.watchlist_name_of_local_currency].filter(Boolean).join(' ')).filter(Boolean);
  const relationships = (person?.relationships || profile?.key_associations?.relationships || []).map(item =>
    [item?.relationship_name, item?.relationship_type, item?.relationship_type_description].filter(Boolean).join(' - ')).filter(Boolean);
  const countries = (profile?.contact_details?.addresses || []).map(item =>
    item?.address_country || item?.address_country_code).filter(Boolean);
  const summaries = scalarValues(profile?.others?.profile_summary).filter(Boolean);
  const rows = [
    ['Record ID', basic.uid || person.uid || profile?.uid],
    ['Record type', recordType(profile)],
    ['Date of birth', birthDates(profile).join('; ')],
    ['Aliases', aliases(profile).slice(0, 5).join('; ')],
    ['Nationality', unique(scalarValues(person.nationalities)).slice(0, 4).join('; ')],
    ['Recorded country', unique(countries).slice(0, 3).join('; ')],
    ['Positions', unique(positions).slice(0, 3).join('; ')],
    ['Record remarks', unique(remarks).slice(0, 3).join('; ')],
    ['Recorded penalties', unique(fines).slice(0, 3).join('; ')],
    ['Associations', unique(relationships).slice(0, 3).join('; ')],
    ['Sanctions programme', unique(programmes).slice(0, 3).join('; ')],
    ['Profile summary', unique(summaries).slice(0, 2).join('; ')],
    ['Match details', profile?.match_details],
    ['Record updated', profile?.updated_at],
    ['Source / database', sourceNames(profile).slice(0, 3).join('; ') || 'Not named in response'],
    ['Source link', sourceUrls(profile).slice(0, 2).join('; ')]
  ];
  return rows.filter(([, value]) => value);
}
function wrap(font, value, size, maxWidth) {
  const words = pdfText(value).replace(/\s+/g, ' ').split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!word) continue;
    const candidate = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    let piece = '';
    for (const char of word) {
      if (piece && font.widthOfTextAtSize(piece + char, size) > maxWidth) { lines.push(piece); piece = char; }
      else piece += char;
    }
    line = piece;
  }
  if (line) lines.push(line);
  return lines.length ? lines : ['-'];
}

export async function createEntitySearchAuditPdf({ request, response, httpStatus, completedAt, logoBytes, logoType,
  transactionId = '', requestSha256 = '', responseSha256 = '' }) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const brand = await pdf.embedPng(BRAND_LOGO);
  let customerLogo;
  if (logoBytes && logoType === 'image/png') customerLogo = await pdf.embedPng(logoBytes).catch(() => undefined);
  if (logoBytes && ['image/jpeg', 'image/jpg'].includes(logoType)) customerLogo = await pdf.embedJpg(logoBytes).catch(() => undefined);
  const generatedAt = Number.isFinite(Date.parse(completedAt)) ? new Date(completedAt).toISOString() : new Date().toISOString();
  const reportId = 'AI7-' + hash({ request, response, generatedAt, transactionId }).slice(0, 16).toUpperCase();
  const requested = unique(Array.isArray(request?.search_type) ? request.search_type : []).map(value => value.toLowerCase());
  const data = response && typeof response === 'object' && !Array.isArray(response) ? response.data : null;
  const checks = requested.map(check => ({ id: check, name: CHECKS[check] || label(check), ...checkResult(data, response, check) }));
  const httpOk = Number(httpStatus) >= 200 && Number(httpStatus) < 300;
  const complete = httpOk && checks.length > 0 && checks.every(check => check.assessed);
  const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  const categoryAppearances = checks.reduce((sum, check) => sum + check.records.length, 0);
  const nonProfileRecords = checks.filter(check => !['pep', 'sanction', 'watchlist'].includes(check.id))
    .reduce((sum, check) => sum + check.records.length, 0);
  const potential = profiles.length + nonProfileRecords;
  const nameAligned = profiles.filter(profile => nameRelation(request, profile).startsWith('Name text aligns')).length;
  const partialNames = profiles.filter(profile => nameRelation(request, profile).startsWith('Partial name overlap')).length;
  const namesAbsent = profiles.filter(profile => entityProfileName(profile) === 'Name not supplied').length;
  const typeConflicts = profiles.filter(profile => typeFamily(request?.type) && typeFamily(recordType(profile))
    && typeFamily(request?.type) !== typeFamily(recordType(profile))).length;
  const plausibleNames = profiles.filter(profile => /^(Name text aligns|Partial name overlap)/.test(nameRelation(request, profile))
    && !(typeFamily(request?.type) && typeFamily(recordType(profile))
      && typeFamily(request?.type) !== typeFamily(recordType(profile)))).length;
  const status = !complete ? 'SCREENING INCOMPLETE' : potential
    ? plausibleNames ? 'POSSIBLE IDENTITY MATCHES - REVIEW' : 'UNVERIFIED SEARCH HITS - REVIEW'
    : 'NO IDENTIFIED RISK INDICATORS';
  const statusColor = !complete ? C.red : potential ? C.amber : C.green;
  const pages = [];
  let page;
  let y;

  function newPage(section) {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    pages.push(page);
    page.drawRectangle({ x: 0, y: PAGE.height - 7, width: PAGE.width, height: 7, color: C.purple });
    const logo = brand.scaleToFit(116, 44);
    page.drawImage(brand, { x: PAGE.margin, y: PAGE.height - 69, width: logo.width, height: logo.height });
    page.drawText(pdfText(section).toUpperCase(), { x: PAGE.width - PAGE.margin - 210, y: PAGE.height - 49,
      size: 8, font: bold, color: C.purple, maxWidth: 210 });
    page.drawLine({ start: { x: PAGE.margin, y: PAGE.height - 81 }, end: { x: PAGE.width - PAGE.margin, y: PAGE.height - 81 },
      thickness: 1, color: C.line });
    y = PAGE.height - 107;
  }
  function ensure(height, section = 'Screening findings') {
    if (y - height < 68) newPage(section);
  }
  function paragraph(value, { size = 9, color = C.navy, font = regular, gap = 9, width = PAGE.width - PAGE.margin * 2 } = {}) {
    const lines = wrap(font, value, size, width);
    const h = lines.length * (size * 1.45) + gap;
    ensure(h);
    for (const text of lines) { page.drawText(text, { x: PAGE.margin, y, size, font, color }); y -= size * 1.45; }
    y -= gap;
  }
  function section(title, kicker = '', keepWith = 0) {
    ensure(65 + keepWith, title);
    y -= 9;
    if (kicker) { page.drawText(pdfText(kicker).toUpperCase(), { x: PAGE.margin, y, size: 7, font: bold, color: C.purple }); y -= 18; }
    page.drawText(pdfText(title), { x: PAGE.margin, y, size: 17, font: bold, color: C.navy, maxWidth: PAGE.width - PAGE.margin * 2 });
    y -= 16;
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.width - PAGE.margin, y }, thickness: 1, color: C.line });
    y -= 18;
  }
  function row(name, value, { color = C.navy, size = 8.4 } = {}) {
    const lines = wrap(regular, value || '-', size, 340);
    const h = Math.max(18, lines.length * 11 + 6);
    ensure(h);
    page.drawText(pdfText(name).toUpperCase(), { x: PAGE.margin, y, size: 6.8, font: bold, color: C.muted });
    for (let i = 0; i < lines.length; i++) page.drawText(lines[i], { x: PAGE.margin + 142, y: y - i * 11,
      size, font: regular, color });
    y -= h;
  }
  function checkCard(check) {
    ensure(67, 'Dataset outcomes');
    const count = check.records.length;
    const outcome = !check.assessed ? 'Not confirmed by response' : count ? count + ' candidate record(s)' : 'No candidate records returned';
    const accent = !check.assessed ? C.red : count ? C.amber : C.green;
    page.drawRectangle({ x: PAGE.margin, y: y - 55, width: PAGE.width - PAGE.margin * 2, height: 55, color: C.pale });
    page.drawRectangle({ x: PAGE.margin, y: y - 55, width: 4, height: 55, color: accent });
    page.drawText(check.name, { x: PAGE.margin + 16, y: y - 22, size: 11, font: bold, color: C.navy, maxWidth: 440 });
    page.drawText(outcome, { x: PAGE.margin + 16, y: y - 40, size: 8.5, font: regular, color: accent });
    y -= 67;
  }
  function sourceRow(name, count) {
    const lines = wrap(regular, name, 8.3, 395);
    const h = Math.max(24, lines.length * 11 + 9);
    ensure(h, 'Returned source inventory');
    page.drawRectangle({ x: PAGE.margin, y: y - h + 5, width: PAGE.width - PAGE.margin * 2, height: h, color: C.pale });
    for (let i = 0; i < lines.length; i++) page.drawText(lines[i], { x: PAGE.margin + 10, y: y - 10 - i * 11, size: 8.3, font: regular, color: C.navy });
    page.drawText(String(count), { x: PAGE.width - PAGE.margin - 30, y: y - 10, size: 8.3, font: bold, color: C.purple });
    y -= h + 4;
  }
  function candidateCard(profile, index) {
    const nameLines = wrap(bold, entityProfileName(profile), 11, 325);
    const detail = profileRows(profile).map(([key, value]) => [key, wrap(regular, compact(value, key === 'Source link' ? 320 : 240), 7.5, 349)]);
    const relation = nameRelation(request, profile);
    const typeConflict = typeFamily(request?.type) && typeFamily(recordType(profile))
      && typeFamily(request?.type) !== typeFamily(recordType(profile));
    const height = 93 + nameLines.length * 14 + (typeConflict ? 15 : 0)
      + detail.reduce((sum, [, lines]) => sum + Math.max(11, lines.length * 10 + 3), 0);
    ensure(height + 12, 'Candidate evidence');
    page.drawRectangle({ x: PAGE.margin, y: y - height, width: PAGE.width - PAGE.margin * 2, height, color: C.pale });
    page.drawRectangle({ x: PAGE.margin, y: y - height, width: 4, height, color: C.amber });
    page.drawText('CANDIDATE ' + String(index + 1).padStart(3, '0'), { x: PAGE.margin + 15, y: y - 18, size: 7, font: bold, color: C.purple });
    const score = compact(profile.score || 'Not supplied', 24);
    page.drawText('Search score ' + score, { x: PAGE.width - PAGE.margin - 140, y: y - 18, size: 8, font: bold, color: C.amber });
    let cy = y - 38;
    for (const nameLine of nameLines) { page.drawText(nameLine, { x: PAGE.margin + 15, y: cy, size: 11, font: bold, color: C.navy }); cy -= 14; }
    page.drawText('Category: ' + (categories(profile).join(', ') || 'Not supplied'), { x: PAGE.margin + 15, y: cy, size: 8, font: regular, color: C.muted });
    cy -= 17;
    page.drawText('NAME CHECK: ' + relation, { x: PAGE.margin + 15, y: cy, size: 7.5, font: bold, color: C.amber,
      maxWidth: PAGE.width - PAGE.margin * 2 - 30 });
    cy -= 16;
    if (typeConflict) {
      page.drawText('TYPE CONFLICT: searched ' + pdfText(request.type) + '; record ' + pdfText(recordType(profile)),
        { x: PAGE.margin + 15, y: cy, size: 7.5, font: bold, color: C.red,
          maxWidth: PAGE.width - PAGE.margin * 2 - 30 });
      cy -= 15;
    }
    cy -= 3;
    for (const [key, lines] of detail) {
      page.drawText(key.toUpperCase(), { x: PAGE.margin + 15, y: cy, size: 6.3, font: bold, color: C.muted });
      for (let i = 0; i < lines.length; i++) page.drawText(lines[i], { x: PAGE.margin + 132, y: cy - i * 10, size: 7.5, font: regular, color: C.navy });
      cy -= Math.max(11, lines.length * 10 + 3);
    }
    y -= height + 12;
  }

  newPage('Entity screening report');
  page.drawRectangle({ x: PAGE.margin, y: y - 119, width: PAGE.width - PAGE.margin * 2, height: 119, color: C.pale });
  page.drawText('AML / ENTITY SCREENING', { x: PAGE.margin + 19, y: y - 29, size: 8, font: bold, color: C.purple });
  page.drawText('Screening findings', { x: PAGE.margin + 19, y: y - 63, size: 24, font: bold, color: C.navy });
  const subjectLines = wrap(regular, request?.name || 'Unnamed subject', 12, customerLogo ? 300 : 450);
  page.drawText(subjectLines[0], { x: PAGE.margin + 19, y: y - 89, size: 12, font: regular, color: C.muted });
  if (customerLogo) {
    const logo = customerLogo.scaleToFit(100, 50);
    page.drawImage(customerLogo, { x: PAGE.width - PAGE.margin - logo.width - 16, y: y - 75, width: logo.width, height: logo.height });
  }
  y -= 140;
  row('Report reference', reportId);
  row('Screening transaction', transactionId || 'Not supplied');
  row('Generated (UTC)', generatedAt);
  row('Screening endpoint', 'api.ai7uae.com/service/entity_search');
  row('Processing region', 'Microsoft Azure UAE North');
  row('Entity type', request?.type || 'Not supplied');
  row('Requested checks', checks.map(check => check.name).join(', ') || 'None recorded');
  row('HTTP response', String(httpStatus || 'Not supplied') + ' - ' + compact(response?.message || response?.msg || '', 80));
  y -= 8;
  section('Outcome', 'Automated overview');
  ensure(62);
  page.drawRectangle({ x: PAGE.margin, y: y - 49, width: PAGE.width - PAGE.margin * 2, height: 49,
    color: C.pale, borderColor: statusColor, borderWidth: 1.4 });
  page.drawText(status, { x: PAGE.margin + 14, y: y - 30, size: 10, font: bold, color: statusColor,
    maxWidth: PAGE.width - PAGE.margin * 2 - 28 });
  y -= 65;
  paragraph(complete
    ? potential ? `${potential} unique candidate record(s) were returned; ${categoryAppearances} dataset appearance(s). Name text: ${nameAligned} aligned, ${partialNames} partially overlapping, ${namesAbsent} unavailable. ${typeConflicts} had a different known entity type. Search score alone is not identity proof.`
      : 'No candidate records were returned for the requested checks. This means no risk indicator was identified in this response; it does not certify universal clearance.'
    : 'The response did not confirm all requested checks. Do not use this report as a clearance decision.',
  { size: 9, color: C.muted });
  section('Dataset outcomes', 'Where candidates were returned');
  for (const check of checks) checkCard(check);
  if (!checks.length) paragraph('No checks were recorded in the request.', { color: C.red });
  paragraph('A zero-candidate outcome applies only to the selected dataset family in this response. The provider does not list every underlying database queried, so individual sources cannot be certified clear.', { size: 7.8, color: C.muted });

  const inventory = new Map();
  for (const profile of profiles) {
    const names = sourceNames(profile);
    for (const name of names.length ? names : ['Source not named in response']) inventory.set(name, (inventory.get(name) || 0) + 1);
  }
  section('Returned source inventory', 'Named databases and authorities', 70);
  paragraph('These sources are attached to returned candidate records, not verified hits for the searched entity. Counts are candidate appearances. Some links point to a database homepage rather than a specific record.', { size: 8.3, color: C.muted });
  if (!inventory.size) paragraph('No named source or database was attached to a returned profile.', { color: C.green });
  for (const [name, count] of [...inventory.entries()].sort((a, b) =>
    Number(a[0] === 'Source not named in response') - Number(b[0] === 'Source not named in response')
    || b[1] - a[1] || a[0].localeCompare(b[0]))) sourceRow(name, count);

  section('Search criteria', 'Submitted input and matching weights', 80);
  for (const [name, value] of [
    ['Subject', request?.name], ['Entity type', request?.type], ['Aliases', unique(scalarValues(request?.alias)).join('; ')],
    ['Submitted country', request?.country], ['Submitted city / state', [request?.city, request?.state].filter(Boolean).join(', ')],
    ['Date of birth', request?.dob], ['Gender', request?.gender], ['Identifier', request?.identifier],
    ['Requested checks', checks.map(check => check.name).join(', ')], ['Fuzziness', request?.fuzziness]
  ]) if (value !== undefined && value !== null && value !== '') row(name, String(value));
  if (Array.isArray(request?.fields_weightage) && request.fields_weightage.length) {
    row('Field weighting', request.fields_weightage.map(item => label(item.field) + ' ' + Math.round(Number(item.weightage || 0) * 100) + '%').join(', '));
  }
  const countryWeight = request?.fields_weightage?.find(item => item.field === 'country')?.weightage;
  if (request?.country && Number(countryWeight) === 0) paragraph('Country was submitted with 0% matching weight; do not interpret it as country-verified identity. City is shown as submitted input and has no separate weight here.', { size: 8.4, color: C.amber });
  paragraph('Blank optional criteria were not supplied. Search scores are returned by the screening dataset; they do not establish that a candidate is the searched entity.', { size: 8, color: C.muted });

  section('Candidate evidence', 'Returned profiles', profiles.length ? 180 : 35);
  if (!profiles.length) paragraph('No candidate profiles were returned.', { size: 9, color: C.green });
  for (let i = 0; i < profiles.length; i++) candidateCard(profiles[i], i);
  if (!profiles.length && potential) paragraph('The response contains candidate records outside the common profile list. See the dataset outcomes above.', { size: 8, color: C.muted });

  section('Audit trail', 'Integrity and interpretation', 225);
  row('Report reference', reportId);
  row('Screening transaction', transactionId || 'Not supplied');
  row('Completed (UTC)', generatedAt);
  row(requestSha256 ? 'Request body SHA-256' : 'Canonical request SHA-256', requestSha256 || hash(request));
  row(responseSha256 ? 'Response body SHA-256' : 'Canonical response SHA-256', responseSha256 || hash(response));
  row('Transport status', String(httpStatus || 'Not supplied'));
  row('Candidate profiles', String(profiles.length));
  if (profiles.length >= 100) paragraph('Exactly 100 profiles were returned. The response does not establish whether additional results exist beyond those returned.', { size: 8, color: C.amber });
  paragraph('This PDF was generated from the server-observed screening response. Body fingerprints can be compared with the original API request and response bytes retained by the customer. The JSON is not embedded and cannot be reconstructed from this PDF; retain the API response separately.', { size: 8, color: C.muted });
  paragraph('Review names, entity type, location, identifiers, and the underlying source record before any compliance decision. A list category or source link alone is not proof of misconduct. Absence of returned candidates is not proof that every external database or publication is clear.', { size: 8, color: C.red });

  pdf.setTitle('KYCProbe AML Screening - ' + pdfText(request?.name || 'Entity'));
  pdf.setSubject('Entity screening report ' + reportId);
  pdf.setAuthor('KYCProbe by AI7Lab UAE');
  pdf.setCreator('KYCProbe Verification API');
  pdf.setProducer('KYCProbe Verification API');
  pdf.setCreationDate(new Date(generatedAt));
  pages.forEach((item, index) => {
    item.drawLine({ start: { x: PAGE.margin, y: 43 }, end: { x: PAGE.width - PAGE.margin, y: 43 }, thickness: .7, color: C.line });
    item.drawText(reportId, { x: PAGE.margin, y: 26, size: 7, font: regular, color: C.muted });
    const counter = (index + 1) + ' / ' + pages.length;
    item.drawText(counter, { x: PAGE.width - PAGE.margin - regular.widthOfTextAtSize(counter, 7), y: 26,
      size: 7, font: regular, color: C.muted });
  });
  return { bytes: Buffer.from(await pdf.save()), reportId, generatedAt, outcome: status,
    candidateSummary: { returned: potential, categoryAppearances, nameAligned, partialNames, namesAbsent, typeConflicts, plausibleNames },
    datasetOutcomes: checks.map(check => ({ name: check.name, count: check.records.length, assessed: check.assessed })) };
}
