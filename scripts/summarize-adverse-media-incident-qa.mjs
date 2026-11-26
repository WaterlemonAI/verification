import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/summarize-adverse-media-incident-qa.mjs output-dir');
const records = JSON.parse(readFileSync(join(dir, 'private-run-ledger.json'), 'utf8'));
const forbidden = /\b(?:mistral|ministral|jev|gemini|brave|typesafe|event[ _-]?registry|internal[ _-]?tool)\b/i;
const cells = (values) => values.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',');
const header = ['subject', 'status', 'articles', 'incidents', 'unassigned', 'article_bodies',
  'elapsed_seconds', 'search_calls', 'article_extractions', 'screening_calls', 'summary_calls',
  'search_usd', 'article_extraction_usd', 'screening_upper_usd', 'summary_usd',
  'server_active_compute_model_usd', 'total_variable_model_upper_usd', 'archive_access_denied'];
const lines = [cells(header)];
const index = ['# Signed incident report pairs', '',
  'These are local, private QA artifacts with incomplete source coverage. The certificate is a temporary self-signed QA identity.', '',
  '| Subject | Response JSON | Signed PDF | Articles | Incidents | Seconds | Modeled USD |',
  '| --- | --- | --- | ---: | ---: | ---: | ---: |'];
const issues = [];
for (const record of records) {
  let valid = record.status === 200;
  if (valid) {
    const json = JSON.parse(readFileSync(join(dir, `${record.id}.response.json`), 'utf8'));
    const pdf = readFileSync(join(dir, `${record.id}.pdf`));
    const publicText = JSON.stringify({ ...json, report: { ...json.report, pdf_base64: undefined } });
    const pdfText = execFileSync('pdftotext', [join(dir, `${record.id}.pdf`), '-'],
      { encoding: 'utf8' });
    const info = execFileSync('pdfinfo', [join(dir, `${record.id}.pdf`)], { encoding: 'utf8' });
    const sig = execFileSync('pdfsig', [join(dir, `${record.id}.pdf`)], { encoding: 'utf8' });
    valid = !forbidden.test(publicText) && !forbidden.test(pdfText)
      && createHash('sha256').update(pdf).digest('hex') === json.report.sha256
      && pdf.equals(Buffer.from(json.report.pdf_base64, 'base64'))
      && sig.includes('Signature is Valid.') && sig.includes('Total document signed')
      && /Creator:\s+KYCProbe/.test(info) && /Producer:\s+KYCProbe/.test(info);
    if (!valid) issues.push(`${record.id}: public output, PDF hash, metadata, or signature verification failed`);
  } else issues.push(`${record.id}: ${record.error} (${record.private_error || 'no detail'})`);
  const c = record.costs || {};
  index.push(`| ${record.subject.replaceAll('|', '\\|')} | ${record.status === 200
    ? `[JSON](${record.id}.response.json)` : existsSync(join(dir, `${record.id}.error.json`))
      ? `[Error JSON](${record.id}.error.json)` : 'Evidence unavailable'} | ${record.status === 200
    ? `[PDF](${record.id}.pdf)` : '—'} | ${record.retained_count} | ${record.incident_count} | ${(record.elapsed_ms / 1000).toFixed(1)} | $${Number(c.total_variable_model_upper_usd || 0).toFixed(4)} |`);
  const searchCost = c.search_usd ?? Number((record.calls.search * 0.005).toFixed(6));
  const extractionCost = c.article_extraction_usd
    ?? Number((record.calls.article_extraction * 0.0009).toFixed(6));
  const screeningCost = c.screening_upper_usd
    ?? Number((record.trace.filter((item) => item.category === 'screening')
      .reduce((sum, item) => sum + item.request_bytes * 0.042 / 1_000_000, 0)).toFixed(6));
  const summaryCost = c.summary_usd ?? 0;
  const serverCost = c.server_active_compute_model_usd
    ?? Number((Number(c.total_variable_model_upper_usd || 0) - searchCost - extractionCost
      - screeningCost - summaryCost).toFixed(6));
  lines.push(cells([record.subject, record.status, record.retained_count, record.incident_count,
    record.unassigned_count, record.body_count, (record.elapsed_ms / 1000).toFixed(2),
    record.calls.search, record.calls.article_extraction, record.calls.screening, record.calls.summary,
    searchCost, extractionCost, screeningCost,
    summaryCost, serverCost,
    c.total_variable_model_upper_usd ?? '', record.archive_access_denied]));
}
writeFileSync(join(dir, 'qa-costs.csv'), lines.join('\n') + '\n');
writeFileSync(join(dir, 'reports-index.md'), index.join('\n') + '\n');
const successes = records.filter((item) => item.status === 200);
const modeled = records.reduce((sum, item) => sum + Number(item.costs?.total_variable_model_upper_usd || 0), 0);
const seconds = records.map((item) => item.elapsed_ms / 1_000).sort((a, b) => a - b);
const percentile = (p) => seconds[Math.min(seconds.length - 1, Math.ceil(seconds.length * p) - 1)] || 0;
const summary = [
  '# Adverse media incident report QA', '',
  `Attempted: ${records.length}; completed report pairs: ${successes.length}; failed: ${records.length - successes.length}.`,
  `Modeled marginal test cost: $${modeled.toFixed(4)}; average per attempted check: $${(modeled / records.length).toFixed(4)}.`,
  `Response time: median ${percentile(0.5).toFixed(1)}s; p95 ${percentile(0.95).toFixed(1)}s; maximum ${Math.max(...seconds).toFixed(1)}s.`,
  `PDF/JSON signature, hash, metadata, and public-name checks passed: ${successes.length - issues.filter((item) => item.includes('verification failed')).length}/${successes.length}.`,
  '', '## Gaps', '',
  ...issues.map((item) => `- ${item}`),
  '- The local QA identity cannot read the Azure archive tables (403). All cases used the explicit search-plus-article-extraction fallback; archive contribution was not validated in this batch.',
  '- PDFs use a temporary self-signed QA certificate. They verify integrity but lack a trusted organizational issuer.',
  '- Policy evaluation remains not run; article and incident labels do not produce a policy decision.',
  '', '## Per-check costs', '',
  'See `qa-costs.csv`. Rates are modeled marginal charges, not invoices; idle server capacity, storage, egress, taxes, and plan allowances are excluded.', ''
].join('\n');
writeFileSync(join(dir, 'qa-summary.md'), summary);
process.stdout.write(JSON.stringify({ attempted: records.length, completed: successes.length,
  issues: issues.length, modeled_usd: Number(modeled.toFixed(4)), median_seconds: percentile(0.5),
  p95_seconds: percentile(0.95) }) + '\n');
