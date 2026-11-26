import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupJevIncidents, jevIncidentEligibilityRequest, jevIncidentPairRequest } from '../lib/adverse-media-jev-incidents.mjs';
import { JevScreeningError, validateJevEventRegister } from '../lib/adverse-media-jev-screening.mjs';

const [samplePath, screeningPath, outputDir] = process.argv.slice(2);
if (!samplePath || !screeningPath || !outputDir)
  throw new Error('usage: node scripts/run-adverse-media-jev-full-qa.mjs sample.json screening-results.jsonl output-dir --key-from-clipboard');
const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
const screening = readFileSync(screeningPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
if (sample.rows?.length !== 100 || screening.length !== 100)
  throw new Error('expected_100_sample_and_screening_rows');
const screenedByKey = new Map(screening.map((row) => [row.story_key, row]));
if (screenedByKey.size !== 100 || sample.rows.some((row) => !screenedByKey.has(row.story_key)))
  throw new Error('sample_screening_keys_mismatch');

const bySubject = new Map();
for (const row of sample.rows) {
  if (screenedByKey.get(row.story_key).classification.tag === 'redundant') continue;
  const rows = bySubject.get(row.subject) || [];
  rows.push(row);
  bySubject.set(row.subject, rows);
}
let maximumBytes = 0;
let maximumCalls = 0;
for (const [name, rows] of bySubject) {
  const { subject, articles } = validateJevEventRegister({
    subject: { name }, articles: rows.map((row) => row.article)
  }, { maxArticles: 100 });
  for (let i = 0; i < articles.length; i++) {
    maximumBytes += Buffer.byteLength(JSON.stringify(jevIncidentEligibilityRequest(subject, articles[i])));
    maximumCalls += 1;
    for (let j = i + 1; j < articles.length; j++) {
      maximumBytes += Buffer.byteLength(JSON.stringify(jevIncidentPairRequest(subject, articles[i], articles[j])));
      maximumCalls += 1;
    }
  }
}
const maximumCost = maximumBytes * 0.042 / 1_000_000;
const costCap = Number(process.env.JEV_GROUPING_COST_CAP_USD || 0.30);
if (!Number.isFinite(costCap) || costCap <= 0) throw new Error('invalid_jev_grouping_cost_cap');
const screeningCost = screening.reduce((sum, row) => sum + (row.usage?.input_tokens || 0), 0)
  * 0.042 / 1_000_000;
if (screeningCost > costCap) throw new Error('screening_cost_exceeds_cap');

mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const exchangePath = join(outputDir, 'provider-exchanges.jsonl');
const cached = new Map(existsSync(exchangePath)
  ? readFileSync(exchangePath, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).map((item) => [item.request_sha256, item]) : []);
let reservedGroupingCost = [...cached.values()].reduce((sum, item) =>
  sum + (item.request_bytes || 0) * 0.042 / 1_000_000, 0);
const apiKey = process.env.TYPESAFE_API_KEY
  || (process.argv.includes('--key-from-clipboard') ? execFileSync('pbpaste', { encoding: 'utf8' }).trim() : '');
if (!apiKey) throw new Error('typesafe_api_key_unavailable');

async function fetchWithCheckpoint(url, options) {
  const hash = createHash('sha256').update(options.body).digest('hex');
  const saved = cached.get(hash);
  if (saved) return new Response(JSON.stringify(saved.body), { status: 200 });
  for (let attempt = 1; attempt <= 4; attempt++) {
    const requestBytes = Buffer.byteLength(options.body);
    const nextCost = requestBytes * 0.042 / 1_000_000;
    if (screeningCost + reservedGroupingCost + nextCost > costCap)
      throw new JevScreeningError('jev_total_cost_cap_exceeded');
    reservedGroupingCost += nextCost;
    const response = await fetch(url, options);
    if (response.status === 429 && attempt < 4) {
      const retrySeconds = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retrySeconds) && retrySeconds > 0
        ? Math.min(retrySeconds * 1000, 10_000) : 1000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    if (!response.ok) return response;
    const body = await response.json();
    const record = { request_sha256: hash, request_bytes: requestBytes,
      status: response.status, body };
    appendFileSync(exchangePath, JSON.stringify(record) + '\n', { mode: 0o600 });
    cached.set(hash, record);
    return new Response(JSON.stringify(body), { status: 200 });
  }
  throw new Error('jev_retry_exhausted');
}

const groupFiles = [];
for (const [name, rows] of [...bySubject].sort(([a], [b]) => a.localeCompare(b))) {
  const file = join(outputDir, `group-${createHash('sha256').update(name).digest('hex').slice(0, 12)}.json`);
  if (!existsSync(file)) {
    const result = await groupJevIncidents({ subject: { name }, articles: rows.map((row) => row.article) },
      { apiKey, fetchImpl: fetchWithCheckpoint });
    writeFileSync(file, JSON.stringify({ subject: name, result }, null, 2), { mode: 0o600 });
  }
  groupFiles.push({ subject: name, file, result: JSON.parse(readFileSync(file, 'utf8')).result });
  process.stderr.write(`Grouped ${name}: ${rows.length} screened articles\n`);
}

const groupedByKey = new Map(groupFiles.flatMap(({ subject, result }) =>
  result.event_register.articles.map((row) => [row.story_key, { subject, ...row }])));
const combined = sample.rows.map((row) => {
  const prior = screenedByKey.get(row.story_key);
  const grouping = groupedByKey.get(row.story_key);
  return { story_key: row.story_key, subject: row.subject, title: row.article.title,
    url: row.article.url, evidence_grade: row.evidence_grade,
    baseline_assessment: row.baseline_assessment,
    adverseness: prior.classification.adverseness || null,
    relationship: prior.classification.relationship || null,
    screening_status: prior.classification.tag || 'screened',
    incident_id: grouping?.incident_id || null,
    incident_label: grouping?.incident_label || null,
    incident_status: grouping?.group_status || (prior.classification.tag || 'unassigned'),
    incident_reason: grouping?.reason || null };
});
writeFileSync(join(outputDir, 'combined-event-register.json'), JSON.stringify({
  source_sample: samplePath, screening_results: screeningPath,
  articles: combined,
  incidents: groupFiles.flatMap(({ subject, result }) => result.incidents.map((item) => ({ subject, ...item }))),
  unmerged_same_pairs: groupFiles.flatMap(({ subject, result }) =>
    result.unmerged_same_pairs.map((item) => ({ subject, ...item })))
}, null, 2), { mode: 0o600 });

const allExchanges = [...cached.values()];
const inputTokens = allExchanges.reduce((sum, row) => sum + (row.body?.usage?.input_tokens || 0), 0);
const outputTokens = allExchanges.reduce((sum, row) => sum + (row.body?.usage?.output_tokens || 0), 0);
writeFileSync(join(outputDir, 'run-manifest.json'), JSON.stringify({
  sample_path: samplePath, screening_path: screeningPath,
  subjects: groupFiles.map(({ subject, result }) => ({ subject,
    incident_count: result.incidents.length, article_count: result.event_register.articles.length,
    pair_review_count: result.pair_reviews.length })),
  rows: combined.length, screened_rows: groupedByKey.size,
  theoretical_exhaustive_calls: maximumCalls,
  theoretical_exhaustive_cost_usd: maximumCost,
  cost_cap_usd: costCap, provider_exchanges_saved: allExchanges.length,
  screening_estimated_cost_usd: screeningCost,
  grouping_request_bytes_cost_upper_bound_usd: reservedGroupingCost,
  input_tokens: inputTokens, output_tokens: outputTokens,
  estimated_actual_input_cost_usd: inputTokens * 0.042 / 1_000_000,
  completed_at: new Date().toISOString()
}, null, 2), { mode: 0o600 });
process.stderr.write(`Completed 100-row full Jev evaluation; ${allExchanges.length} grouping answers saved\n`);
