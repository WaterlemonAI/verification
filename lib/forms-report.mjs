import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PAGE = [595.28, 841.89];
const MARGIN = 48;
const COLORS = {
  ink: rgb(0.035, 0.078, 0.071),
  green: rgb(0.114, 0.435, 0.314),
  mint: rgb(0.722, 1, 0.396),
  paper: rgb(0.965, 0.976, 0.961),
  line: rgb(0.855, 0.89, 0.871),
  muted: rgb(0.39, 0.46, 0.44),
  white: rgb(1, 1, 1),
  red: rgb(0.68, 0.25, 0.18),
  amber: rgb(0.72, 0.46, 0.08)
};

function text(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');
}

function subjectSlug(value) {
  return text(value || 'submission').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'submission';
}

function wrap(font, value, size, width) {
  const paragraphs = text(value).split(/\r?\n/);
  const lines = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) { lines.push(''); continue; }
    const words = paragraph.split(/\s+/);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
      else {
        if (line) lines.push(line);
        if (font.widthOfTextAtSize(word, size) <= width) line = word;
        else {
          let part = '';
          for (const character of word) {
            if (font.widthOfTextAtSize(part + character, size) > width) { lines.push(part); part = character; }
            else part += character;
          }
          line = part;
        }
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function statusColor(status) {
  if (status === 'completed') return COLORS.green;
  if (status === 'partial') return COLORS.amber;
  return COLORS.red;
}

function summarize(result) {
  const total = result.services.length;
  const completed = result.services.filter((item) => item.transport?.completed === true).length;
  const failed = total - completed;
  if (result.summary.decision_eligible) return `All ${total} configured verification APIs completed with sufficient coverage and affirmatively qualified for the consolidated decision.`;
  if (result.status === 'completed') return `All ${total} configured API transports completed, but ${result.summary.ineligible} check(s) did not affirmatively qualify. The consolidated result is not decision-eligible and requires review.`;
  if (result.status === 'partial') return `${completed} of ${total} configured verification APIs completed and ${failed} did not. The consolidated outcome is incomplete and requires manual review.`;
  return `None of the ${total} configured verification APIs completed successfully. This submission is not decision-eligible and requires manual investigation.`;
}

export async function createFormsAuditPdf({ job, result, logoBytes, logoType }) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  pdf.setTitle(`AI7 UAE Forms - ${text(result.form.name)}`);
  pdf.setAuthor('AI7 Lab');
  pdf.setSubject('Consolidated verification audit report');
  pdf.setKeywords(['AI7', 'verification', 'forms', 'audit']);
  pdf.setCreationDate(new Date(result.completed_at));

  let page;
  let y;
  const pages = [];
  const addPage = (dark = false) => {
    page = pdf.addPage(PAGE);
    pages.push(page);
    y = PAGE[1] - MARGIN;
    page.drawRectangle({ x: 0, y: 0, width: PAGE[0], height: PAGE[1], color: dark ? COLORS.ink : COLORS.white });
    return page;
  };
  const ensure = (height, options = {}) => {
    if (y - height < 54) {
      addPage(false);
      heading('CONTINUED', options.title || result.form.name, 18);
    }
  };
  const heading = (eyebrow, title, size = 24) => {
    page.drawText(text(eyebrow).toUpperCase(), { x: MARGIN, y, size: 8, font: mono, color: COLORS.green });
    y -= 25;
    page.drawText(text(title), { x: MARGIN, y, size, font: bold, color: COLORS.ink });
    y -= size + 16;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE[0] - MARGIN, y }, thickness: 1, color: COLORS.line });
    y -= 22;
  };
  const paragraph = (value, options = {}) => {
    const size = options.size || 10;
    const lineHeight = options.lineHeight || 15;
    const font = options.font || regular;
    const color = options.color || COLORS.ink;
    const lines = wrap(font, value, size, options.width || PAGE[0] - 2 * MARGIN);
    for (const line of lines) {
      ensure(lineHeight + 4, options);
      page.drawText(line, { x: options.x || MARGIN, y, size, font, color });
      y -= lineHeight;
    }
    y -= options.after ?? 8;
  };
  const labelValue = (label, value) => {
    ensure(34);
    page.drawText(text(label).toUpperCase(), { x: MARGIN, y, size: 7, font: mono, color: COLORS.muted });
    y -= 14;
    paragraph(value === undefined || value === '' ? 'Not provided' : typeof value === 'object' ? JSON.stringify(value) : String(value), { size: 9, lineHeight: 13, after: 8 });
  };
  const section = (title) => {
    ensure(44);
    page.drawText(text(title), { x: MARGIN, y, size: 15, font: bold, color: COLORS.ink });
    y -= 13;
    page.drawRectangle({ x: MARGIN, y, width: 38, height: 3, color: COLORS.mint });
    y -= 20;
  };
  const jsonBlock = (value, title) => {
    const lines = JSON.stringify(value, null, 2).split('\n');
    for (const raw of lines) {
      const wrapped = wrap(mono, raw, 6.7, PAGE[0] - 2 * MARGIN - 20);
      for (const line of wrapped) {
        ensure(13, { title });
        page.drawRectangle({ x: MARGIN, y: y - 3, width: PAGE[0] - 2 * MARGIN, height: 12, color: COLORS.paper });
        page.drawText(line, { x: MARGIN + 10, y, size: 6.7, font: mono, color: COLORS.ink });
        y -= 11;
      }
    }
    y -= 10;
  };

  addPage(true);
  page.drawText('A7', { x: MARGIN, y: PAGE[1] - 76, size: 13, font: mono, color: COLORS.mint });
  page.drawText('AI7 UAE', { x: MARGIN + 34, y: PAGE[1] - 77, size: 14, font: bold, color: COLORS.white });
  if (logoBytes?.length) {
    try {
      const logo = logoType === 'image/png' ? await pdf.embedPng(logoBytes) : await pdf.embedJpg(logoBytes);
      const scale = Math.min(120 / logo.width, 48 / logo.height, 1);
      page.drawImage(logo, { x: PAGE[0] - MARGIN - logo.width * scale, y: PAGE[1] - 92, width: logo.width * scale, height: logo.height * scale });
    } catch { /* Invalid customer artwork is omitted without invalidating the audit. */ }
  }
  page.drawText('CONSOLIDATED VERIFICATION', { x: MARGIN, y: 585, size: 9, font: mono, color: COLORS.mint });
  for (const [index, line] of wrap(bold, result.form.name, 31, PAGE[0] - 2 * MARGIN).slice(0, 3).entries()) {
    page.drawText(line, { x: MARGIN, y: 535 - index * 38, size: 31, font: bold, color: COLORS.white });
  }
  page.drawText('Forms audit report', { x: MARGIN, y: 398, size: 17, font: regular, color: rgb(0.72, 0.79, 0.76) });
  page.drawRectangle({ x: MARGIN, y: 317, width: 164, height: 35, color: statusColor(result.status) });
  page.drawText(text(result.status).toUpperCase(), { x: MARGIN + 15, y: 329, size: 9, font: bold, color: COLORS.white });
  const coverRows = [
    ['SUBMISSION ID', result.submission_id],
    ['FORM VERSION', String(result.form.version)],
    ['COMPLETED', result.completed_at],
    ['PROCESSING LOCATION', result.processing.location]
  ];
  let coverY = 270;
  for (const [label, value] of coverRows) {
    page.drawText(label, { x: MARGIN, y: coverY, size: 7, font: mono, color: rgb(0.48, 0.58, 0.54) });
    page.drawText(text(value).slice(0, 78), { x: MARGIN, y: coverY - 16, size: 9, font: regular, color: COLORS.white });
    coverY -= 49;
  }
  page.drawText('Confidential audit record - share only with authorised recipients', { x: MARGIN, y: 42, size: 7, font: mono, color: rgb(0.46, 0.56, 0.52) });

  addPage(false);
  heading('EXECUTIVE OUTCOME', 'Consolidated result');
  paragraph(summarize(result), { size: 12, lineHeight: 18, after: 18 });
  const cardWidth = (PAGE[0] - 2 * MARGIN - 16) / 3;
  const cards = [
    ['APIS RUN', result.summary.total],
    ['COMPLETED', result.summary.completed],
    ['UNSUCCESSFUL', result.summary.failed]
  ];
  for (const [index, [label, value]] of cards.entries()) {
    const x = MARGIN + index * (cardWidth + 8);
    page.drawRectangle({ x, y: y - 70, width: cardWidth, height: 70, color: COLORS.paper, borderColor: COLORS.line, borderWidth: 1 });
    page.drawText(String(value), { x: x + 14, y: y - 30, size: 22, font: bold, color: COLORS.ink });
    page.drawText(label, { x: x + 14, y: y - 52, size: 7, font: mono, color: COLORS.muted });
  }
  y -= 98;
  labelValue('Decision eligible', result.summary.decision_eligible ? 'Yes' : 'No - review required');
  labelValue('Coverage complete', `${result.summary.coverage_complete} of ${result.summary.total} selected checks`);
  labelValue('Eligibility reason', result.summary.reason);
  if (result.summary.reason_codes?.length) labelValue('Reason codes', result.summary.reason_codes.join(', '));
  section('Audit trail');
  labelValue('Submitted', result.processing.queued_at);
  labelValue('Processing started', result.processing.started_at);
  labelValue('Completed', result.completed_at);
  labelValue('Request network origin', result.processing.request_origin);
  labelValue('Processing location', result.processing.location);
  labelValue('Callback destination', job.callback_url);

  addPage(false);
  heading('SUBMISSION', 'Collected form data');
  paragraph('The values below were supplied once and mapped server-side into the configured API requests. API credentials and supplier configuration are not included.', { color: COLORS.muted });
  for (const field of job.form.fields) labelValue(field.label, job.data[field.key]);

  addPage(false);
  heading('API RESULTS', 'Service-by-service evidence');
  for (const service of result.services) {
    section(service.name);
    labelValue('Service ID', service.service_id);
    labelValue('Status', service.status);
    labelValue('HTTP status', service.http_status || 'No upstream response');
    labelValue('Transport result', service.transport?.status || service.status);
    labelValue('Coverage result', `${service.coverage?.status || 'unknown'} - ${service.coverage?.reason || 'No coverage reason was recorded.'}`);
    labelValue('Eligibility result', `${service.eligibility?.status || 'ineligible'} - ${service.eligibility?.reason || 'Eligibility was not confirmed.'}`);
    if (service.eligibility?.reason_codes?.length) labelValue('Eligibility reason codes', service.eligibility.reason_codes.join(', '));
    labelValue('Started', service.started_at);
    labelValue('Completed', service.completed_at);
    labelValue('Duration', `${service.duration_ms} ms`);
    if (service.error) labelValue('Customer-safe error', service.error);
    section('Exact API response');
    jsonBlock(service.response ?? { error: service.error || 'No response was returned.' }, service.name);
  }

  addPage(false);
  heading('PROCESSING LOG', 'Orchestration record');
  for (const entry of result.processing.log) {
    ensure(42);
    page.drawText(text(entry.at), { x: MARGIN, y, size: 7, font: mono, color: COLORS.muted });
    y -= 14;
    paragraph(`${entry.stage}: ${entry.message}`, { size: 9, lineHeight: 13, after: 11 });
  }
  section('Response integrity');
  paragraph('The callback response and this report share the same submission ID. The report hash returned by the API can be used to verify the downloaded PDF bytes.', { color: COLORS.muted });
  section('Consolidated response JSON');
  jsonBlock({ ...result, report: undefined }, 'Consolidated response JSON');

  const totalPages = pages.length;
  pages.forEach((item, index) => {
    if (index === 0) return;
    item.drawLine({ start: { x: MARGIN, y: 34 }, end: { x: PAGE[0] - MARGIN, y: 34 }, thickness: 0.6, color: COLORS.line });
    item.drawText(`AI7 UAE  |  ${text(result.submission_id)}`, { x: MARGIN, y: 19, size: 6.5, font: mono, color: COLORS.muted });
    item.drawText(`${index + 1} / ${totalPages}`, { x: PAGE[0] - MARGIN - 35, y: 19, size: 6.5, font: mono, color: COLORS.muted });
  });

  const bytes = Buffer.from(await pdf.save());
  const reportId = randomUUID();
  return {
    reportId,
    generatedAt: result.completed_at,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    filename: `ai7-forms-${subjectSlug(result.form.name)}-${result.completed_at.slice(0, 10)}.pdf`,
    bytes
  };
}
