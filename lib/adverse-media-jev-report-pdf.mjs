import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFString, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import sharp from 'sharp';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { SUBFILTER_ADOBE_PKCS7_DETACHED } from '@signpdf/utils';
import 'regenerator-runtime/runtime.js';

const PAGE = { width: 595.28, height: 841.89, margin: 46, bottom: 57 };
const WIDTH = PAGE.width - 2 * PAGE.margin;
const BRAND_LOGO = readFileSync(new URL('../api-site/assets/kycprobe-logo-white.png', import.meta.url));
const C = {
  navy: rgb(0.04, 0.11, 0.21), blue: rgb(0.10, 0.24, 0.44),
  teal: rgb(0.04, 0.43, 0.40), red: rgb(0.63, 0.20, 0.22),
  amber: rgb(0.56, 0.37, 0.08), ink: rgb(0.13, 0.20, 0.28),
  muted: rgb(0.38, 0.45, 0.52), line: rgb(0.84, 0.88, 0.91),
  pale: rgb(0.96, 0.97, 0.98), paleTeal: rgb(0.91, 0.97, 0.96),
  paleAmber: rgb(1, 0.97, 0.90), white: rgb(1, 1, 1)
};
const ADVERSE = new Set(['adverse', 'non-adverse', 'inconclusive']);
const RELATIONSHIP = new Set(['direct', 'indirect', 'inconclusive']);

function clean(value, max = 2_048) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ')
    .replace(/[\u2010-\u2015]/g, '-').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
function display(value) { return clean(value).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function date(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'
  }).format(parsed) : clean(value, 60) || 'Date unavailable';
}
function slug(value) { return clean(value, 100).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'subject'; }

// The report must never infer an incident from a headline or silently place a
// retained article in a group absent from the finalized Jev JSON.
export function jevIncidentReportModel(response) {
  if (!['advance-jev-integrated-test-v1', 'adverse-media-incident-report-v1'].includes(response?.contract)
    || !Array.isArray(response.event_register?.articles)
    || !Array.isArray(response.event_register?.incidents)) throw new Error('invalid_jev_report_json');
  const subject = clean(response.subject?.name, 200);
  if (!subject) throw new Error('invalid_jev_report_json');
  const articles = response.event_register.articles;
  const byKey = new Map();
  for (const article of articles) {
    if (!article || !article.story_key || byKey.has(article.story_key)
      || !ADVERSE.has(article.adverseness) || !RELATIONSHIP.has(article.relationship))
      throw new Error('invalid_jev_report_json');
    byKey.set(article.story_key, article);
  }
  const used = new Set();
  const groups = response.event_register.incidents.map((incident, index) => {
    if (!incident?.incident_id || !Array.isArray(incident.story_keys)
      || !incident.story_keys.length || new Set(incident.story_keys).size !== incident.story_keys.length)
      throw new Error('invalid_jev_report_json');
    const members = incident.story_keys.map((key) => {
      const article = byKey.get(key);
      if (!article || article.incident_id !== incident.incident_id || used.has(key))
        throw new Error('invalid_jev_report_json');
      used.add(key);
      return article;
    });
    return { id: incident.incident_id, label: `Incident ${index + 1}`,
      articles: members, adverse: members.filter((item) => item.adverseness === 'adverse').length,
      headline: clean(members[0].title || 'Untitled article', 240) };
  });
  const unassigned = articles.filter((article) => {
    if (used.has(article.story_key)) return false;
    if (article.incident_id !== null && article.incident_id !== undefined)
      throw new Error('invalid_jev_report_json');
    return true;
  });
  const count = (field, state) => articles.filter((article) => article[field] === state).length;
  const bodyCount = articles.filter((article) =>
    ['event_registry_body', 'article_body'].includes(article.evidence_grade)).length;
  const excerptCount = count('evidence_grade', 'search_excerpt');
  return { subject, period: response.period || {}, groups, unassigned,
    articles, redundant: Number(response.coverage?.redundant_removed
      ?? (Array.isArray(response.redundant) ? response.redundant.length : 0)),
    coverage: response.coverage || {}, policyStatus: response.policy_evaluation_status || 'not_run',
    counts: {
      adverse: count('adverseness', 'adverse'),
      nonAdverse: count('adverseness', 'non-adverse'),
      adverseInconclusive: count('adverseness', 'inconclusive'),
      direct: count('relationship', 'direct'),
      indirect: count('relationship', 'indirect'),
      relationshipInconclusive: count('relationship', 'inconclusive'),
      body: bodyCount, excerpt: excerptCount,
      otherEvidence: articles.length - bodyCount - excerptCount
    } };
}

