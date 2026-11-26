import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { screenJevEventRegister, jevArticleRequest,
  JEV_SCREENING_CONTRACT, JEV_SCREENING_MODEL } from '../lib/adverse-media-jev-screening.mjs';

const samplePath = process.argv[2];
const outputPath = process.argv[3];
if (!samplePath || !outputPath) throw new Error('usage: node scripts/run-adverse-media-jev-qa.mjs sample.json results.jsonl');
const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
if (!Array.isArray(sample.rows) || sample.rows.length !== 100
  || new Set(sample.rows.map((row) => row.story_key)).size !== 100)
  throw new Error('sample_must_contain_100_unique_articles');

const apiKey = process.env.TYPESAFE_API_KEY
  || (process.argv.includes('--key-from-clipboard') ? execFileSync('pbpaste', { encoding: 'utf8' }).trim() : '');
if (!apiKey) throw new Error('typesafe_api_key_unavailable');

const existing = existsSync(outputPath)
  ? readFileSync(outputPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
const done = new Set(existing.map((row) => row.story_key));
let completed = done.size;
const inputBytes = sample.rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(
  jevArticleRequest({ name: row.subject, entity_type: '', aliases: [] }, row.article))), 0);
const conservativeCost = inputBytes * 0.042 / 1_000_000;
if (conservativeCost > 0.05) throw new Error(`estimated_input_cost_exceeds_0.05_usd:${conservativeCost}`);

for (const row of sample.rows) {
  if (done.has(row.story_key)) continue;
  let provider = null;
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      const result = await screenJevEventRegister({
        subject: { name: row.subject }, articles: [row.article]
      }, {
        apiKey,
        fetchImpl: async (url, options) => {
          const response = await fetch(url, options);
          let body = null;
          try { body = await response.clone().json(); } catch { /* Provider error bodies need not be JSON. */ }
          provider = { status: response.status, body,
            request_sha256: createHash('sha256').update(options.body).digest('hex') };
          return response;
        }
      });
      const classification = result.event_register.articles[0] || result.redundant[0];
      appendFileSync(outputPath, JSON.stringify({
        story_key: row.story_key, subject: row.subject, source_version: row.source_version,
        source_type: row.source_type, title: row.article.title, url: row.article.url,
        baseline_assessment: row.baseline_assessment,
        baseline_relationship: row.baseline_relationship,
        baseline_review_status: row.baseline_review_status,
        classification, association_probability: provider?.body?.answers?.subject_association?.noul,
        adverseness_probabilities: provider?.body?.answers?.adverseness?.probabilities,
        relationship_probabilities: provider?.body?.answers?.relationship?.probabilities,
        usage: provider?.body?.usage, provider_status: provider?.status,
        request_sha256: provider?.request_sha256, attempts: attempt
      }) + '\n', { mode: 0o600 });
      completed += 1;
      break;
    } catch (error) {
      if (error.message === 'jev_http_429' && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      writeFileSync(`${outputPath}.failure.json`, JSON.stringify({ story_key: row.story_key,
        attempt, error: error.message, provider_status: provider?.status }, null, 2), { mode: 0o600 });
      throw error;
    }
  }
  if (completed % 10 === 0) process.stderr.write(`Jev completed ${completed}/100 checks\n`);
}
writeFileSync(`${outputPath}.manifest.json`, JSON.stringify({
  contract: JEV_SCREENING_CONTRACT, model: JEV_SCREENING_MODEL,
  sample_path: samplePath, results_path: outputPath,
  rows_requested: sample.rows.length, input_bytes_upper_bound: inputBytes,
  conservative_input_cost_usd: conservativeCost,
  completed_at: new Date().toISOString()
}, null, 2), { mode: 0o600 });
