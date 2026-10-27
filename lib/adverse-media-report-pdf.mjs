import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import 'regenerator-runtime/runtime.js';

const PAGE = { width: 595.28, height: 841.89, margin: 47, bottom: 56 };
let BRAND_LOGO_BYTES;
try { BRAND_LOGO_BYTES = readFileSync(new URL('../api-site/assets/kycprobe-logo-white.png', import.meta.url)); }
catch { BRAND_LOGO_BYTES = null; }
const COLOR = {
  navy: rgb(9 / 255, 27 / 255, 52 / 255),
  blue: rgb(26 / 255, 58 / 255, 112 / 255),
  teal: rgb(10 / 255, 111 / 255, 105 / 255),
  gold: rgb(244 / 255, 183 / 255, 43 / 255),
  ink: rgb(26 / 255, 42 / 255, 60 / 255),
  muted: rgb(91 / 255, 109 / 255, 127 / 255),
  pale: rgb(245 / 255, 248 / 255, 252 / 255),
  paleTeal: rgb(232 / 255, 246 / 255, 243 / 255),
  line: rgb(218 / 255, 226 / 255, 235 / 255),
  red: rgb(162 / 255, 52 / 255, 56 / 255),
  paleRed: rgb(252 / 255, 238 / 255, 237 / 255),
  amber: rgb(139 / 255, 88 / 255, 12 / 255),
  paleAmber: rgb(255 / 255, 247 / 255, 229 / 255),
  white: rgb(1, 1, 1)
};

function printable(value) {
  return String(value ?? '').replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}
function evidenceText(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    const normalized = entity.toLowerCase();
    if (normalized in named) return named[normalized];
    const point = normalized.startsWith('#x') ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}
function fieldValue(value) {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  if (Array.isArray(value)) return value.map(fieldValue).join(', ') || 'Not recorded';
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${title(key)}: ${fieldValue(item)}`).join('; ');
  return printable(value);
}
function title(value) { return printable(value || '-').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function stableJson(value) { try { return JSON.stringify(value, null, 2); } catch { return JSON.stringify({ value: String(value) }); } }
function digest(value) { return createHash('sha256').update(Buffer.isBuffer(value) ? value : stableJson(value)).digest('hex'); }
function timestamp(value) {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return printable(value);
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)} UTC`;
}
function percentage(value) { return Number.isFinite(Number(value)) ? `${Number(value)}%` : '-'; }
function riskScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : 'Not scored';
}
function filename(name, date) {
  const slug = String(name || 'entity').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'entity';
  return `kycprobe-adverse-media-${slug}-${date.slice(0, 10)}.pdf`;
}
function bucketGroups(response) {
  if (response.media_buckets) return [
    ['Adverse Media', response.media_buckets.adverse_media || []],
    ['General News Mentions', response.media_buckets.general_news_mentions || []],
    ['No Impact Media', response.media_buckets.no_impact_media || []]
  ];
  const groups = { adverse_media: [], general_news_mentions: [], no_impact_media: [] };
  for (const result of response.results || []) groups[result.media_bucket || 'adverse_media']?.push(result);
  return [['Adverse Media', groups.adverse_media], ['General News Mentions', groups.general_news_mentions],
    ['No Impact Media', groups.no_impact_media]];
}