export async function createJevIncidentPdf({ response, narrative = null, signing,
  generatedAt = new Date().toISOString() }) {
  if (!signing?.p12Bytes || typeof signing.passphrase !== 'string')
    throw new Error('pdf_signing_certificate_required');
  const model = jevIncidentReportModel(response);
  if (response.screening_result === 'Safe' && model.articles.length === 0)
    return createJevSafePdf({ response, signing, generatedAt });
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const brandLogo = await pdf.embedPng(BRAND_LOGO);
  const corpus = JSON.stringify({ response, narrative });
  const unicode = {};
  for (const [name, pattern, file] of [
    ['cjk', /[\u3400-\u9fff\uf900-\ufaff]/u, 'NotoSansCJKsc-Regular.otf'],
    ['devanagari', /[\u0900-\u097f]/u, 'NotoSansDevanagari.ttf'],
    ['telugu', /[\u0c00-\u0c7f]/u, 'NotoSansTelugu.ttf'],
    ['arabic', /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u, 'NotoSansArabic.ttf'],
    ['other', /[^\x00-\x7f]/u, 'NotoSans.ttf']
  ]) if (pattern.test(corpus)) unicode[name] = await pdf.embedFont(
    readFileSync(new URL(`./fonts/${file}`, import.meta.url)),
    { subset: name === 'devanagari' || name === 'telugu' || name === 'arabic' });
  const fontFor = (value, fallback) => {
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(value) && unicode.cjk) return unicode.cjk;
    if (/[\u0900-\u097f]/u.test(value) && unicode.devanagari) return unicode.devanagari;
    if (/[\u0c00-\u0c7f]/u.test(value) && unicode.telugu) return unicode.telugu;
    if (/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(value) && unicode.arabic) return unicode.arabic;
    return /[^\x00-\x7f]/u.test(value) && unicode.other ? unicode.other : fallback;
  };
  function fontRuns(value, fallback) {
    const out = [];
    for (const character of String(value)) {
      const font = fontFor(character, fallback);
      const previous = out.at(-1);
      if (previous?.font === font) previous.value += character;
      else out.push({ font, value: character });
    }
    return out;
  }
  function textWidth(value, size, fallback) {
    return fontRuns(value, fallback).reduce((sum, run) =>
      sum + run.font.widthOfTextAtSize(run.value, size), 0);
  }
  function sourceLink(value, x, bottom, width, height) {
    let target;
    try { target = new URL(value); } catch { return; }
    if (!['https:', 'http:'].includes(target.protocol)) return;
    const annotation = pdf.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [x, bottom, x + width, bottom + height],
      Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(target.href) }
    });
    page.node.addAnnot(pdf.context.register(annotation));
  }
  const pages = [];
  let page;
  let y;
  let continuation = 'INCIDENT REGISTER';
  function text(value, x, baseline, size, color = C.ink, weight = regular) {
    const content = clean(value);
    let at = x;
    for (const run of fontRuns(content, weight)) {
      page.drawText(run.value, { x: at, y: baseline, size, font: run.font, color });
      at += run.font.widthOfTextAtSize(run.value, size);
    }
  }
  function lines(value, size, width, weight = regular) {
    const content = clean(value, 4_000);
    const out = [];
    let line = '';
    for (const word of content.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, weight) <= width) { line = candidate; continue; }
      if (line) out.push(line);
      line = '';
      for (const character of word) {
        if (line && textWidth(line + character, size, weight) > width) {
          out.push(line); line = character;
        } else line += character;
      }
    }
    if (line) out.push(line);
    return out;
  }
  function addPage(label) {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    pages.push(page);
    page.drawRectangle({ x: 0, y: PAGE.height - 68, width: PAGE.width, height: 68, color: C.navy });
    page.drawRectangle({ x: 0, y: PAGE.height - 71, width: PAGE.width, height: 3, color: C.teal });
    const scaledLogo = brandLogo.scaleToFit(124, 48);
    page.drawImage(brandLogo, { x: PAGE.margin, y: PAGE.height - 59,
      width: scaledLogo.width, height: scaledLogo.height });
    text(label.toUpperCase().slice(0, 42), PAGE.width - PAGE.margin - 213,
      PAGE.height - 37, 8, C.white, bold);
    y = PAGE.height - 103;
  }
  function ensure(height) { if (y - height < PAGE.bottom) addPage(continuation); }
  function paragraph(value, { size = 9, width = WIDTH, x = PAGE.margin,
    color = C.ink, weight = regular, gap = 8, lineHeight = size * 1.42 } = {}) {
    for (const line of lines(value, size, width, weight)) {
      ensure(lineHeight + 3);
      text(line, x, y, size, color, weight);
      y -= lineHeight;
    }
    y -= gap;
  }
  function heading(kicker, title) {
    ensure(65);
    text(kicker.toUpperCase(), PAGE.margin, y, 8, C.teal, bold);
    y -= 24;
    paragraph(title, { size: 18, color: C.navy, weight: bold, lineHeight: 22, gap: 5 });
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.width - PAGE.margin, y }, color: C.line });
    y -= 16;
  }
  function infoBar(value, accent = C.teal) {
    const wrapped = lines(value, 9.3, WIDTH - 28);
    const height = Math.max(41, wrapped.length * 14 + 17);
    ensure(height + 10);
    page.drawRectangle({ x: PAGE.margin, y: y - height + 5, width: WIDTH, height, color: C.pale });
    page.drawRectangle({ x: PAGE.margin, y: y - height + 5, width: 3, height, color: accent });
    wrapped.forEach((line, index) => text(line, PAGE.margin + 14, y - 14 - index * 14, 9.3, C.ink));
    y -= height + 10;
  }
  function metric(x, label, value, color) {
    page.drawRectangle({ x, y: y - 64, width: (WIDTH - 18) / 4, height: 64, color: C.pale });
    page.drawRectangle({ x, y: y - 64, width: 3, height: 64, color });
    text(label.toUpperCase(), x + 12, y - 19, 7.2, C.muted, bold);
    text(value, x + 12, y - 47, 19, color, bold);
  }
  function stackedMetric(label, items, total) {
    ensure(64);
    text(label.toUpperCase(), PAGE.margin, y, 8.3, C.navy, bold);
    text(`${total} ARTICLES`, PAGE.width - PAGE.margin - 75, y, 7.5, C.muted, bold);
    y -= 16;
    page.drawRectangle({ x: PAGE.margin, y: y - 11, width: WIDTH, height: 11, color: C.line });
    let left = PAGE.margin;
    for (const item of items) {
      const width = total ? WIDTH * item.count / total : 0;
      if (width > 0) page.drawRectangle({ x: left, y: y - 11, width, height: 11, color: item.color });
      left += width;
    }
    y -= 26;
    let legendX = PAGE.margin;
    for (const item of items) {
      page.drawRectangle({ x: legendX, y: y + 2, width: 7, height: 7, color: item.color });
      text(`${item.label} ${item.count}`, legendX + 12, y + 2, 7.7, C.ink);
      legendX += Math.max(96, textWidth(`${item.label} ${item.count}`, 7.7, regular) + 28);
    }
    y -= 19;
  }
  function incidentBucket(group, index, x, top, width, height) {
    const compact = width < 300;
    const nonAdverse = group.articles.filter((item) => item.adverseness === 'non-adverse').length;
    const inconclusive = group.articles.length - group.adverse - nonAdverse;
    page.drawRectangle({ x, y: top - height, width, height, color: C.pale });
    page.drawRectangle({ x, y: top - height, width: 4, height, color: C.teal });
    if (height < 92 || width < 150) {
      const tiny = height < 44;
      text(`${tiny ? 'INC' : 'INCIDENT'} ${String(index + 1).padStart(2, '0')}`,
        x + 9, top - (tiny ? 13 : 15), tiny ? 6.7 : 7.3, C.teal, bold);
      const count = `${group.articles.length} ARTICLE${group.articles.length === 1 ? '' : 'S'}`;
      text(count, x + width - 8 - textWidth(count, tiny ? 6.2 : 6.6, bold),
        top - (tiny ? 13 : 15), tiny ? 6.2 : 6.6, C.navy, bold);
      if (height >= 68 && width >= 150) {
        const fullTitle = clean(group.headline, 160);
        let shortTitle = fullTitle;
        while (shortTitle && textWidth(`${shortTitle}${shortTitle.length < fullTitle.length ? '...' : ''}`,
          7.2, regular) > width - 18) shortTitle = shortTitle.slice(0, -1);
        text(`${shortTitle}${shortTitle.length < fullTitle.length ? '...' : ''}`,
          x + 9, top - 34, 7.2, C.ink);
      }
      if (!tiny) text(`${group.adverse} adverse`, x + 9, top - height + 15, 6.7, C.muted);
      page.drawRectangle({ x: x + 9, y: top - height + 5, width: width - 18,
        height: tiny ? 3 : 5, color: C.line });
      if (group.adverse) page.drawRectangle({ x: x + 9, y: top - height + 5,
        width: (width - 18) * group.adverse / group.articles.length,
        height: tiny ? 3 : 5, color: C.red });
      return;
    }
    text(`INCIDENT ${String(index + 1).padStart(2, '0')}`, x + 13, top - 17,
      compact ? 8.2 : 9.2, C.teal, bold);
    const countLabel = `${group.articles.length} ARTICLE${group.articles.length === 1 ? '' : 'S'}`;
    text(countLabel, x + width - 13 - textWidth(countLabel, 8.1, bold), top - 17,
      8.1, C.navy, bold);
    const titleSize = compact ? 8.7 : 9.7;
    const fullTitleLines = lines(group.headline, titleSize, width - 27);
    const titleLines = fullTitleLines.slice(0, compact ? 2 : 3);
    if (fullTitleLines.length > titleLines.length) {
      let clipped = titleLines.at(-1);
      while (textWidth(`${clipped}...`, titleSize, regular) > width - 27) clipped = clipped.slice(0, -1);
      titleLines[titleLines.length - 1] = `${clipped}...`;
    }
    titleLines.forEach((line, lineIndex) => text(line, x + 13, top - 36 - lineIndex * 12,
      titleSize, C.ink, lineIndex === 0 ? bold : regular));
    text(`${group.adverse} adverse  |  ${nonAdverse} non-adverse  |  ${inconclusive} inconclusive`,
      x + 13, top - height + 25, compact ? 7.2 : 8, C.muted);
    let left = x + 13;
    const railWidth = width - 26;
    page.drawRectangle({ x: left, y: top - height + 11, width: railWidth, height: 7, color: C.line });
    for (const [count, color] of [[group.adverse, C.red], [nonAdverse, C.teal], [inconclusive, C.amber]]) {
      const portion = railWidth * count / group.articles.length;
      if (portion > 0) page.drawRectangle({ x: left, y: top - height + 11,
        width: portion, height: 7, color });
      left += portion;
    }
  }
  function groupSizeRow(group, index, maximum) {
    ensure(35);
    text(`INCIDENT ${String(index + 1).padStart(2, '0')}`, PAGE.margin, y, 8.2, C.navy, bold);
    const countLabel = `${group.articles.length} ARTICLE${group.articles.length === 1 ? '' : 'S'}`;
    text(countLabel, PAGE.width - PAGE.margin - 75, y, 8, C.muted, bold);
    y -= 13;
    const width = WIDTH;
    page.drawRectangle({ x: PAGE.margin, y: y - 7, width, height: 7, color: C.line });
    page.drawRectangle({ x: PAGE.margin, y: y - 7,
      width: width * group.articles.length / maximum, height: 7, color: C.teal });
    y -= 22;
  }
  function groupSnapshot(group) {
    const dated = group.articles.map((article) => new Date(article.published_at))
      .filter((value) => Number.isFinite(value.getTime())).sort((a, b) => a - b);
    const dateSpan = dated.length ? dated[0].getTime() === dated.at(-1).getTime()
      ? date(dated[0]) : `${date(dated[0])} to ${date(dated.at(-1))}` : 'Dates unavailable';
    const publishers = new Set(group.articles.map((article) => clean(article.publisher, 100)).filter(Boolean)).size;
    const body = group.articles.filter((article) =>
      ['event_registry_body', 'article_body'].includes(article.evidence_grade)).length;
    ensure(86);
    const cellWidth = (WIDTH - 18) / 4;
    for (const [index, label, value, color] of [
      [0, 'Articles', String(group.articles.length), C.blue],
      [1, 'Adverse', String(group.adverse), C.red],
      [2, 'Publishers', String(publishers), C.teal],
      [3, 'Body available', String(body), C.amber]
    ]) {
      const x = PAGE.margin + index * (cellWidth + 6);
      page.drawRectangle({ x, y: y - 53, width: cellWidth, height: 53, color: C.pale });
      page.drawRectangle({ x, y: y - 53, width: 3, height: 53, color });
      text(label.toUpperCase(), x + 10, y - 16, 7, C.muted, bold);
      text(value, x + 10, y - 40, 16, color, bold);
    }
    y -= 62;
    paragraph(`Publication dates: ${dateSpan}`, { size: 8.4, color: C.muted, gap: 2 });
  }
  function guidePair(left, right) {
    const gap = 10;
    const width = (WIDTH - gap) / 2;
    const entries = [left, right].map((item) => ({ ...item,
      detailLines: lines(item.detail, 9, width - 28) }));
    const height = Math.max(69, ...entries.map((item) => 34 + item.detailLines.length * 12.5));
    ensure(height + 10);
    entries.forEach((item, index) => {
      const x = PAGE.margin + index * (width + gap);
      page.drawRectangle({ x, y: y - height, width, height, color: C.pale });
      page.drawRectangle({ x, y: y - height, width: 3, height, color: item.color });
      text(item.label.toUpperCase(), x + 13, y - 18, 8.7, item.color, bold);
      item.detailLines.forEach((line, lineIndex) => text(line, x + 13,
        y - 36 - lineIndex * 12.5, 9, C.ink));
    });
    y -= height + 10;
  }
  function articleCard(article, index) {
    const articleTitle = clean(article.title || 'Untitled article', 220);
    const titleLines = lines(articleTitle, 10.4, WIDTH - 32, bold);
    const excerptLines = lines(article.excerpt || '', 8.8, WIDTH - 32).slice(0, 2);
    const reasonLines = article.incident_reason
      ? lines(`Grouping status: ${display(article.incident_reason)}`, 8, WIDTH - 32).slice(0, 1) : [];
    const urlLines = lines(article.url || 'Source URL unavailable', 7, WIDTH - 32).slice(0, 2);
    const height = 67 + titleLines.length * 14 + excerptLines.length * 11.5
      + reasonLines.length * 10 + urlLines.length * 9.5;
    ensure(height + 8);
    page.drawRectangle({ x: PAGE.margin, y: y - height, width: WIDTH, height, color: C.pale });
    page.drawRectangle({ x: PAGE.margin, y: y - height, width: 3, height,
      color: article.adverseness === 'adverse' ? C.red : article.adverseness === 'inconclusive' ? C.amber : C.teal });
    let at = y - 17;
    const evidence = ['event_registry_body', 'article_body'].includes(article.evidence_grade) ? 'Article body'
      : article.evidence_grade === 'search_excerpt' ? 'Search excerpt' : 'Evidence unspecified';
    text(`ARTICLE ${String(index + 1).padStart(2, '0')}  |  ${display(article.adverseness)}  |  ${display(article.relationship)}  |  ${evidence}`,
      PAGE.margin + 14, at, 7.9, article.adverseness === 'adverse' ? C.red : C.teal, bold);
    at -= 20;
    titleLines.forEach((line) => { text(line, PAGE.margin + 14, at, 10.4, C.navy, bold); at -= 14; });
    at -= 3;
    text(`${clean(article.publisher || 'Publisher unavailable', 70)}  |  ${date(article.published_at)}`,
      PAGE.margin + 14, at, 8, C.muted);
    at -= 15;
    if (excerptLines.length) {
      excerptLines.forEach((line) => { text(line, PAGE.margin + 14, at, 8.8, C.ink); at -= 11.5; });
      at -= 3;
    }
    reasonLines.forEach((line) => { text(line, PAGE.margin + 14, at, 8, C.amber); at -= 10; });
    const linkTop = at + 8;
    urlLines.forEach((line) => { text(line, PAGE.margin + 14, at, 7, C.blue); at -= 9.5; });
    if (urlLines.length) sourceLink(article.url, PAGE.margin + 14,
      at + 7, WIDTH - 28, linkTop - at - 7);
    y -= height + 8;
  }

  addPage('Adverse media - incidents');
  text('ADVERSE MEDIA INCIDENT REGISTER', PAGE.margin, y, 8.5, C.teal, bold);
  y -= 33;
  paragraph(model.subject, { size: 23, weight: bold, color: C.navy, lineHeight: 27, gap: 5 });
  paragraph(`${model.period.from || 'Start unavailable'} to ${model.period.to || 'End unavailable'}  |  Generated ${date(generatedAt)}`,
    { size: 9, color: C.muted, gap: 19 });
  heading('01 / Case overview', 'Incident groups at a glance');
  ensure(86);
  const cardWidth = (WIDTH - 18) / 4;
  metric(PAGE.margin, 'Incidents', String(model.groups.length), C.blue);
  metric(PAGE.margin + cardWidth + 6, 'Articles', String(model.articles.length), C.teal);
  metric(PAGE.margin + 2 * (cardWidth + 6), 'Adverse', String(model.counts.adverse), C.red);
  metric(PAGE.margin + 3 * (cardWidth + 6), 'Unassigned', String(model.unassigned.length), C.amber);
  y -= 78;
  if (narrative?.summary) infoBar(clean(narrative.summary, 850), C.blue);
  else infoBar('A narrative summary was not supplied. The article labels and incident assignments below come from the finalized screening JSON.', C.amber);
  if (model.coverage.source_coverage_status === 'incomplete')
    infoBar('Source coverage is incomplete in this QA run. Do not interpret the absence of an incident as a clean screen.', C.amber);
  paragraph('INCIDENT BUCKETS', { size: 8, weight: bold, color: C.teal, gap: 4 });
  if (model.groups.length) paragraph(model.groups.length > 12
    ? 'Every incident is listed below; headlines and source details appear in the incident sections.'
    : 'Each bucket groups one reported matter. The headline is an example article, not an incident title.',
  { size: 8.4, color: C.muted, gap: 13 });
  if (!model.groups.length) infoBar('No specific incident group was established from the retained articles.', C.amber);
  const columns = model.groups.length <= 3 ? 1 : model.groups.length <= 6 ? 2
    : model.groups.length <= 18 ? 3 : 4;
  const bucketGap = columns < 3 ? 9 : 6;
  const bucketWidth = (WIDTH - bucketGap * (columns - 1)) / columns;
  const bucketRows = Math.ceil(model.groups.length / columns);
  const availableBucketHeight = y - PAGE.bottom - 18;
  const bucketHeight = Math.min(columns === 1 ? 111 : 99,
    Math.floor((availableBucketHeight - (bucketRows - 1) * bucketGap) / bucketRows));
  for (let index = 0; index < model.groups.length; index += columns) {
    const row = model.groups.slice(index, index + columns);
    row.forEach((group, offset) => incidentBucket(group, index + offset,
      PAGE.margin + offset * (bucketWidth + bucketGap), y, bucketWidth, bucketHeight));
    y -= bucketHeight + bucketGap;
  }
  if (model.unassigned.length) paragraph(`${model.unassigned.length} unassigned article${model.unassigned.length === 1 ? ' appears' : 's appear'} in the review section.`,
    { size: 8.3, color: C.amber, gap: 0 });

  continuation = 'Screening breakdown';
  addPage('Screening breakdown');
  heading('02 / Screening breakdown', 'What the screening found');
  paragraph('The bars below count retained articles in the finalized event register. They show screening labels and the evidence available for review.',
    { size: 9.4, lineHeight: 13.5, gap: 15 });
  stackedMetric('Adverseness classification', [
    { label: 'Adverse', count: model.counts.adverse, color: C.red },
    { label: 'Non-adverse', count: model.counts.nonAdverse, color: C.teal },
    { label: 'Inconclusive', count: model.counts.adverseInconclusive, color: C.amber }
  ], model.articles.length);
  stackedMetric('Subject relationship', [
    { label: 'Direct', count: model.counts.direct, color: C.blue },
    { label: 'Indirect', count: model.counts.indirect, color: C.teal },
    { label: 'Inconclusive', count: model.counts.relationshipInconclusive, color: C.amber }
  ], model.articles.length);
  stackedMetric('Evidence available for screening', [
    { label: 'Article body', count: model.counts.body, color: C.teal },
    { label: 'Search excerpt', count: model.counts.excerpt, color: C.amber },
    { label: 'Other / unknown', count: model.counts.otherEvidence, color: C.muted }
  ], model.articles.length);
  paragraph('A search excerpt gives less context than an extracted article body. Labels remain screening results, not verified findings.',
    { size: 8.5, color: C.muted, gap: 14 });
  heading('02 / Distribution', 'Media mentions by incident');
  const maximumGroupSize = Math.max(1, ...model.groups.map((group) => group.articles.length));
  model.groups.forEach((group, index) => groupSizeRow(group, index, maximumGroupSize));
  if (!model.groups.length) paragraph('No incident groups established.', { size: 9, color: C.muted });
  infoBar(`Unassigned: ${model.unassigned.length}. Policy evaluation: ${display(model.policyStatus)}. Redundant removed: ${model.redundant}. Omitted by test limit: ${Number(model.coverage.omitted_due_to_test_limit || 0)}.`, C.amber);

  continuation = 'How to read this report';
  addPage('Reading guide');
  heading('03 / Reading guide', 'How to read this report');
  paragraph('The register groups retained public media by reported matter. Article labels describe screening relevance and the apparent connection to the named subject. They are not findings of fact.',
    { size: 10, lineHeight: 14.5, color: C.ink, gap: 15 });
  paragraph('ARTICLE LABELS', { size: 8, weight: bold, color: C.teal, gap: 6 });
  guidePair(
    { label: 'Adverse', color: C.red, detail: 'The article describes a potentially adverse issue or allegation. This does not establish wrongdoing.' },
    { label: 'Direct', color: C.blue, detail: 'The subject is directly described in the matter, including as an affected party. This does not imply fault.' });
  guidePair(
    { label: 'Non-adverse', color: C.teal, detail: 'The article mentions the subject without a qualifying adverse issue.' },
    { label: 'Indirect', color: C.blue, detail: 'The connection is through another person or entity and needs contextual review.' });
  guidePair(
    { label: 'Inconclusive', color: C.amber, detail: 'The available evidence is insufficient or conflicting for an adverseness decision.' },
    { label: 'Relationship inconclusive', color: C.amber, detail: 'The available evidence does not establish the subject connection reliably.' });
  paragraph('INCIDENTS AND COVERAGE', { size: 8, weight: bold, color: C.teal, gap: 5 });
  infoBar('Articles in one incident group refer to the same reported matter. A group is not a count of proven acts. Unassigned articles remain outside all groups; redundant articles have been removed from the register.', C.teal);
  paragraph('EVIDENCE DEPTH', { size: 8, weight: bold, color: C.teal, gap: 5 });
  infoBar('Article body means extracted text was available for screening. Search excerpt means the review used limited search-result text and metadata. Check the original publication before relying on a label.', C.teal);
  paragraph('IMPORTANT DISCLAIMER', { size: 8, weight: bold, color: C.amber, gap: 5 });
  infoBar('This screening report is based on publicly available information about the named subject. It does not confirm the truth of any allegation, establish that every mention concerns the same person, or assign blame or wrongdoing to the subject. A reviewer should verify the sources and identity before making a decision.', C.amber);
  paragraph('DIGITAL SIGNATURE', { size: 8, weight: bold, color: C.teal, gap: 5 });
  infoBar('This PDF carries a cryptographic signature. Check the signature panel in your PDF viewer for document integrity and certificate trust. A valid signature does not verify the underlying media claims.', C.teal);

  model.groups.forEach((group, groupIndex) => {
    continuation = 'Incident details';
    if (groupIndex === 0 || y < 300) addPage('Incident details');
    else y -= 17;
    heading(`${String(groupIndex + 4).padStart(2, '0')} / Incident details`, group.label);
    groupSnapshot(group);
    paragraph(`Example headline: ${group.headline}`, { size: 8.8, color: C.ink, gap: 3 });
    paragraph(`Incident reference: ${group.id}`, { size: 7.9, color: C.muted, gap: 13 });
    group.articles.forEach(articleCard);
  });
  if (model.unassigned.length) {
    continuation = 'Unassigned articles continued';
    addPage('Articles awaiting grouping');
    heading(`${String(model.groups.length + 4).padStart(2, '0')} / Review queue`, 'Articles without an incident');
    paragraph('These retained articles have not been assigned to an incident. An unassigned article is not a new incident by itself.',
      { size: 9, color: C.muted, gap: 15 });
    model.unassigned.forEach(articleCard);
  }
  pages.forEach((item, index) => {
    item.drawLine({ start: { x: PAGE.margin, y: 43 }, end: { x: PAGE.width - PAGE.margin, y: 43 }, color: C.line });
    item.drawText('KYCProbe  |  Public-source screening  |  Not a finding of wrongdoing',
      { x: PAGE.margin, y: 26, size: 7, font: regular, color: C.muted });
    item.drawText(`${index + 1} / ${pages.length}`, { x: PAGE.width - PAGE.margin - 31, y: 26,
      size: 7.5, font: bold, color: C.muted });
  });
  pdf.setTitle(`Adverse Media Incident Register - ${model.subject}`);
  pdf.setAuthor('KYCProbe');
  pdf.setCreator('KYCProbe');
  pdf.setProducer('KYCProbe');
  pdf.setCreationDate(new Date(generatedAt));
  const signingTime = new Date();
  pdflibAddPlaceholder({ pdfDoc: pdf, reason: 'Integrity of KYCProbe adverse-media screening report',
    name: signing.name || 'KYCProbe report signer', contactInfo: signing.contactInfo || '',
    location: signing.location || '', signingTime, signatureLength: 16_384,
    subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED, appName: 'KYCProbe' });
  const placeholderPdf = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const signer = new P12Signer(signing.p12Bytes, { passphrase: signing.passphrase });
  const bytes = Buffer.from(await new SignPdf().sign(placeholderPdf, signer, signingTime));
  return { bytes, filename: `kycprobe-adverse-media-incidents-${slug(model.subject)}.pdf`,
    sha256: createHash('sha256').update(bytes).digest('hex'), pageCount: pages.length,
    incidentCount: model.groups.length, digitallySigned: true };
}

