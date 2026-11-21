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
function filename(name, date, variant) {
  const slug = String(name || 'entity').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'entity';
  return `kycprobe-adverse-media${variant === 'advance' ? '-advance' : ''}-${slug}-${date.slice(0, 10)}.pdf`;
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
  generatedAt = new Date().toISOString(), reportId = randomUUID(), logoBytes, logoType,
  variant = 'standard' }) {
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
    ensure(110, 'EVIDENCE REGISTER');
    y -= 9;
    page.drawRectangle({ x: PAGE.margin, y: y - 2, width: contentWidth, height: 2,
      color: adverse ? COLOR.red : group === 'Needs Review' ? COLOR.amber : COLOR.teal });
    y -= 18;
    page.drawText(`E${String(index + 1).padStart(2, '0')}`, { x: PAGE.margin, y, size: 9.3, font: bold, color: COLOR.teal });
    paragraph(evidenceText(result.title || 'Untitled result'), {
      x: PAGE.margin + 37, width: contentWidth - 37, size: 10.3, font: bold, color: COLOR.navy, lineHeight: 13.5, gap: 3
    });
    paragraph(`${evidenceText(result.publisher || 'Publisher unavailable')}  |  ${timestamp(result.published_at)}  |  ${title(result.language || 'Language unavailable')}`, {
      size: 8.1, color: COLOR.muted, gap: 5
    });
    paragraph(`Media bucket: ${group}${result.subject_role ? `  |  Subject relationship: ${title(result.subject_role)}` : ''}`, {
      size: 8.5, font: bold, color: adverse ? COLOR.red : COLOR.teal, gap: 5 });
    if (adverse && result.categories?.length) paragraph(`Reported event: ${result.categories.map(title).join(', ')}`, { size: 8.4, gap: 4 });
    const match = result.identity_match;
    if (match) paragraph(`Subject match: ${title(match.type || 'unresolved')}`, {
      size: 8.4, gap: 3
    });
    if (match?.matched_input) paragraph(`Matched input: ${evidenceText(match.matched_input)}`, { size: 8.2, gap: 3 });
    if (match?.explanation) paragraph(`Match explanation: ${evidenceText(match.explanation)}`, { size: 8.2, color: COLOR.muted, gap: 5 });
    if (result.evidence_assessment) {
      paragraph('EVIDENCE ASSESSMENT', { size: 7, font: bold, color: COLOR.teal, gap: 2 });
      paragraph(evidenceText(result.evidence_assessment), { size: 8.5, gap: 6 });
    }
    if (result.excerpt) {
      paragraph('SOURCE EXCERPT', { size: 7, font: bold, color: COLOR.teal, gap: 2 });
      paragraph(evidenceText(result.excerpt), { size: 8.5, color: COLOR.muted, gap: 6 });
    }
    paragraph(`Source: ${result.url || 'Unavailable'}`, { size: 7.5, font: mono, color: COLOR.blue, gap: 9 });
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
  const profile = title(response.summary?.profile_status || (
    response.coverage?.complete === true && response.summary?.decision_eligible === true
    && response.summary?.human_review_required === false
    && response.summary?.outcome === 'no_material_results' ? 'safe' : 'inconclusive'));
  const profileColor = profile === 'Unsafe' ? COLOR.red : profile === 'Safe' ? COLOR.teal : COLOR.amber;
  const entityName = response.entity?.name || request.name || 'Unnamed subject';
  const forbiddenSummary = /coverage or classification|source failure|archive review|postings scanned|provider call|reason.code|unscanned|threshold|potentially relevant|safe band|event registry|diffbot|free trial|subscription tier|api plan|provider account|provider pricing/i;
  const leadTitles = groups.flatMap(([, items]) => items).map((item) => evidenceText(item.title || '').trim()).filter(Boolean).slice(0, 2);
  const newsOverview = leadTitles.length
    ? `Collected headlines include ${leadTitles.map((item) => `"${item.slice(0, 90)}"`).join(' and ')}.`
    : 'The selected sources returned no article titles for this subject.';
  const fallbackSummary = `${newsOverview} The profile is ${profile}. The media buckets contain ${counts[0]} adverse, ${counts[1]} general news and ${counts[2]} no-impact mentions.${profile === 'Inconclusive' ? ' Some media mentions cannot be resolved into Safe or Unsafe buckets; human review is required.' : ''}`;
  const summaryText = narrative?.summary && !forbiddenSummary.test(narrative.summary) ? narrative.summary : fallbackSummary;
  const nextStep = profile === 'Unsafe'
    ? 'Review the cited adverse articles and confirm the subject identity through enhanced due diligence before making a decision.'
    : profile === 'Safe'
      ? 'Continue the standard onboarding process and rescreen according to your organisation policy.'
      : 'Have a reviewer resolve the media mentions that cannot be placed in Safe or Unsafe buckets, record the supporting evidence, then reassess the profile.';

  addPage(variant === 'advance' ? 'Adverse media advance' : 'Adverse media report');
  page.drawText('ADVERSE MEDIA PROFILE', { x: PAGE.margin, y, size: 8.5, font: bold, color: COLOR.teal });
  y -= 29;
  paragraph(entityName, { size: 21, font: fontFor(entityName, bold), color: COLOR.navy,
    width: customerLogo ? contentWidth - 110 : contentWidth, lineHeight: 24, gap: 2 });
  if (customerLogo) {
    const scaled = customerLogo.scaleToFit(95, 42);
    page.drawImage(customerLogo, { x: PAGE.width - PAGE.margin - scaled.width, y: PAGE.height - 133,
      width: scaled.width, height: scaled.height });
  }
  paragraph(`${title(response.entity?.entity_type || request.entity_type)}  |  Screened ${timestamp(response.completed_at)}  |  Report ${reportId.slice(0, 8)}`, {
    size: 8.4, color: COLOR.muted, gap: 13 });
  section('01', 'How to read this report');
  paragraph('Profile is the evidence-based adverse-media assessment of the named subject. Media buckets describe how the collected news relates to that subject.', {
    size: 9.2, lineHeight: 13.5, gap: 13 });
  const definitionGap = 8;
  const definitionWidth = (contentWidth - 2 * definitionGap) / 3;
  const definitions = [
    ['Safe', 'All selected checks and mentions are resolved, with no confirmed adverse media.', COLOR.paleTeal, COLOR.teal],
    ['Unsafe', 'At least one confirmed, directly attributable adverse article.', COLOR.paleRed, COLOR.red],
    ['Inconclusive', 'Media mentions cannot be resolved into Safe or Unsafe buckets. Human review is required.', COLOR.paleAmber, COLOR.amber]
  ];
  for (const [index, [label, body, fill, accent]] of definitions.entries()) {
    const x = PAGE.margin + index * (definitionWidth + definitionGap);
    page.drawRectangle({ x, y: y - 77, width: definitionWidth, height: 77, color: fill });
    page.drawRectangle({ x, y: y - 77, width: 3, height: 77, color: accent });
    page.drawText(label, { x: x + 11, y: y - 20, size: 10.2, font: bold, color: accent });
    const lines = wrap(regular, body, 8.1, definitionWidth - 21).slice(0, 5);
    lines.forEach((line, lineIndex) => page.drawText(line, { x: x + 11, y: y - 35 - lineIndex * 10.2,
      size: 8.1, font: regular, color: COLOR.ink }));
  }
  y -= 94;
  paragraph('MEDIA BUCKETS', { size: 7.5, font: bold, color: COLOR.teal, gap: 3 });
  paragraph('Adverse media: supported negative findings. General news: relevant reporting without an adverse finding. No impact: unrelated or non-material mentions.', {
    size: 8.7, lineHeight: 12.5, gap: 14 });
  section('02', 'Executive summary');
  callout(summaryText, { fill: COLOR.pale, accent: COLOR.blue, size: 9.4 });
  ensure(90);
  const metricGap = 8;
  const metricWidth = (contentWidth - 3 * metricGap) / 4;
  metric(PAGE.margin, y, metricWidth, 'Profile status', profile, profileColor);
  metric(PAGE.margin + metricWidth + metricGap, y, metricWidth, 'Adverse', String(counts[0]), COLOR.red);
  metric(PAGE.margin + 2 * (metricWidth + metricGap), y, metricWidth, 'General news', String(counts[1]), COLOR.teal);
  metric(PAGE.margin + 3 * (metricWidth + metricGap), y, metricWidth, 'No impact', String(counts[2]), COLOR.blue);

  addPage('Profile and findings');
  section('03', 'Key findings and profile map');
  paragraph('The profile map connects the conclusions below to the evidence register. A title or name match alone does not establish that an article concerns this subject.', {
    size: 9.2, lineHeight: 13.5, gap: 11 });
  const allResults = groups.flatMap(([, items]) => items);
  const findingCards = [
    ['Screened subject', `${entityName} | ${title(response.entity?.entity_type || request.entity_type)}${response.entity?.countries?.length ? ` | ${response.entity.countries.join(', ')}` : ''}`, COLOR.teal],
    ['News themes', allResults.length ? `E01${allResults.length > 1 ? '-E02' : ''}: Collected headlines include ${allResults.slice(0, 2).map((item) => evidenceText(item.title || 'untitled article')).join(' and ')}.` : 'No media articles were returned by the selected sources.', COLOR.blue],
    ['Direct adverse findings', counts[0] ? `E01${counts[0] > 1 ? `-E${String(counts[0]).padStart(2, '0')}` : ''}: ${counts[0]} adverse item${counts[0] === 1 ? '' : 's'} are listed in the evidence register for review.` : 'No directly attributable adverse article is recorded in the displayed evidence.', counts[0] ? COLOR.red : COLOR.teal],
    ['Mentions for review', profile === 'Inconclusive'
      ? 'Some media mentions cannot yet be placed confidently in Safe or Unsafe buckets. A reviewer should resolve those mentions before deciding.'
      : profile === 'Unsafe' && response.summary?.decision_eligible !== true
        ? 'Direct adverse evidence establishes the Unsafe profile. Other unresolved mentions still require review before closing the case.'
        : 'The displayed profile follows the classified evidence and completed checks.', profileColor]
  ];
  for (const [label, body, accent] of findingCards) {
    const lines = wrap(fontFor(body, regular), body, 8.7, contentWidth - 31);
    const height = Math.max(57, lines.length * 12 + 30);
    ensure(height + 9);
    page.drawRectangle({ x: PAGE.margin, y: y - height, width: contentWidth, height, color: COLOR.pale });
    page.drawRectangle({ x: PAGE.margin, y: y - height, width: 3, height, color: accent });
    page.drawText(label, { x: PAGE.margin + 13, y: y - 18, size: 10, font: bold, color: COLOR.navy });
    lines.forEach((line, index) => page.drawText(line, { x: PAGE.margin + 13, y: y - 33 - index * 12,
      size: 8.7, font: fontFor(body, regular), color: COLOR.ink }));
    y -= height + 9;
  }
  section('04', 'Next step');
  callout(nextStep, { fill: profile === 'Inconclusive' ? COLOR.paleAmber : profile === 'Unsafe' ? COLOR.paleRed : COLOR.paleTeal,
    accent: profileColor, size: 9.2 });
  const advance = variant === 'advance' ? response.advance_assessment : null;
  const sectionOffset = advance ? 1 : 0;
  if (advance) {
    section('05', 'Policy assessment');
    row('Selection', advance.policy_set?.selection_mode === 'all'
      ? `All ${advance.policy_set.selected_policy_ids?.length || 0} policies`
      : `${advance.policy_set?.selected_policy_ids?.length || 0} selected policies`);
    row('Policy outcome', title(advance.policy_outcome?.status || 'review'));
    const triggered = (advance.policy_results || []).filter((item) => item.status === 'triggered');
    row('Triggered policies', triggered.length
      ? triggered.map((item) => item.policy_id).join(', ') : 'None in the resolved articles');
  }

  addPage('Evidence and coverage');
  section(String(5 + sectionOffset).padStart(2, '0'), 'Coverage and sources');
  paragraph('This section records the selected search sources. It is separate from the profile assessment and the cited evidence.', {
    size: 9, color: COLOR.muted, gap: 10 });
  for (const source of response.coverage?.sources || []) {
    const label = ({ current_news: 'Current news', open_web: 'Open web', publisher_search: 'Search+',
      archive: 'kycProbe Entity Map', official_records: 'Official records' })[source.source] || title(source.source);
    row(label, source.status === 'complete' ? 'Searched' : source.status === 'not_requested' ? 'Not selected' : 'Needs attention');
  }
  row('Archive source', 'kycProbe Entity Map');
  if (response.coverage?.archive_snapshot) row('Entity Map period', `${timestamp(response.coverage.archive_snapshot.coverage_start)} to ${timestamp(response.coverage.archive_snapshot.coverage_end)}`);
  row('Languages', (response.coverage?.languages_searched || []).map((item) => item.name || item.code).join(', ') || 'Not recorded');
  if (response.coverage?.search_plus?.requested) row('Search+', `${response.coverage.search_plus.publishers_screened?.length || 0} additional publishers searched`);
  if (response.coverage?.complete !== true) callout('One or more selected sources need attention. The profile remains Inconclusive unless confirmed direct adverse evidence establishes Unsafe.', {
    fill: COLOR.paleAmber, accent: COLOR.amber });
  section(String(6 + sectionOffset).padStart(2, '0'), 'Evidence register');
  paragraph('Every displayed article is grouped by media bucket. Check its publisher, date, relationship to the subject and source before acting on it.', {
    size: 8.8, color: COLOR.muted, gap: 9 });
  const nonEmptyGroups = groups.filter(([, results]) => results.length);
  if (!nonEmptyGroups.length) callout('No media article was returned by the selected searches.', { fill: COLOR.pale, accent: COLOR.teal });
  let evidenceIndex = 0;
  for (const [group, results] of nonEmptyGroups) {
    ensure(125, 'Evidence register');
    section(`${results.length} item${results.length === 1 ? '' : 's'}`, group);
    for (const result of results) finding(result, evidenceIndex++, group);
  }
  ensure(170, 'Report record');
  section(String(7 + sectionOffset).padStart(2, '0'), 'Report record');
  row('Screening ID', response.screening_id || 'Unavailable');
  row('Report ID', reportId);
  row('Screened', timestamp(response.completed_at));
  row('Report generated', timestamp(generated));
  paragraph('The profile reflects the sources and articles shown in this report. It is not a finding of guilt or a guarantee that every published article was indexed.', {
    size: 8.4, color: COLOR.muted, gap: 5 });

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
  pdf.setTitle(`${variant === 'advance' ? 'Adverse Media Advance' : 'Adverse Media Profile'} - ${entityName}`);
  pdf.setAuthor('KYCProbe by AI7Lab UAE');
  pdf.setSubject(`Transaction ${response.screening_id}`);
  pdf.setCreationDate(new Date(generated));
  const bytes = Buffer.from(await pdf.save());
  return { bytes, reportId, sha256: digest(bytes), generatedAt: generated, filename: filename(entityName, generated, variant) };
}
