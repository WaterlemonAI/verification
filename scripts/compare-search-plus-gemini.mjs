import { readFile } from 'node:fs/promises';
import { classifyWithAi, mediaBucket, resolveLegalStage } from '../lib/adverse-media.mjs';

const fixtureFiles = [
  'gpt5-mini-synthetic-case.json',
  'gpt5-mini-adverse-holdout.json',
  'gpt5-mini-party-facts-individual.json',
  'gpt5-mini-party-facts-fresh-holdout.json',
  'gpt5-mini-party-facts-arabic.json'
];
const model = process.argv[2] || 'gemini-3.5-flash-lite';
if (!['gemini-3.5-flash-lite', 'gemini-3.5-flash'].includes(model)) throw new TypeError('unsupported_model');
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is required');

const totals = { model, expected: 0, classified: 0, exact_bucket: 0, exact_role: 0,
  exact_stage: 0, exact_all: 0, elapsed_ms: 0, input_tokens: 0, output_tokens: 0, cases: [] };
const fetchImpl = (input, options) => fetch(String(input).replace(
  '/models/gemini-3.5-flash-lite:generateContent', `/models/${model}:generateContent`), options);

for (const file of fixtureFiles) {
  const fixture = JSON.parse(await readFile(new URL(`../test/fixtures/${file}`, import.meta.url), 'utf8'));
  const entity = { entity_type: fixture.subject.type, name: fixture.subject.name, aliases: fixture.subject.aliases || [],
    countries: fixture.subject.jurisdiction ? [fixture.subject.jurisdiction] : [] };
  const request = { ...entity, transliterations: {} };
  const results = fixture.evidence.map((item) => ({
    result_id: item.id, title: item.title, excerpt: item.excerpt,
    publisher: item.publisher, url: item.url, source_type: 'news_index',
    published_at: '2026-11-01T00:00:00.000Z', source_reliability_score: 0.68,
    legal_stage: 'media_mention'
  }));
  const started = performance.now();
  const classified = await classifyWithAi(results, request, apiKey, fetchImpl, null, fixture.case_id);
  const actual = new Map(classified.results.map((item) => [item.result_id, item]));
  const mismatches = [];
  for (const expected of fixture.evidence) {
    const item = actual.get(expected.id);
    const ai = item?.ai_classification;
    if (!ai) {
      mismatches.push({ id: expected.id, error: 'unclassified' });
      continue;
    }
    const bucket = mediaBucket(item, entity);
    const role = ai.subject_role;
    const stage = resolveLegalStage(item, entity);
    const bucketCorrect = bucket === expected.expected_bucket;
    const roleCorrect = role === expected.expected_role;
    const stageCorrect = stage === expected.expected_stage;
    totals.exact_bucket += Number(bucketCorrect);
    totals.exact_role += Number(roleCorrect);
    totals.exact_stage += Number(stageCorrect);
    totals.exact_all += Number(bucketCorrect && roleCorrect && stageCorrect);
    if (!bucketCorrect || !roleCorrect || !stageCorrect) mismatches.push({
      id: expected.id,
      expected: [expected.expected_bucket, expected.expected_role, expected.expected_stage],
      actual: [bucket, role, stage],
      confidence: ai.confidence
    });
  }
  totals.expected += fixture.evidence.length;
  totals.classified += classified.candidates;
  totals.elapsed_ms += Math.round(performance.now() - started);
  totals.input_tokens += classified.inputTokens;
  totals.output_tokens += classified.outputTokens;
  totals.cases.push({ case_id: fixture.case_id, items: fixture.evidence.length, mismatches });
}
console.log(JSON.stringify(totals, null, 2));