async function createJevSafePdf({ response, signing, generatedAt }) {
  const model = jevIncidentReportModel(response);
  const incomplete = response.coverage?.source_coverage_status === 'incomplete';
  if (response.screening_result !== 'Safe')
    throw new Error('invalid_no_media_coverage_decision');
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await pdf.embedPng(BRAND_LOGO);
  const variants = response.search_names?.transliterations || {};
  const names = [
    ['Primary name', response.search_names?.primary || model.subject],
    ...(response.search_names?.aliases || []).map((value) => ['Alias searched', value]),
    ...(variants.ar || []).map((value) => ['Arabic searched', value, 'ar']),
    ...(variants.hi || []).map((value) => ['Hindi searched', value, 'hi'])
  ];
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const draw = (value, x, y, size = 10, font = regular, color = C.ink) =>
    page.drawText(clean(value, 300), { x, y, size, font, color });
  const scriptFor = (value) => /[\u0600-\u06ff]/u.test(value) ? 'ar'
    : /[\u0900-\u097f]/u.test(value) ? 'hi'
      : /[^\x00-\x7f]/u.test(value) ? 'other' : null;
  const escapeXml = (value) => String(value).replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const drawScript = async (value, language, x, baseline, width = WIDTH - 139,
    height = 18, requestedFontSize = 22) => {
    const file = language === 'ar' ? 'NotoSansArabic.ttf'
      : language === 'hi' ? 'NotoSansDevanagari.ttf' : 'NotoSans.ttf';
    const font = readFileSync(new URL(`./fonts/${file}`, import.meta.url)).toString('base64');
    const fontSize = Math.max(14, Math.min(requestedFontSize,
      width * 2.4 / [...value].length));
    const pixelWidth = Math.round(width * 2);
    const pixelHeight = Math.round(height * 2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}"><style>@font-face{font-family:'ScreenName';src:url(data:font/ttf;base64,${font})}</style><text x="0" y="${Math.round(pixelHeight * 0.75)}" font-size="${fontSize}" font-family="ScreenName" fill="#223344">${escapeXml(value)}</text></svg>`;
    const png = await pdf.embedPng(await sharp(Buffer.from(svg)).png().toBuffer());
    page.drawImage(png, { x, y: baseline - 5, width, height });
  };
  const wrap = (value, font, size, width) => {
    const output = [];
    let line = '';
    for (const word of clean(value, 200).split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) output.push(line);
      line = word;
    }
    if (line) output.push(line);
    return output;
  };
  page.drawRectangle({ x: 0, y: PAGE.height - 79, width: PAGE.width, height: 79, color: C.navy });
  page.drawRectangle({ x: 0, y: PAGE.height - 82, width: PAGE.width, height: 3, color: C.teal });
  const scaled = logo.scaleToFit(133, 53);
  page.drawImage(logo, { x: PAGE.margin, y: PAGE.height - 65,
    width: scaled.width, height: scaled.height });
  draw('PUBLIC-SOURCE SCREENING', 382, PAGE.height - 46, 8, bold, C.white);
  draw('ADVERSE MEDIA SCREENING', PAGE.margin, 718, 9, bold, C.teal);
  if (scriptFor(model.subject)) await drawScript(model.subject, scriptFor(model.subject),
    PAGE.margin, 675, WIDTH, 34, 43);
  else {
    let subjectSize = 22;
    while (bold.widthOfTextAtSize(model.subject, subjectSize) > WIDTH && subjectSize > 11)
      subjectSize -= 1;
    draw(model.subject, PAGE.margin, 682, subjectSize, bold, C.navy);
  }
  draw(`${model.period.from || 'Start unavailable'} to ${model.period.to || 'End unavailable'}  |  Generated ${date(generatedAt)}`,
    PAGE.margin, 659, 9, regular, C.muted);
  page.drawRectangle({ x: PAGE.margin, y: 559, width: WIDTH, height: 82,
    color: C.paleTeal });
  page.drawRectangle({ x: PAGE.margin, y: 559, width: 5, height: 82,
    color: C.teal });
  draw('SAFE', PAGE.margin + 18, 608, 19, bold, C.teal);
  draw('No public adverse media evidence found', PAGE.margin + 18, 586, 11, bold, C.navy);
  draw(incomplete ? 'in searched sources; the archived media index was unavailable.'
    : 'in the sources searched during the stated period.', PAGE.margin + 18, 570, 9.6);
  draw('NAMES SEARCHED', PAGE.margin, 530, 8, bold, C.teal);
  let y = 508;
  for (const [label, value, language] of names) {
    const script = language || scriptFor(value);
    const rows = script ? [value] : wrap(value, regular, 9.4, WIDTH - 147);
    const height = Math.max(30, 9 + rows.length * 12);
    page.drawLine({ start: { x: PAGE.margin, y: y + 6 },
      end: { x: PAGE.width - PAGE.margin, y: y + 6 }, color: C.line });
    draw(label.toUpperCase(), PAGE.margin, y - 5, 7.8, bold, C.muted);
    if (script) await drawScript(value, script, PAGE.margin + 139, y - 5);
    else rows.forEach((row, index) => draw(row, PAGE.margin + 139, y - 5 - index * 12,
      9.4, regular, C.ink));
    y -= height;
  }
  if (names.length === 1) draw('No alternate-script variants were searched.', PAGE.margin,
    y - 7, 8, regular, C.muted);
  const noteY = Math.min(405, y - 18);
  if (incomplete) {
    page.drawRectangle({ x: PAGE.margin, y: noteY - 38, width: WIDTH, height: 48,
      color: C.paleAmber });
    draw('COVERAGE LIMIT', PAGE.margin + 12, noteY - 7, 8, bold, C.amber);
    draw('The archived media index was unavailable. Safe applies only',
      PAGE.margin + 12, noteY - 21, 8.5, regular, C.ink);
    draw('to the sources searched during the stated period.', PAGE.margin + 12, noteY - 33, 8.5);
  } else {
    draw('HOW TO READ THIS RESULT', PAGE.margin, noteY, 8, bold, C.teal);
    draw('Safe means the search found no relevant public adverse media evidence.',
      PAGE.margin, noteY - 16, 8.6);
  }
  const disclaimerY = noteY - 75;
  draw('IMPORTANT DISCLAIMER', PAGE.margin, disclaimerY, 8, bold, C.amber);
  draw('This report is based on publicly available information and the names and period shown above.',
    PAGE.margin, disclaimerY - 17, 8.1);
  draw('It does not guarantee that no adverse information exists, confirm allegations, or assign',
    PAGE.margin, disclaimerY - 30, 8.1);
  draw('blame or wrongdoing. Verify identity and sources before making a decision.',
    PAGE.margin, disclaimerY - 43, 8.1);
  draw('DIGITAL SIGNATURE', PAGE.margin, disclaimerY - 67, 8, bold, C.teal);
  draw('Check your PDF viewer for document integrity and certificate trust.',
    PAGE.margin, disclaimerY - 82, 8.1);
  page.drawLine({ start: { x: PAGE.margin, y: 43 },
    end: { x: PAGE.width - PAGE.margin, y: 43 }, color: C.line });
  draw('KYCProbe  |  Public-source screening  |  Not a finding of wrongdoing',
    PAGE.margin, 26, 7, regular, C.muted);
  draw('1 / 1', PAGE.width - PAGE.margin - 26, 26, 7.5, bold, C.muted);
  pdf.setTitle(`Adverse Media Screening - ${model.subject}`);
  pdf.setAuthor('KYCProbe');
  pdf.setCreator('KYCProbe');
  pdf.setProducer('KYCProbe');
  pdf.setCreationDate(new Date(generatedAt));
  const signingTime = new Date();
  pdflibAddPlaceholder({ pdfDoc: pdf, reason: 'Integrity of KYCProbe adverse-media screening report',
    name: signing.name || 'KYCProbe report signer', contactInfo: signing.contactInfo || '',
    location: signing.location || '', signingTime, signatureLength: 16_384,
    subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED, appName: 'KYCProbe' });
  const placeholderPdf = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const signer = new P12Signer(signing.p12Bytes, { passphrase: signing.passphrase });
  const bytes = Buffer.from(await new SignPdf().sign(placeholderPdf, signer, signingTime));
  return { bytes, filename: `kycprobe-adverse-media-screening-${slug(model.subject)}.pdf`,
    sha256: createHash('sha256').update(bytes).digest('hex'), pageCount: 1,
    incidentCount: 0, digitallySigned: true };
}
