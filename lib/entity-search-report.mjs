import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PAGE = { width: 595.28, height: 841.89, margin: 48 };
const COLORS = {
  ink: rgb(7 / 255, 20 / 255, 18 / 255),
  green: rgb(29 / 255, 111 / 255, 80 / 255),
  mint: rgb(184 / 255, 255 / 255, 101 / 255),
  paper: rgb(244 / 255, 247 / 255, 243 / 255),
  muted: rgb(95 / 255, 110 / 255, 105 / 255),
  line: rgb(220 / 255, 230 / 255, 225 / 255),
  amber: rgb(179 / 255, 112 / 255, 21 / 255),
  red: rgb(161 / 255, 77 / 255, 52 / 255),
  white: rgb(1, 1, 1)
};

const SECTION_SOURCES = {
  pep: ['pep', 'profiles'],
  sanction: ['sanction', 'sanctions', 'profiles'],
  aml: ['aml'],
  watchlist: ['watchlist', 'watchlists', 'profiles'],
  russiabridge: ['russiabridge'],
  dualgoods: ['dualgoods', 'dual_goods'],
  sanctionedgoods: ['sanctionedgoods', 'sanctioned_goods'],
  apc: ['apc'],
  er_apc: ['er_apc', 'apc']
};

const SECTION_LABELS = {
  pep: 'Politically Exposed Persons',
  sanction: 'Sanctions',
  aml: 'AML Risk Events',
  watchlist: 'Watchlists',
  russiabridge: 'Russia Bridge Exposure',
  dualgoods: 'Dual-use Goods',
  sanctionedgoods: 'Sanctioned Goods',
  apc: 'Adverse Media',
  er_apc: 'Enhanced Adverse Media'
};