export async function createAdverseMediaAuditPdf({ request, response, narrative, origin,
  generatedAt = new Date().toISOString(), reportId = randomUUID(), logoBytes, logoType }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const corpus = printable(JSON.stringify({ request, response, narrative }) || '');
  const unicodeFonts = {};
  for (const [key, pattern, file] of [
    ['cjk', /[\u3400-\u9fff\uf900-\ufaff]/u, 'NotoSansCJKsc-Regular.otf'],
    ['devanagari', /[\u0900-\u097f]/u, 'NotoSansDevanagari.ttf'],
    ['arabic', /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u, 'NotoSansArabic.ttf'],
    ['other', /[^\x00-\x7f]/u, 'NotoSans.ttf']
  ]) {
    if (pattern.test(corpus)) unicodeFonts[key] = await pdf.embedFont(
      readFileSync(new URL(`./fonts/${file}`, import.meta.url)),
      { subset: key === 'arabic' || key === 'devanagari' });
  }
  function fontFor(value, defaultFont) {
    const text = String(value ?? '');
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(text) && unicodeFonts.cjk) return unicodeFonts.cjk;
    if (/[\u0900-\u097f]/u.test(text) && unicodeFonts.devanagari) return unicodeFonts.devanagari;
    if (/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(text) && unicodeFonts.arabic) return unicodeFonts.arabic;
    if (/[^\x00-\x7f]/u.test(text) && unicodeFonts.other) return unicodeFonts.other;
    return defaultFont;
  }
  const generated = new Date(generatedAt).toISOString();
  const pages = [];
  const contentWidth = PAGE.width - PAGE.margin * 2;
  let brandLogo;
  try { if (BRAND_LOGO_BYTES) brandLogo = await pdf.embedPng(BRAND_LOGO_BYTES); }
  catch { /* The report remains usable if the bundled brand asset is absent. */ }
  let customerLogo;
  if (logoBytes && logoType === 'image/png') customerLogo = await pdf.embedPng(logoBytes).catch(() => undefined);
  if (logoBytes && ['image/jpeg', 'image/jpg'].includes(logoType)) customerLogo = await pdf.embedJpg(logoBytes).catch(() => undefined);

  let page;
  let y;
  function wrap(font, value, size, width) {
    const lines = [];
    for (const paragraph of printable(value).split('\n')) {
      if (!paragraph) { lines.push(''); continue; }
      let current = '';
      for (const word of paragraph.split(/\s+/)) {
        const next = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= width) { current = next; continue; }
        if (current) lines.push(current);
        current = '';
        for (const character of word) {
          if (current && font.widthOfTextAtSize(current + character, size) > width) {
            lines.push(current); current = character;
          } else current += character;
        }
      }
      if (current) lines.push(current);
    }
    return lines;
  }
  function addPage(section) {
    page = pdf.addPage([PAGE.width, PAGE.height]); pages.push(page);
    page.drawRectangle({ x: 0, y: PAGE.height - 50, width: PAGE.width, height: 50, color: COLOR.navy });
    page.drawRectangle({ x: 0, y: PAGE.height - 52, width: PAGE.width, height: 2, color: COLOR.gold });
    if (brandLogo) {
      const scaled = brandLogo.scaleToFit(105, 37);
      page.drawImage(brandLogo, { x: PAGE.margin, y: PAGE.height - 44 + (37 - scaled.height) / 2,
        width: scaled.width, height: scaled.height });
    } else page.drawText('KYCProbe', { x: PAGE.margin, y: PAGE.height - 31, size: 16, font: bold, color: COLOR.white });
    page.drawText(printable(section).toUpperCase(), { x: PAGE.width - PAGE.margin - 188,
      y: PAGE.height - 30, size: 8, font: bold, color: COLOR.white });
    y = PAGE.height - 81;
  }
  function ensure(height, section = 'REPORT CONTINUED') {
    if (y - height < PAGE.bottom) addPage(section);
  }
  function paragraph(value, { size = 9, font = regular, color = COLOR.ink, x = PAGE.margin,
    width = contentWidth, lineHeight = size * 1.45, gap = 7 } = {}) {
    const usedFont = fontFor(value, font);
    const lines = wrap(usedFont, value || '-', size, width);
    for (const item of lines) {
      ensure(lineHeight + 3);
      if (item) page.drawText(item, { x, y, size, font: usedFont, color });
      y -= lineHeight;
    }
    y -= gap;
  }
  function section(kicker, name) {
    ensure(58, name);
    y -= 7;
    page.drawText(printable(kicker).toUpperCase(), { x: PAGE.margin, y, size: 7.5, font: bold, color: COLOR.teal });
    y -= 23;
    paragraph(name, { size: 18, font: bold, color: COLOR.navy, lineHeight: 22, gap: 3 });
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.width - PAGE.margin, y },
      thickness: 1, color: COLOR.line });
    y -= 14;
  }
  function row(label, value, { color = COLOR.ink, font = regular } = {}) {
    const usedFont = fontFor(value, font);
    const lines = wrap(usedFont, value || '-', 8.8, contentWidth - 157);
    const height = Math.max(24, lines.length * 12.4 + 9);
    ensure(height);
    page.drawText(printable(label).toUpperCase(), { x: PAGE.margin, y: y - 2, size: 7.1, font: bold, color: COLOR.muted });
    lines.forEach((line, index) => {
      if (line) page.drawText(line, { x: PAGE.margin + 157, y: y - 2 - index * 12.4, size: 8.8, font: usedFont, color });
    });
    y -= height;
    page.drawLine({ start: { x: PAGE.margin, y: y + 3 }, end: { x: PAGE.width - PAGE.margin, y: y + 3 },
      thickness: 0.5, color: COLOR.line });
  }
  function bullets(items, color = COLOR.ink) {
    if (!items?.length) return paragraph('None recorded.', { color: COLOR.muted });
    for (const item of items) {
      ensure(18);
      page.drawCircle({ x: PAGE.margin + 5, y: y + 3, size: 2.5, color: COLOR.teal });
      paragraph(item, { x: PAGE.margin + 17, width: contentWidth - 17, size: 9, color, gap: 5 });
    }
  }
  function callout(text, { fill = COLOR.paleTeal, accent = COLOR.teal, size = 8.8 } = {}) {
    const usedFont = fontFor(text, regular);
    const lines = wrap(usedFont, text, size, contentWidth - 28);
    const height = Math.max(38, lines.length * size * 1.45 + 18);
    ensure(height + 8);
    page.drawRectangle({ x: PAGE.margin, y: y - height + 7, width: contentWidth, height, color: fill });
    page.drawRectangle({ x: PAGE.margin, y: y - height + 7, width: 3, height, color: accent });
    lines.forEach((item, index) => page.drawText(item || ' ', {
      x: PAGE.margin + 14, y: y - 8 - index * size * 1.45, size, font: usedFont, color: COLOR.ink
    }));
    y -= height + 9;
  }
  function metric(x, top, width, label, value, accent) {
    page.drawRectangle({ x, y: top - 72, width, height: 72, color: COLOR.pale });
    page.drawRectangle({ x, y: top - 72, width: 3, height: 72, color: accent });
    page.drawText(label.toUpperCase(), { x: x + 13, y: top - 21, size: 7, font: bold, color: COLOR.muted });
    const lines = wrap(bold, value, 12, width - 25).slice(0, 2);
    lines.forEach((item, index) => page.drawText(item, {
      x: x + 13, y: top - 45 - index * 15, size: 12, font: bold, color: COLOR.navy
    }));
  }
  function finding(result, index, group) {
    const adverse = group === 'Adverse Media';
    const band = adverse ? title(result.risk_level) : group === 'General News Mentions' ? 'Context only' : 'No impact';
    ensure(165, 'EVIDENCE REGISTER');
    y -= 9;
    page.drawRectangle({ x: PAGE.margin, y: y - 2, width: contentWidth, height: 2,
      color: adverse ? COLOR.red : COLOR.teal });
    y -= 18;
    page.drawText(`${index + 1}.`, { x: PAGE.margin, y, size: 11.3, font: bold, color: COLOR.navy });
    paragraph(evidenceText(result.title || 'Untitled result'), {
      x: PAGE.margin + 22, width: contentWidth - 22, size: 11.3, font: bold, color: COLOR.navy, lineHeight: 14.2, gap: 3
    });
    paragraph(`${evidenceText(result.publisher || 'Publisher unavailable')}  |  ${timestamp(result.published_at)}  |  ${title(result.language || 'Language unavailable')}`, {
      size: 8.1, color: COLOR.muted, gap: 5
    });
    const scoreText = adverse ? `  |  Risk score: ${riskScore(result.risk_score)}` : '';
    paragraph(`Classification: ${group}  |  ${band}${scoreText}`, {
      size: 8.7, font: bold, color: adverse ? COLOR.red : COLOR.teal, gap: 5
    });
    paragraph(`Subject role: ${title(result.subject_role || 'unresolved')}  |  Legal stage: ${title(result.legal_stage || 'not established')}`, {
      size: 8.4, gap: 4
    });
    if (adverse && result.categories?.length) paragraph(`Risk categories: ${result.categories.map(title).join(', ')}`, { size: 8.4, gap: 4 });
    const match = result.identity_match;
    if (match) paragraph(`Identity match: ${title(match.type || 'unresolved')}${Number.isFinite(Number(match.score)) ? ` (${riskScore(match.score)})` : ''}`, {
      size: 8.4, gap: 3
    });
    if (match?.matched_input) paragraph(`Matched input: ${evidenceText(match.matched_input)}`, { size: 8.2, gap: 3 });
    if (match?.explanation) paragraph(`Match explanation: ${evidenceText(match.explanation)}`, { size: 8.2, color: COLOR.muted, gap: 5 });
    paragraph(`Source type: ${title(result.source_type || 'not specified')}  |  Search+ publisher match: ${result.search_plus_match ? 'Yes' : 'No'}`, {
      size: 8.2, gap: 5
    });
    if (adverse) paragraph(`Review required: ${result.review_required ? 'Yes' : 'No'}`, { size: 8.2, gap: 4 });
    if (result.evidence_assessment) {
      paragraph('EVIDENCE ASSESSMENT', { size: 7, font: bold, color: COLOR.teal, gap: 2 });
      paragraph(evidenceText(result.evidence_assessment), { size: 8.5, gap: 6 });
    }
    if (result.excerpt) {
      paragraph('SOURCE EXCERPT', { size: 7, font: bold, color: COLOR.teal, gap: 2 });
      paragraph(evidenceText(result.excerpt), { size: 8.5, color: COLOR.muted, gap: 6 });
    }
    paragraph(`Source URL: ${result.url || 'Unavailable'}`, { size: 7.5, font: mono, color: COLOR.blue, gap: 9 });
    if (result.result_id) paragraph(`Evidence ID: ${result.result_id}`, { size: 7.2, font: mono, color: COLOR.muted, gap: 5 });
  }
  function publisherList(label, publishers, accent) {
    section('Publisher search scope', `${label} (${publishers.length})`);
    if (!publishers.length) return paragraph('None recorded.', { color: COLOR.muted });
    const half = (contentWidth - 16) / 2;
    for (let index = 0; index < publishers.length; index += 2) {
      const cells = publishers.slice(index, index + 2).map((publisher) => {
        const nameText = publisher.name || publisher.domain || 'Unnamed publisher';
        const detailText = `${publisher.domain || '-'}  |  ${publisher.country_code || publisher.country || '-'}`;
        const nameFont = fontFor(nameText, bold);
        const detailFont = fontFor(detailText, regular);
        const name = wrap(nameFont, nameText, 8.1, half - 14);
        const detail = wrap(detailFont, detailText, 7.5, half - 14);
        return { name, detail, nameFont, detailFont };
      });
      const height = Math.max(...cells.map((cell) => 11 + cell.name.length * 10 + cell.detail.length * 9 + 7), 34);
      ensure(height + 5, 'PUBLISHER SEARCH SCOPE');
      cells.forEach((cell, cellIndex) => {
        const x = PAGE.margin + cellIndex * (half + 16);
        page.drawRectangle({ x, y: y - height + 2, width: half, height, color: COLOR.pale });
        page.drawRectangle({ x, y: y - height + 2, width: 2, height, color: accent });
        let rowY = y - 13;
        cell.name.forEach((item) => { page.drawText(item, { x: x + 8, y: rowY, size: 8.1, font: cell.nameFont, color: COLOR.navy }); rowY -= 10; });
        cell.detail.forEach((item) => { page.drawText(item, { x: x + 8, y: rowY, size: 7.5, font: cell.detailFont, color: COLOR.muted }); rowY -= 9; });
      });
      y -= height + 5;
    }
  }

  const groups = bucketGroups(response);
  const counts = groups.map(([, items]) => items.length);
  const complete = response.coverage?.complete === true && response.summary?.decision_eligible === true;
  const profile = complete
    ? title(response.summary?.profile_status || response.summary?.outcome || 'Inconclusive')
    : 'Inconclusive';
  const profileColor = profile === 'Unsafe' ? COLOR.red : profile === 'Safe' ? COLOR.teal : COLOR.amber;

  addPage('Screening report');
  const heroHeight = 187;
  page.drawRectangle({ x: PAGE.margin, y: y - heroHeight, width: contentWidth, height: heroHeight, color: COLOR.navy });
  page.drawRectangle({ x: PAGE.margin, y: y - heroHeight, width: 5, height: heroHeight, color: COLOR.gold });
  page.drawText('ADVERSE MEDIA SCREENING RESULT', { x: PAGE.margin + 22, y: y - 30,
    size: 8, font: bold, color: COLOR.gold });
  const entityName = response.entity?.name || request.name || 'Unnamed subject';
  const entityFont = fontFor(entityName, bold);
  const nameLines = wrap(entityFont, entityName, 22, customerLogo ? 315 : contentWidth - 48).slice(0, 3);
  nameLines.forEach((item, index) => page.drawText(item, { x: PAGE.margin + 22,
    y: y - 66 - index * 27, size: 22, font: entityFont, color: COLOR.white }));
  page.drawText(`TRANSACTION  ${printable(response.screening_id || 'Unavailable')}`, {
    x: PAGE.margin + 22, y: y - 128, size: 7.6, font: bold, color: COLOR.gold
  });
  page.drawText(`${title(response.entity?.entity_type || request.entity_type)}  |  ${timestamp(response.completed_at)}`, {
    x: PAGE.margin + 22, y: y - 157, size: 8.5, font: regular, color: COLOR.white
  });
  if (customerLogo) {
    const scaled = customerLogo.scaleToFit(114, 68);
    page.drawRectangle({ x: PAGE.width - PAGE.margin - 139, y: y - 112, width: 126, height: 82, color: COLOR.white });
    page.drawImage(customerLogo, { x: PAGE.width - PAGE.margin - 133 + (114 - scaled.width) / 2,
      y: y - 105 + (68 - scaled.height) / 2, width: scaled.width, height: scaled.height });
  }
  y -= heroHeight + 18;
  const metricWidth = (contentWidth - 20) / 3;
  metric(PAGE.margin, y, metricWidth, 'Profile', profile, profileColor);
  metric(PAGE.margin + metricWidth + 10, y, metricWidth, 'Coverage', response.coverage?.complete ? 'Complete' : 'Incomplete',
    response.coverage?.complete ? COLOR.teal : COLOR.amber);
  metric(PAGE.margin + (metricWidth + 10) * 2, y, metricWidth, 'Media buckets',
    `${counts[0]} adverse / ${counts[1]} general / ${counts[2]} no impact`, COLOR.blue);
  y -= 91;
  section('Decision support', 'Executive summary');
  paragraph(narrative?.summary || response.summary?.statement || 'No summary available.', { size: 10.5, lineHeight: 15.5, gap: 12 });
  if (response.summary?.statement && response.summary.statement !== narrative?.summary) {
    paragraph(`Screening determination: ${response.summary.statement}`, { size: 8.7, color: COLOR.muted, gap: 10 });
  }
  callout(complete
    ? (profile === 'Safe'
      ? 'No qualifying adverse result was found in the retrieved evidence. This is a screening outcome, not a guarantee that no adverse information exists.'
      : 'Review the cited evidence and confirm subject identity before making a compliance decision.')
    : 'Screening coverage or classification is incomplete. Do not use this report as a completed compliance decision.',
  { fill: complete ? COLOR.paleTeal : COLOR.paleAmber, accent: profileColor });
  section('What matters', 'Key findings');
  bullets(narrative?.findings || []);
  section('Recommended action', 'Next steps');
  bullets(narrative?.recommendations || [], COLOR.ink);

  if (y < PAGE.height - 210) addPage('Coverage and method');
  section('Screening configuration', 'Coverage and method');
  row('API status', title(response.status));
  row('Profile', profile);
  row('Outcome', title(response.summary?.outcome));
  row('Entity aliases', fieldValue(response.entity?.aliases));
  row('Entity countries', fieldValue(response.entity?.countries));
  row('Risk level', title(response.summary?.risk_level));
  row('Highest adverse score', riskScore(response.summary?.highest_risk_score));
  row('High risk threshold', percentage(response.summary?.thresholds?.high_risk_percent));
  row('Review threshold', percentage(response.summary?.thresholds?.review_percent));
  row('Safe band', `Below ${percentage(response.summary?.thresholds?.safe_below_percent)}`);
  row('Risk distribution', `${response.summary?.risk_distribution?.high_risk || 0} high / ${response.summary?.risk_distribution?.review || 0} review / ${response.summary?.risk_distribution?.safe || 0} safe`);
  row('Date range', `${response.coverage?.date_from || 'Unrestricted'} to ${response.coverage?.date_to || 'Present'}`);
  row('Geographic scope', title(response.coverage?.geographic_scope));
  if (response.coverage?.regional_packs?.length) row('Regional packs', fieldValue(response.coverage.regional_packs));
  row('Languages requested', (response.coverage?.languages_requested || []).map((item) => `${item.name} (${item.code})`).join(', ') || 'Not recorded');
  row('Languages searched', (response.coverage?.languages_searched || []).map((item) => `${item.name} (${item.code})`).join(', ') || 'Not recorded');
  if (response.coverage?.languages_not_searched?.length) row('Not searched', response.coverage.languages_not_searched.join(', '));
  row('Archive window', response.coverage?.archive_window || 'Not recorded');
  if (response.coverage?.archive_snapshot) row('Archive snapshot', fieldValue(response.coverage.archive_snapshot));
  row('Search+', response.coverage?.search_plus?.requested ? 'Requested' : 'Not requested');
  section('Source readiness', 'Search source status');
  for (const source of response.coverage?.sources || []) row(title(source.source), title(source.status));
  if (!response.coverage?.sources?.length) paragraph('No source status was recorded.', { color: COLOR.muted });
  if (response.coverage?.reason_codes?.length) {
    section('Coverage notices', 'Checks requiring attention');
    bullets(response.coverage.reason_codes.map(title), COLOR.amber);
  }
  callout(response.coverage?.limitation || 'Public-source indexing cannot guarantee every publication is discoverable.', {
    fill: COLOR.pale, accent: COLOR.blue
  });
  callout('Search+ records completed site-restricted index queries. A completed publisher query does not prove every article from that outlet was read.', {
    fill: COLOR.pale, accent: COLOR.blue
  });

  if (y < PAGE.height - 210) addPage('Evidence register');
  section('All classified hits', 'Evidence register');
  paragraph('Every retrieved result is grouped below. Only Adverse Media results contribute to the profile decision. Titles, excerpts, and assessments should be checked against the linked source before action.', {
    size: 9, color: COLOR.muted, gap: 9
  });
  const nonEmptyGroups = groups.filter(([, results]) => results.length);
  if (!nonEmptyGroups.length) callout('No retrieved media result was classified in this screening.', {
    fill: COLOR.pale, accent: COLOR.teal
  });
  for (const [group, results] of nonEmptyGroups) {
    ensure(220, 'EVIDENCE REGISTER');
    section(`${results.length} RESULT${results.length === 1 ? '' : 'S'}`, group);
    results.forEach((result, index) => finding(result, index, group));
  }

  if (response.coverage?.search_plus?.requested) {
    addPage('Publisher search scope');
    section('Search+ audit', 'Publisher search scope');
    const searchPlus = response.coverage.search_plus;
    row('Catalog size', String(searchPlus.publisher_catalog_size ?? 'Not recorded'));
    row('Publishers attempted', String(searchPlus.publishers_attempted ?? 'Not recorded'));
    row('Matching results', String(searchPlus.matched_results ?? 0));
    paragraph('The lists below record publisher-targeted index queries, not a guarantee of article-level coverage.', {
      color: COLOR.muted
    });
    publisherList('Queries completed', searchPlus.publishers_screened || [], COLOR.teal);
    if (searchPlus.publishers_not_completed?.length) publisherList('Queries not completed', searchPlus.publishers_not_completed, COLOR.amber);
    if (searchPlus.matched_publishers?.length) publisherList('Publishers with matching results', searchPlus.matched_publishers, COLOR.blue);
  }

  if (y < PAGE.height - 210) addPage('Audit record');
  section('Transaction and provenance', 'Audit record');
  row('Transaction ID', response.screening_id);
  row('Report ID', reportId);
  row('Request received', timestamp(origin?.received_at));
  row('Screen completed', timestamp(response.completed_at));
  row('Report generated', timestamp(generated));
  row('Search executed', timestamp(response.coverage?.searched_at));
  row('Request network address', origin?.network_origin || 'Unavailable');
  row('Processing location', origin?.processing_location || 'Microsoft Azure UAE North');
  row('Request SHA-256', digest(request), { font: mono });
  row('Screening response SHA-256', digest(response), { font: mono });
  section('How to use this record', 'Interpretation');
  callout('A network address may identify a proxy or gateway and does not establish the requester\'s physical location.', {
    fill: COLOR.pale, accent: COLOR.blue
  });
  callout('This screening records retrieved public evidence and configured source coverage. It does not establish guilt, innocence, identity, or universal absence of adverse information.', {
    fill: COLOR.paleAmber, accent: COLOR.amber
  });
  paragraph('The complete submitted request and final JSON response are retained privately for 365 days. The PDF contains human-readable evidence and integrity hashes; raw JSON is not embedded in the public download.', {
    size: 8.7, color: COLOR.muted
  });

  pages.forEach((item, index) => {
    item.drawLine({ start: { x: PAGE.margin, y: 41 }, end: { x: PAGE.width - PAGE.margin, y: 41 },
      thickness: 0.7, color: COLOR.line });
    item.drawText('KYCProbe by AI7Lab UAE  |  Confidential screening record', {
      x: PAGE.margin, y: 25, size: 7, font: regular, color: COLOR.muted
    });
    item.drawText(`${index + 1} / ${pages.length}`, {
      x: PAGE.width - PAGE.margin - 34, y: 25, size: 7, font: bold, color: COLOR.muted
    });
  });
  pdf.setTitle(`Adverse Media Screening Result - ${entityName}`);
  pdf.setAuthor('KYCProbe by AI7Lab UAE');
  pdf.setSubject(`Transaction ${response.screening_id}`);
  pdf.setCreationDate(new Date(generated));
  const bytes = Buffer.from(await pdf.save());
  return { bytes, reportId, sha256: digest(bytes), generatedAt: generated, filename: filename(entityName, generated) };
}
