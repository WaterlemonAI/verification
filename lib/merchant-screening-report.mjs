import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PAGE = { width: 595.28, height: 841.89, margin: 46 };
const C = {
  navy: rgb(9 / 255, 25 / 255, 42 / 255), teal: rgb(16 / 255, 116 / 255, 105 / 255),
  mint: rgb(183 / 255, 246 / 255, 215 / 255), paper: rgb(245 / 255, 248 / 255, 249 / 255),
  ink: rgb(20 / 255, 34 / 255, 48 / 255), muted: rgb(94 / 255, 110 / 255, 124 / 255),
  line: rgb(218 / 255, 227 / 255, 232 / 255), amber: rgb(178 / 255, 112 / 255, 20 / 255),
  red: rgb(163 / 255, 58 / 255, 58 / 255), green: rgb(31 / 255, 122 / 255, 82 / 255), white: rgb(1, 1, 1)
};

function printable(value) {
  return String(value ?? '').replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, (character) => {
      const code = character.codePointAt(0);
      return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`;
    });
}

function stableJson(value) { try { return JSON.stringify(value, null, 2); } catch { return JSON.stringify({ value: String(value) }); } }
function digest(value) { return createHash('sha256').update(Buffer.isBuffer(value) ? value : stableJson(value)).digest('hex'); }
function titleCase(value) { return printable(value || '-').replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase()); }
function iso(value = Date.now()) { const date = new Date(value); return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(); }
function list(value) { return Array.isArray(value) && value.length ? value.join(', ') : '-'; }

function merchantName(request, response) {
  return request.declared_merchant_name || response.merchant_identity?.names?.[0] || new URL(request.website_url).hostname;
}

function reportFilename(name, generatedAt) {
  const slug = String(name || 'merchant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'merchant';
  return `ai7-merchant-screening-${slug}-${generatedAt.slice(0, 10)}.pdf`;
}

function executiveSummary(response) {
  const findings = response.findings || [];
  const critical = findings.filter((item) => item.severity === 'critical').length;
  const high = findings.filter((item) => item.severity === 'high').length;
  const coverageComplete = response.summary?.decision_eligible === true;
  const statement = coverageComplete
    ? `The bounded screening completed with a ${titleCase(response.summary?.risk_level)} risk level and a score of ${response.summary?.risk_score ?? 0} out of 100.`
    : `The bounded screening returned a ${titleCase(response.summary?.risk_level)} risk level and a score of ${response.summary?.risk_score ?? 0} out of 100, but required coverage was incomplete.`;
  const recommendations = [];
  if (!coverageComplete) recommendations.push('Complete unavailable provider checks and documented human review before making an onboarding decision.');
  if (response.summary?.risk_level === 'high_risk') recommendations.push('Complete enhanced due diligence and approve any exception through the institution\'s documented escalation process.');
  if (critical || high) recommendations.push('Review all high and critical findings against primary evidence and the institution\'s merchant acceptance policy.');
  if (response.policies?.missing_expected_items?.length) recommendations.push('Obtain or verify the missing merchant policies before approval.');
  if (response.products?.some((item) => item.mapping_status === 'candidate_for_human_review')) recommendations.push('Validate candidate MCC mappings against the merchant\'s actual products, contracts, and expected transaction activity.');
  if (!recommendations.length) recommendations.push('Retain this report with the merchant due-diligence record and rescreen according to policy.');
  return { statement, critical, high, recommendations };
}

export async function createMerchantScreeningAuditPdf({ request, response, origin, generatedAt = new Date().toISOString(), logoBytes, logoType, screenshots = [] }) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const generated = iso(generatedAt);
  const reportId = randomUUID();
  const name = merchantName(request, response);
  const narrative = executiveSummary(response);
  const pages = [];
  let page; let y;

  const wrap = (font, raw, size, maxWidth) => {
    const lines = [];
    for (const paragraph of printable(raw).split('\n')) {
      if (!paragraph) { lines.push(''); continue; }
      let current = '';
      for (const word of paragraph.split(/\s+/)) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) current = candidate;
        else {
          if (current) lines.push(current);
          let fragment = '';
          for (const character of word) {
            if (fragment && font.widthOfTextAtSize(fragment + character, size) > maxWidth) { lines.push(fragment); fragment = character; }
            else fragment += character;
          }
          current = fragment;
        }
      }
      if (current) lines.push(current);
    }
    return lines;
  };
  const addPage = (section = 'MERCHANT WEBSITE SCREENING') => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    pages.push(page);
    page.drawRectangle({ x: 0, y: PAGE.height - 36, width: PAGE.width, height: 36, color: C.navy });
    page.drawText('AI7 UAE', { x: PAGE.margin, y: PAGE.height - 24, size: 9, font: bold, color: C.mint });
    page.drawText(printable(section), { x: PAGE.margin + 64, y: PAGE.height - 24, size: 7, font: regular, color: C.white });
    y = PAGE.height - 65;
  };
  const ensure = (height, section = 'REPORT CONTINUED') => { if (y - height < 58) addPage(section); };
  const line = (raw, { size = 9, font = regular, color = C.ink, indent = 0, gap = 4, maxWidth = PAGE.width - PAGE.margin * 2 - indent } = {}) => {
    const lines = wrap(font, raw, size, maxWidth); const height = size * 1.4;
    ensure(lines.length * height + gap);
    for (const item of lines) { page.drawText(item || ' ', { x: PAGE.margin + indent, y, size, font, color }); y -= height; }
    y -= gap;
  };
  const heading = (text, kicker = '') => {
    ensure(62, text); y -= 5;
    if (kicker) line(kicker.toUpperCase(), { size: 6.5, font: bold, color: C.teal, gap: 5 });
    line(text, { size: 17, font: bold, gap: 8 });
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.width - PAGE.margin, y }, thickness: 1, color: C.line }); y -= 14;
  };
  const keyValue = (label, value) => {
    ensure(25);
    page.drawText(printable(label).toUpperCase(), { x: PAGE.margin, y, size: 6.5, font: bold, color: C.teal });
    const values = wrap(regular, value == null || value === '' ? '-' : value, 8.5, 345).slice(0, 5);
    for (const item of values) { page.drawText(item, { x: PAGE.margin + 148, y, size: 8.5, font: regular, color: C.ink }); y -= 11; }
    y -= Math.max(8, 20 - values.length * 11);
  };
  const bullets = (items, color = C.ink) => items.forEach((item) => line(`- ${item}`, { size: 8.5, indent: 8, maxWidth: PAGE.width - PAGE.margin * 2 - 8, color }));
  const record = (title, rows, note) => {
    ensure(70, 'DETAILS CONTINUED');
    page.drawRectangle({ x: PAGE.margin, y: y - 3, width: PAGE.width - PAGE.margin * 2, height: 1, color: C.line }); y -= 17;
    line(title, { size: 11, font: bold, color: C.navy, gap: 7 });
    rows.filter(([, value]) => value !== undefined).forEach(([label, value]) => keyValue(label, value));
    if (note) line(note, { size: 7.8, color: C.muted, gap: 8 });
  };

  addPage();
  page.drawRectangle({ x: PAGE.margin, y: y - 138, width: PAGE.width - PAGE.margin * 2, height: 138, color: C.paper });
  let embeddedLogo;
  if (logoBytes && logoType === 'image/png') embeddedLogo = await pdf.embedPng(logoBytes).catch(() => undefined);
  if (logoBytes && ['image/jpeg', 'image/jpg'].includes(logoType)) embeddedLogo = await pdf.embedJpg(logoBytes).catch(() => undefined);
  if (embeddedLogo) {
    const scaled = embeddedLogo.scaleToFit(105, 50);
    page.drawImage(embeddedLogo, { x: PAGE.width - PAGE.margin - scaled.width - 18, y: y - 78, width: scaled.width, height: scaled.height });
  }
  page.drawText('MERCHANT WEBSITE', { x: PAGE.margin + 22, y: y - 35, size: 8, font: bold, color: C.teal });
  page.drawText('Screening result', { x: PAGE.margin + 22, y: y - 68, size: 25, font: bold, color: C.navy });
  page.drawText(printable(name), { x: PAGE.margin + 22, y: y - 96, size: 12, font: regular, color: C.muted, maxWidth: 300 });
  y -= 162;
  keyValue('Transaction ID', response.screening_id);
  keyValue('Report ID', reportId);
  keyValue('Website', request.website_url);
  keyValue('Request received', `${origin.received_at} (UTC)`);
  keyValue('Screen completed', `${response.completed_at} (UTC)`);
  keyValue('Report generated', `${generated} (UTC)`);
  keyValue('Request network address', origin.network_origin || 'Unavailable');
  keyValue('Processing location', origin.processing_location || 'Microsoft Azure UAE North');
  line('The network-address value is the public address observed in the request path. It may identify a proxy or gateway and is not a verified physical location.', { size: 7.2, color: C.muted });
  line('This report supports merchant due-diligence review. It is not a legal conclusion, card-network classification, vulnerability assessment, or automatic approval or decline decision.', { size: 8, font: bold, color: C.red });

  heading('About this service', 'Merchant website due diligence');
  line('AI7 Merchant Website Screening performs a bounded, evidence-preserving review of a public merchant website. It extracts merchant identity and contact details, policies, product information, candidate merchant category codes, outgoing destinations, domain-registration data, transport security observations, and explainable risk signals.', { size: 9 });
  line('The service validates public HTTPS destinations before collection, pins validated DNS results, rechecks redirects, observes robots.txt, stays on the merchant origin, and limits pages, bytes, redirects, and processing time. Rendered screenshots are collected only by the configured isolated browser stage and are included below as visual evidence.', { size: 9 });
  line('Automated findings are review aids. Missing data is reported as incomplete coverage rather than a negative result, and candidate MCC or keyword matches require documented human validation.', { size: 9, color: C.muted });

  heading('Processing log', 'Customer-safe execution record');
  const firstEvidenceTime = response.evidence?.map((item) => item.retrieved_at).filter(Boolean).sort()[0];
  const processingLog = [
    { time: origin.received_at, step: 'Request received', status: 'Completed', detail: `Validated request for ${request.website_url}.` },
    { time: firstEvidenceTime || response.completed_at, step: 'Secure website collection', status: response.summary?.coverage?.website === 'available' ? 'Completed' : 'Incomplete', detail: `${response.crawl?.pages_collected || 0} page(s) retained; ${response.crawl?.page_errors?.length || 0} page error(s).` },
    { time: response.completed_at, step: 'Domain registration lookup', status: titleCase(response.domain?.status), detail: response.domain?.created_at ? `Registration date observed: ${response.domain.created_at}.` : 'No authoritative creation date was retained.' },
    { time: response.completed_at, step: 'Policy, product, link, and security analysis', status: 'Completed', detail: `${response.findings?.length || 0} explainable finding(s), ${response.products?.length || 0} product(s), and ${response.outgoing_links?.length || 0} external destination(s).` },
    { time: response.completed_at, step: 'Rendered screenshot capture', status: titleCase(response.screenshots?.status), detail: `${response.screenshots?.items?.length || 0} screenshot record(s) returned by the isolated browser stage.` },
    { time: response.completed_at, step: 'Risk scoring and coverage decision', status: titleCase(response.status), detail: `Risk score ${response.summary?.risk_score ?? 0}/100; decision eligible: ${response.summary?.decision_eligible ? 'yes' : 'no'}.` },
    { time: generated, step: 'PDF audit report generated', status: 'Completed', detail: `${screenshots.length} screenshot image(s) embedded; integrity hashes and machine-readable JSON attachments added.` }
  ];
  processingLog.forEach((item, index) => record(`${index + 1}. ${item.step}`, [
    ['Timestamp', item.time || '-'], ['Status', item.status], ['Details', item.detail]
  ]));

  heading('Executive outcome', 'Decision support');
  keyValue('Coverage status', titleCase(response.status));
  keyValue('Risk level', titleCase(response.summary?.risk_level));
  keyValue('Risk score', `${response.summary?.risk_score ?? 0} / 100`);
  keyValue('High Risk threshold', `${response.summary?.thresholds?.high_risk_percent ?? request.high_risk_threshold_percent ?? 60}%`);
  keyValue('Review threshold', `${response.summary?.thresholds?.review_percent ?? request.review_threshold_percent ?? 25}%`);
  keyValue('Safe band', `Below ${response.summary?.thresholds?.safe_below_percent ?? request.review_threshold_percent ?? 25}%`);
  keyValue('Outcome', titleCase(response.summary?.outcome));
  keyValue('Confidence', titleCase(response.summary?.confidence));
  keyValue('Decision eligible', response.summary?.decision_eligible ? 'Yes' : 'No - manual review required');
  keyValue('Findings', `${response.findings?.length || 0} total - ${narrative.critical} critical - ${narrative.high} high`);
  line(narrative.statement, { size: 10, font: bold, color: C.navy, gap: 10 });
  line('Recommendations', { size: 11, font: bold, color: C.teal });
  bullets(narrative.recommendations, response.summary?.decision_eligible ? C.ink : C.red);

  heading('Coverage record', 'Completion and limitations');
  Object.entries(response.summary?.coverage || {}).forEach(([label, status]) => keyValue(titleCase(label), titleCase(status)));
  keyValue('Pages collected', String(response.crawl?.pages_collected ?? 0));
  keyValue('Robots status', titleCase(response.crawl?.robots?.status));
  keyValue('Page errors', String(response.crawl?.page_errors?.length || 0));
  keyValue('Maximum pages', String(response.crawl?.limits?.maximum_pages ?? request.max_pages));
  line('Unavailable coverage is not treated as a negative finding. A partial result must be completed or manually reviewed before use in a regulated decision.', { size: 8.5, color: C.amber });

  heading('Website screenshot evidence', `${screenshots.length} actual rendered capture(s)`);
  line('Each following evidence page contains the actual PNG or JPEG produced by the isolated browser stage. The source URL, capture time, viewport, and image hash bind the visual record to this screening.', { size: 8.5, color: C.muted });
  if (!screenshots.length) {
    line('No screenshot image was returned by the configured isolated browser stage. The screenshot coverage status above must be treated as incomplete.', { size: 9, color: C.amber });
  }
  for (const [index, screenshot] of screenshots.entries()) {
    let image;
    if (screenshot.content_type === 'image/png') image = await pdf.embedPng(screenshot.bytes).catch(() => undefined);
    if (['image/jpeg', 'image/jpg'].includes(screenshot.content_type)) image = await pdf.embedJpg(screenshot.bytes).catch(() => undefined);
    addPage('WEBSITE SCREENSHOT EVIDENCE');
    line(`${index + 1}. ${titleCase(screenshot.page_type || 'website')} - ${screenshot.viewport?.name || 'capture'}`, { size: 14, font: bold, color: C.navy, gap: 6 });
    line(screenshot.final_url || screenshot.source_url || '-', { size: 7.5, color: C.muted, gap: 10 });
    if (image) {
      const maximumWidth = PAGE.width - PAGE.margin * 2;
      const maximumHeight = Math.min(500, y - 190);
      const scale = Math.min(maximumWidth / image.width, maximumHeight / image.height, 1);
      const width = image.width * scale;
      const height = image.height * scale;
      page.drawRectangle({ x: PAGE.margin - 1, y: y - height - 1, width: width + 2, height: height + 2, borderColor: C.line, borderWidth: 1, color: C.white });
      page.drawImage(image, { x: PAGE.margin, y: y - height, width, height });
      y -= height + 14;
    } else {
      line('The screenshot bytes could not be embedded.', { size: 9, color: C.red });
    }
    keyValue('Captured at', screenshot.captured_at || '-');
    keyValue('Viewport', screenshot.viewport ? `${screenshot.viewport.width} x ${screenshot.viewport.height} (${screenshot.viewport.name || 'capture'})` : '-');
    keyValue('Image SHA-256', screenshot.sha256 || digest(screenshot.bytes));
  }

  if (screenshots.length) addPage('REPORT CONTINUED');

  heading('Merchant identity', 'Observed website evidence');
  keyValue('Observed names', list(response.merchant_identity?.names));
  keyValue('Declared name', request.declared_merchant_name || '-');
  keyValue('Addresses', list(response.merchant_identity?.addresses));
  keyValue('Telephone numbers', list(response.merchant_identity?.phones));
  keyValue('Email addresses', list(response.merchant_identity?.emails));
  (response.merchant_identity?.social_profiles || []).forEach((item, index) => record(`Social profile ${index + 1}`, [
    ['Network', titleCase(item.network)], ['URL', item.url], ['Verification', titleCase(item.verification_status)]
  ]));
  (response.merchant_identity?.founders || []).forEach((item, index) => record(`Founder ${index + 1}`, [
    ['Name', item.name], ['Role', item.role], ['Source', item.source_url]
  ]));
  (response.merchant_identity?.senior_leadership || []).forEach((item, index) => record(`Leadership ${index + 1}`, [
    ['Name', item.name], ['Role', item.role], ['Source', item.source_url]
  ]));
  (response.merchant_identity?.partnership_and_sponsorship_claims || []).forEach((item, index) => record(`Merchant claim ${index + 1}`, [
    ['Claim', item.claim], ['Source', item.source_url], ['Verification', titleCase(item.verification_status)]
  ], 'This is a source-scoped merchant website claim and has not been independently verified.'));

  heading('Domain and security', 'Technical observations');
  keyValue('Domain lookup status', titleCase(response.domain?.status));
  keyValue('Domain', response.domain?.domain || '-');
  keyValue('Created at', response.domain?.created_at || '-');
  keyValue('Approximate age', Number.isFinite(response.domain?.age_days) ? `${response.domain.age_days} days` : '-');
  keyValue('TLS protocol', response.security?.tls?.protocol || '-');
  keyValue('TLS cipher', response.security?.tls?.cipher || '-');
  keyValue('TLS authorized', response.security?.tls?.authorized == null ? '-' : response.security.tls.authorized ? 'Yes' : 'No');
  keyValue('Missing recommended headers', list((response.security?.missing_recommended_headers || []).map(titleCase)));
  if (response.security?.note) line(response.security.note, { size: 8, color: C.muted });

  heading('Policies', response.policies?.country_pack?.name || 'Policy presence review');
  keyValue('Country pack', response.policies?.country_pack?.name || '-');
  keyValue('Missing expected items', list((response.policies?.missing_expected_items || []).map(titleCase)));
  for (const policy of ['privacy', 'terms', 'returns', 'shipping', 'customer_support', 'data_storage_and_retention']) {
    const item = response.policies?.[policy] || {};
    record(titleCase(policy), [['Status', titleCase(item.status)], ['URL', item.url]], item.note);
  }
  if (response.policies?.country_pack?.note) line(response.policies.country_pack.note, { size: 8, color: C.muted });

  heading('Products and candidate MCCs', `${response.products?.length || 0} observed product(s)`);
  if (!response.products?.length) line('No structured or supported product evidence was extracted in the bounded crawl.', { size: 9, color: C.muted });
  (response.products || []).forEach((item, index) => record(`${index + 1}. ${item.name || 'Unnamed product'}`, [
    ['Description', item.description], ['SKU', item.sku], ['Brand', item.brand],
    ['Price', item.price ? `${item.price} ${item.currency || ''}`.trim() : '-'], ['Source', item.url],
    ['Candidate MCC', item.candidate_mcc ? `${item.candidate_mcc.code} - ${item.candidate_mcc.description}` : '-'],
    ['Mapping status', titleCase(item.mapping_status)], ['Risk level', titleCase(item.risk_level)],
    ['Risk signals', list((item.risk_signals || []).map(titleCase))]
  ], 'Candidate MCCs are text-based review signals and require human validation.'));

  heading('Outgoing destinations', `${response.outgoing_links?.length || 0} unique external destination(s)`);
  if (!response.outgoing_links?.length) line('No external destinations were retained from the bounded crawl.', { size: 9, color: C.muted });
  (response.outgoing_links || []).forEach((item, index) => record(`${index + 1}. ${item.host || item.url}`, [
    ['URL', item.url], ['Category', titleCase(item.category)], ['Source types', list((item.source_types || []).map(titleCase))],
    ['Source pages', list(item.source_pages)], ['Risk level', titleCase(item.risk_level)],
    ['Risk signals', list((item.prohibited_risk_signals || []).map(titleCase))], ['Verification', titleCase(item.verification_status)]
  ]));

  heading('Findings', `${response.findings?.length || 0} explainable finding(s)`);
  if (!response.findings?.length) line('No deterministic findings were returned.', { size: 9, color: C.green });
  (response.findings || []).forEach((item, index) => record(`${index + 1}. ${titleCase(item.code)}`, [
    ['Severity', titleCase(item.severity)], ['Summary', item.summary], ['Source', item.source_url]
  ]));

  heading('Evidence register', `${response.evidence?.length || 0} retained page digest(s)`);
  (response.evidence || []).forEach((item, index) => record(`${index + 1}. ${item.evidence_id}`, [
    ['Type', titleCase(item.type)], ['Source URL', item.source_url], ['Retrieved', item.retrieved_at],
    ['HTTP status', String(item.http_status ?? '-')], ['SHA-256', item.sha256]
  ]));

  heading('Audit and integrity record', 'Reproducibility');
  keyValue('Transaction ID', response.screening_id);
  keyValue('Request SHA-256', digest(request));
  keyValue('Response SHA-256', digest(response));
  keyValue('Methodology version', response.methodology?.version || '-');
  keyValue('Cost ceiling', response.methodology?.cost_ceiling_usd == null ? '-' : `USD ${response.methodology.cost_ceiling_usd}`);
  keyValue('Report retention', 'Permanent public capability URL; possession of the unguessable link grants download access');
  line('The exact validated request and pre-report JSON response are embedded as machine-readable attachments.', { size: 8.5 });
  await pdf.attach(Buffer.from(stableJson(request)), 'request.json', { mimeType: 'application/json', description: 'Validated merchant-screening request' });
  await pdf.attach(Buffer.from(stableJson(response)), 'response.json', { mimeType: 'application/json', description: 'Merchant-screening response before report metadata' });

  pages.forEach((item, index) => {
    item.drawLine({ start: { x: PAGE.margin, y: 39 }, end: { x: PAGE.width - PAGE.margin, y: 39 }, thickness: 0.7, color: C.line });
    item.drawText(`CONFIDENTIAL - ${reportId}`, { x: PAGE.margin, y: 24, size: 6.5, font: bold, color: C.muted });
    item.drawText(`PAGE ${index + 1} OF ${pages.length}`, { x: PAGE.width - PAGE.margin - 72, y: 24, size: 6.5, font: regular, color: C.muted });
  });
  pdf.setTitle(`Merchant Website Screening Result - ${name}`);
  pdf.setAuthor('AI7 UAE');
  pdf.setSubject(`Transaction ${response.screening_id}`);
  pdf.setCreationDate(new Date(generated));
  const bytes = Buffer.from(await pdf.save());
  return { bytes, reportId, sha256: digest(bytes), generatedAt: generated, filename: reportFilename(name, generated) };
}
