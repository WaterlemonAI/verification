import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupJevIncidents } from '../lib/adverse-media-jev-incidents.mjs';
import { JEV_SCREENING_MODEL, jevArticleRequest } from '../lib/adverse-media-jev-screening.mjs';

const [samplePath, outputDir] = process.argv.slice(2);
if (!samplePath || !outputDir) throw new Error('usage: node scripts/run-adverse-media-jev-headline-qa.mjs sample.json output-dir --key-from-clipboard');
const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
if (!Array.isArray(sample.rows) || sample.rows.length < 1
  || new Set(sample.rows.map((row) => row.story_key)).size !== sample.rows.length
  || new Set(sample.rows.map((row) => row.subject)).size !== 1
  || sample.rows.some((row) => row.article.text || row.article.excerpt))
  throw new Error('expected_unique_single_subject_headline_only_rows');

const apiKey = process.env.TYPESAFE_API_KEY
  || (process.argv.includes('--key-from-clipboard') ? execFileSync('pbpaste', { encoding: 'utf8' }).trim() : '');
if (!apiKey) throw new Error('typesafe_api_key_unavailable');
const cap = Number(process.env.JEV_HEADLINE_COST_CAP_USD || 0.30);
if (!Number.isFinite(cap) || cap <= 0) throw new Error('invalid_jev_headline_cost_cap');

mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const exchangePath = join(outputDir, 'provider-exchanges.jsonl');
const exchanges = existsSync(exchangePath)
  ? readFileSync(exchangePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const byKey = new Map(exchanges.map((item) => [item.story_key, item]));
if (byKey.size !== exchanges.length || exchanges.some((item) => !sample.rows.some((row) => row.story_key === item.story_key)))
  throw new Error('checkpoint_sample_mismatch');
let reservedCost = exchanges.reduce((sum, item) => sum + item.request_bytes * 0.042 / 1_000_000, 0);

function requestFor(row) {
  const full = jevArticleRequest({ name: row.subject, entity_type: '', aliases: [] }, row.article);
  return { ...full, questions: { subject_association: full.questions.subject_association } };
}

async function check(row) {
  const request = requestFor(row);
  const body = JSON.stringify(request);
  const requestBytes = Buffer.byteLength(body);
  const nextCost = requestBytes * 0.042 / 1_000_000;
  if (reservedCost + nextCost > cap) throw new Error('jev_headline_cost_cap_exceeded');
  reservedCost += nextCost;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body, signal: AbortSignal.timeout(20_000)
    });
    if (response.status === 429 && attempt < 4) {
      const retry = Number(response.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve,
        Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 10_000) : 1000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) throw new Error(`jev_http_${response.status}`);
    const answer = await response.json();
    const probability = answer?.answers?.subject_association?.noul;
    if (answer.model !== JEV_SCREENING_MODEL || answer.answers.subject_association.type !== 'noul'
      || !Number.isFinite(probability) || probability < 0 || probability > 1)
      throw new Error('invalid_jev_headline_answer');
    const record = { story_key: row.story_key, request_sha256: createHash('sha256').update(body).digest('hex'),
      request_bytes: requestBytes, request, response: answer, attempts: attempt };
    appendFileSync(exchangePath, JSON.stringify(record) + '\n', { mode: 0o600 });
    byKey.set(row.story_key, record);
    return;
  }
  throw new Error('jev_retry_exhausted');
}

for (const row of sample.rows) {
  if (byKey.has(row.story_key)) continue;
  await check(row);
  if (byKey.size % 50 === 0) process.stderr.write(`Jev headline association ${byKey.size}/${sample.rows.length}\n`);
}

const assessments = sample.rows.map((row) => {
  const p = byKey.get(row.story_key).response.answers.subject_association.noul;
  const redundant = p <= 0.30;
  return { story_key: row.story_key, subject: row.subject, title: row.article.title, url: row.article.url,
    evidence_grade: row.evidence_grade, selection_status: row.selection_status,
    selection_reason: row.selection_reason, subject_association_probability: p,
    screening_status: redundant ? 'redundant' : 'screened',
    adverseness: redundant ? null : 'inconclusive', relationship: redundant ? null : 'inconclusive',
    incident_id: null, incident_label: null,
    incident_status: redundant ? 'redundant' : 'unassigned',
    incident_reason: redundant ? 'subject_association_at_or_below_0.30'
      : 'insufficient_article_evidence' };
});

const retained = sample.rows.filter((row) => byKey.get(row.story_key).response.answers.subject_association.noul > 0.30);
for (let i = 0; i < retained.length; i += 100) {
  const chunk = retained.slice(i, i + 100);
  const grouped = await groupJevIncidents({ subject: { name: chunk[0].subject },
    articles: chunk.map((row) => row.article) }, {
    apiKey, fetchImpl: () => { throw new Error('headline_only_grouping_must_not_call_provider'); }
  });
  if (grouped.incidents.length || grouped.event_register.articles.length !== chunk.length
    || grouped.event_register.articles.some((item) => item.reason !== 'insufficient_article_evidence'))
    throw new Error('unexpected_headline_grouping_result');
}

writeFileSync(join(outputDir, 'combined-event-register.json'), JSON.stringify({
  source_sample: samplePath, articles: assessments, incidents: []
}, null, 2), { mode: 0o600 });
const totalInputTokens = [...byKey.values()].reduce((sum, item) =>
  sum + (item.response.usage?.input_tokens || 0), 0);
writeFileSync(join(outputDir, 'run-manifest.json'), JSON.stringify({
  sample_path: samplePath, source_csv_sha256: sample.source_csv_sha256,
  rows: sample.rows.length, provider_calls: byKey.size,
  subject: sample.rows[0].subject, evidence_grade: 'metadata_only',
  cost_cap_usd: cap, request_bytes_cost_upper_bound_usd: reservedCost,
  input_tokens: totalInputTokens,
  estimated_actual_input_cost_usd: totalInputTokens * 0.042 / 1_000_000,
  redundant: assessments.filter((row) => row.screening_status === 'redundant').length,
  retained_inconclusive: retained.length, incidents: 0,
  completed_at: new Date().toISOString()
}, null, 2), { mode: 0o600 });
process.stderr.write(`Completed ${sample.rows.length} headline association checks\n`);
