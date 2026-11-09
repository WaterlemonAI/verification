import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import 'regenerator-runtime/runtime.js';
import { sha256 } from './crypto.mjs';
import { buildFloReportModel } from './report-model.mjs';
import { buildSupplierReportModel } from './templates/supplier-onboarding-v1/report.mjs';
import { renderFloReportHtml } from './report-html.mjs';

function printable(value) {
  return String(value).replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}
function wrap(value, width = 88) {
  const lines = [];
  for (const raw of printable(value).split('\n')) {
    let line = raw;
    while (line.length > width) { lines.push(line.slice(0, width)); line = line.slice(width); }
    lines.push(line);
  }
  return lines;
}

export async function createFloReport(item) {
  const model = item.flow_id === 'supplier-onboarding-v1' ? buildSupplierReportModel(item) : buildFloReportModel(item);
  const html = renderFloReportHtml(model);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const corpus = printable(JSON.stringify(model));
  const unicodeFonts = {};
  for (const [key, pattern, file] of [
    ['cjk', /[\u3400-\u9fff\uf900-\ufaff]/u, 'NotoSansCJKsc-Regular.otf'],
    ['devanagari', /[\u0900-\u097f]/u, 'NotoSansDevanagari.ttf'],
    ['arabic', /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u, 'NotoSansArabic.ttf'],
    ['other', /[^\x00-\x7f]/u, 'NotoSans.ttf']
  ]) if (pattern.test(corpus)) unicodeFonts[key] = await pdf.embedFont(
    readFileSync(new URL(`../fonts/${file}`, import.meta.url)),
    { subset: key !== 'cjk' && key !== 'other' });
  function fontFor(value, strong) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(value)) return unicodeFonts.cjk;
    if (/[\u0900-\u097f]/u.test(value)) return unicodeFonts.devanagari;
    if (/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(value)) return unicodeFonts.arabic;
    if (/[^\x00-\x7f]/u.test(value)) return unicodeFonts.other;
    return strong ? bold : regular;
  }
  const pages = [];
  let page, y;
  function nextPage() {
    page = pdf.addPage([595.28, 841.89]); pages.push(page); y = 792;
    page.drawText('KYCProbe · Flo', { x: 44, y: 810, size: 10, font: bold, color: rgb(0.13, 0.33, 0.65) });
  }
  function line(value, strong = false) {
    for (const part of wrap(value)) {
      if (y < 55) nextPage();
      page.drawText(part || ' ', { x: 44, y, size: strong ? 12 : 9, font: fontFor(part, strong),
        color: rgb(0.09, 0.17, 0.27), maxWidth: 510 });
      y -= strong ? 19 : 14;
    }
  }
  nextPage(); line(model.title, true); line(`Application ${item.application_id} · ${model.generated_at}`);
  for (const section of model.sections) {
    y -= 12; line(section.title, true);
    for (const value of section.lines) line(value);
  }
  for (let i = 0; i < pages.length; i++) pages[i].drawText(`Page ${i + 1} of ${pages.length}`, { x: 490, y: 25, size: 8, font: regular });
  await pdf.attach(Buffer.from(JSON.stringify(model)), 'complete-report.json', { mimeType: 'application/json',
    description: 'Complete structured report model' });
  const bytes = Buffer.from(await pdf.save());
  return { report_id: randomUUID(), version: (item.reports?.length || 0) + 1, generated_at: model.generated_at,
    sha256: sha256(bytes), pdf: bytes, html, model };
}