function printable(value) {
  return String(value ?? '')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, (character) => {
      const code = character.codePointAt(0);
      return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`;
    });
}

function stableJson(value) {
  try { return JSON.stringify(value, null, 2); } catch { return JSON.stringify({ value: String(value) }, null, 2); }
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function titleCase(value) {
  return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function firstDefined(object, keys) {
  if (!object || typeof object !== 'object') return undefined;
  for (const key of keys) if (Object.hasOwn(object, key)) return object[key];
  return undefined;
}

function categoryIncludes(profile, pattern) {
  const categories = Array.isArray(profile?.category) ? profile.category : [profile?.category];
  return categories.some((category) => pattern.test(String(category || '')));
}

function sectionValue(data, check) {
  if (!data || typeof data !== 'object') return undefined;
  const direct = firstDefined(data, SECTION_SOURCES[check] || [check]);
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  if (check === 'pep' && profiles.length) return profiles.filter((profile) => categoryIncludes(profile, /(^|\b)PEP(\b|$)/i) || profile.pep);
  if (check === 'sanction' && profiles.length) return profiles.filter((profile) => categoryIncludes(profile, /SAN|SANCTION/i) || recordCount(profile.sanctions) > 0);
  if (check === 'watchlist' && profiles.length) return profiles.filter((profile) => categoryIncludes(profile, /WLT|WATCH/i) || recordCount(profile.watchlists) > 0);
  if ((check === 'apc' || check === 'er_apc') && direct === profiles) {
    return profiles.filter((profile) => recordCount(profile.apc) > 0 || recordCount(profile.apc_info) > 0);
  }
  return direct;
}

function recordCount(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return value ? 1 : 0;
  for (const key of ['matches', 'results', 'profiles', 'data', 'items']) {
    if (Array.isArray(value[key])) return value[key].length;
  }
  const arrays = Object.values(value).filter(Array.isArray);
  if (arrays.length) return arrays.reduce((total, entries) => total + entries.length, 0);
  return Object.keys(value).length ? 1 : 0;
}

function responseMessage(response) {
  if (!response || typeof response !== 'object') return '';
  return response.message || response.msg || response.status || response.error || '';
}

function wrapText(font, text, size, maxWidth) {
  const paragraphs = printable(text).split('\n');
  const lines = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) { lines.push(''); continue; }
    const words = paragraph.split(/\s+/);
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        current = word;
        continue;
      }
      let fragment = '';
      for (const character of word) {
        if (font.widthOfTextAtSize(fragment + character, size) > maxWidth && fragment) {
          lines.push(fragment);
          fragment = character;
        } else fragment += character;
      }
      current = fragment;
    }
    if (current) lines.push(current);
  }
  return lines;
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export async function createEntitySearchAuditPdf({ request, response, httpStatus, completedAt, logoBytes, logoType }) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const generatedAt = formatTimestamp(completedAt);
  const reportId = `AI7-${sha256({ request, response, generatedAt }).slice(0, 16).toUpperCase()}`;
  const selectedChecks = Array.isArray(request?.search_type) ? request.search_type : [];
  const data = response && typeof response === 'object' && !Array.isArray(response) ? response.data : undefined;
  const pages = [];
  let page;
  let y;

  function addPage(section = 'ENTITY SCREENING AUDIT REPORT') {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    pages.push(page);
    page.drawRectangle({ x: 0, y: PAGE.height - 34, width: PAGE.width, height: 34, color: COLORS.ink });
    page.drawText('AI7 UAE', { x: PAGE.margin, y: PAGE.height - 23, size: 9, font: bold, color: COLORS.mint });
    page.drawText(printable(section), { x: PAGE.margin + 62, y: PAGE.height - 23, size: 7, font: regular, color: COLORS.white });
    y = PAGE.height - 65;
  }

  function ensureSpace(height, section) {
    if (y - height < 62) addPage(section);
  }

  function line(text, { size = 9, font = regular, color = COLORS.ink, indent = 0, gap = 4, maxWidth = PAGE.width - PAGE.margin * 2 - indent } = {}) {
    const lines = wrapText(font, text, size, maxWidth);
    const lineHeight = size * 1.42;
    ensureSpace(lines.length * lineHeight + gap, 'REPORT CONTINUED');
    for (const item of lines) {
      page.drawText(item || ' ', { x: PAGE.margin + indent, y, size, font, color });
      y -= lineHeight;
    }
    y -= gap;
  }

  function heading(text, kicker) {
    ensureSpace(58, text);
    y -= 7;
    if (kicker) line(kicker.toUpperCase(), { size: 7, font: bold, color: COLORS.green, gap: 5 });
    line(text, { size: 18, font: bold, color: COLORS.ink, gap: 10 });
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.width - PAGE.margin, y }, thickness: 1, color: COLORS.line });
    y -= 15;
  }

  function keyValue(label, value) {
    ensureSpace(28, 'REPORT CONTINUED');
    page.drawText(printable(label).toUpperCase(), { x: PAGE.margin, y, size: 6.5, font: bold, color: COLORS.green });
    page.drawText(printable(value || '-'), { x: PAGE.margin + 145, y: y - 1, size: 8.5, font: regular, color: COLORS.ink, maxWidth: 350 });
    y -= 22;
  }

  addPage();
  page.drawRectangle({ x: PAGE.margin, y: y - 128, width: PAGE.width - PAGE.margin * 2, height: 128, color: COLORS.paper });
  let embeddedLogo;
  if (logoBytes && logoType === 'image/png') embeddedLogo = await pdf.embedPng(logoBytes).catch(() => undefined);
  if (logoBytes && (logoType === 'image/jpeg' || logoType === 'image/jpg')) embeddedLogo = await pdf.embedJpg(logoBytes).catch(() => undefined);
  if (embeddedLogo) {
    const scaled = embeddedLogo.scaleToFit(94, 48);
    page.drawImage(embeddedLogo, { x: PAGE.width - PAGE.margin - scaled.width - 18, y: y - 72, width: scaled.width, height: scaled.height });
  }
  page.drawText('ENTITY SCREENING', { x: PAGE.margin + 22, y: y - 34, size: 8, font: bold, color: COLORS.green });
  page.drawText('Audit report', { x: PAGE.margin + 22, y: y - 65, size: 26, font: bold, color: COLORS.ink });
  page.drawText(printable(request?.name || 'Unnamed entity'), { x: PAGE.margin + 22, y: y - 91, size: 12, font: regular, color: COLORS.muted, maxWidth: 300 });
  y -= 155;
  keyValue('Report reference', reportId);
  keyValue('Generated at', `${generatedAt} (UTC)`);
  keyValue('Screening endpoint', 'api.ai7uae.com/service/entity_search');
  keyValue('Processing gateway', 'AI7 UAE API - Microsoft Azure UAE North');
  keyValue('Entity type', request?.type || '-');
  keyValue('Checks requested', selectedChecks.map(titleCase).join(', ') || '-');
  keyValue('HTTP result', `${httpStatus || '-'} ${responseMessage(response)}`.trim());
  y -= 8;
  line('Location record: the processing location above identifies the AI7 wrapper region. It does not assert the physical processing location of upstream datasets.', { size: 7.5, color: COLORS.muted, gap: 8 });
  line('Audit notice: this automated report records the submitted criteria and returned data. Potential matches require trained human review and must not be treated as a final compliance decision.', { size: 8, font: bold, color: COLORS.red });

  heading('Executive risk overview', 'Automated summary');
  const sections = selectedChecks.map((check) => {
    const value = sectionValue(data, check);
    const count = recordCount(value);
    return { check, label: SECTION_LABELS[check] || titleCase(check), value, count, available: value !== undefined };
  });
  const responseFailed = Number(httpStatus) >= 400 || !response || typeof response !== 'object';
  const signals = sections.reduce((total, section) => total + section.count, 0);
  const overview = responseFailed ? 'INDETERMINATE - REQUEST DID NOT COMPLETE SUCCESSFULLY' : signals > 0 ? 'REVIEW REQUIRED - RESPONSE CONTAINS RECORDS' : 'NO RECORDS IDENTIFIED IN DEDICATED CHECK SECTIONS';
  const overviewColor = responseFailed ? COLORS.red : signals > 0 ? COLORS.amber : COLORS.green;
  page.drawRectangle({ x: PAGE.margin, y: y - 43, width: PAGE.width - PAGE.margin * 2, height: 43, color: COLORS.paper, borderColor: overviewColor, borderWidth: 1.2 });
  page.drawText(overview, { x: PAGE.margin + 14, y: y - 26, size: 10, font: bold, color: overviewColor, maxWidth: PAGE.width - PAGE.margin * 2 - 28 });
  y -= 62;
  line(`Returned section records: ${signals}. Selected checks: ${selectedChecks.length}. Response fingerprint: ${sha256(response)}`, { size: 7.5, color: COLORS.muted });

  heading('Risk sections', 'Check-by-check review');
  if (!sections.length) line('No search types were recorded in the request.', { color: COLORS.muted });
  for (const section of sections) {
    ensureSpace(76, 'RISK SECTIONS');
    const status = !section.available ? 'No dedicated response object' : section.count > 0 ? `${section.count} record(s) returned` : 'No records returned';
    const accent = section.count > 0 ? COLORS.amber : COLORS.green;
    page.drawRectangle({ x: PAGE.margin, y: y - 54, width: PAGE.width - PAGE.margin * 2, height: 54, color: COLORS.paper });
    page.drawRectangle({ x: PAGE.margin, y: y - 54, width: 4, height: 54, color: accent });
    page.drawText(printable(section.label), { x: PAGE.margin + 14, y: y - 21, size: 11, font: bold, color: COLORS.ink });
    page.drawText(printable(status), { x: PAGE.margin + 14, y: y - 39, size: 8, font: regular, color: accent });
    y -= 66;
  }
  line('Section counts summarize dedicated response arrays or containers and are not a final risk rating. Refer to the full result appendix and attached source JSON for all returned fields.', { size: 7.5, color: COLORS.muted });

  heading('Search criteria', 'Evidence of scope');
  for (const [key, value] of Object.entries(request || {})) {
    const rendered = typeof value === 'string' ? value : stableJson(value).replace(/\s+/g, ' ');
    keyValue(titleCase(key), rendered || '(blank)');
  }

  heading('Audit trail and integrity', 'External audit support');
  keyValue('Report reference', reportId);
  keyValue('Completion timestamp', `${generatedAt} (UTC)`);
  keyValue('Request SHA-256', sha256(request));
  keyValue('Response SHA-256', sha256(response));
  keyValue('Transport status', httpStatus || '-');
  line('The original UTF-8 request and response JSON files are embedded as PDF attachments. Their SHA-256 fingerprints above allow an auditor to confirm that the evidence has not changed.', { size: 8, color: COLORS.muted });

  heading('Complete response appendix', 'Machine response');
  line('The response below is rendered with non-ASCII characters escaped for reliable PDF portability. The embedded JSON attachment preserves the exact original Unicode data.', { size: 7.5, color: COLORS.muted });
  const appendixSize = 6.1;
  const appendixLineHeight = 7.2;
  const appendixWidth = PAGE.width - PAGE.margin * 2;
  const responseLines = printable(stableJson(response)).split('\n').flatMap((responseLine) => wrapText(mono, responseLine || ' ', appendixSize, appendixWidth));
  let appendixIndex = 0;
  while (appendixIndex < responseLines.length) {
    let capacity = Math.max(1, Math.floor((y - 62) / appendixLineHeight));
    const remaining = responseLines.length - appendixIndex;
    const overflow = remaining - capacity;
    if (overflow > 0 && overflow < 8) capacity = Math.max(1, capacity - (8 - overflow));
    const end = Math.min(responseLines.length, appendixIndex + capacity);
    for (; appendixIndex < end; appendixIndex += 1) {
      page.drawText(responseLines[appendixIndex] || ' ', { x: PAGE.margin, y, size: appendixSize, font: mono, color: COLORS.ink });
      y -= appendixLineHeight;
    }
    if (appendixIndex < responseLines.length) addPage('COMPLETE RESPONSE APPENDIX');
  }

  await pdf.attach(Buffer.from(stableJson(request)), 'entity-search-request.json', { mimeType: 'application/json', description: 'Exact entity search request used for this audit report.' });
  await pdf.attach(Buffer.from(stableJson(response)), 'entity-search-response.json', { mimeType: 'application/json', description: 'Exact entity search response recorded by this audit report.' });
  pdf.setTitle(`AI7 UAE Entity Screening Audit - ${request?.name || 'Entity'}`);
  pdf.setSubject(`Entity screening report ${reportId}`);
  pdf.setAuthor('AI7 UAE');
  pdf.setCreator('AI7 UAE Verification API');
  pdf.setProducer('AI7 UAE Verification API');
  pdf.setCreationDate(new Date(generatedAt));

  pages.forEach((reportPage, index) => {
    reportPage.drawLine({ start: { x: PAGE.margin, y: 34 }, end: { x: PAGE.width - PAGE.margin, y: 34 }, thickness: .6, color: COLORS.line });
    reportPage.drawText(reportId, { x: PAGE.margin, y: 20, size: 6.5, font: regular, color: COLORS.muted });
    const number = `${index + 1} / ${pages.length}`;
    reportPage.drawText(number, { x: PAGE.width - PAGE.margin - regular.widthOfTextAtSize(number, 6.5), y: 20, size: 6.5, font: regular, color: COLORS.muted });
  });

  return { bytes: Buffer.from(await pdf.save()), reportId };
}

