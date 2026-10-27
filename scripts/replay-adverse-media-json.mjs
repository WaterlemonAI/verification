import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyWithAi, mediaBucket, resolveLegalStage, sourceReliability } from '../lib/adverse-media.mjs';
import { createScreeningCostGuard } from '../lib/screening-cost-guard.mjs';

const [inputDir, outputFile, onlyName] = process.argv.slice(2);
if (!inputDir || !outputFile || !process.env.GEMINI_API_KEY) {
  throw new Error('Usage: GEMINI_API_KEY=<configured key> node scripts/replay-adverse-media-json.mjs <extracted-report-dir> <output.json>');
}

const manifest = JSON.parse(await readFile(join(inputDir, 'manifest.json'), 'utf8'));
const reports = new Map();
for (const entry of manifest) {
  const request = JSON.parse(await readFile(join(inputDir, 'requests', `${entry.report_id}.json`), 'utf8'));
  const response = JSON.parse(await readFile(join(inputDir, 'json', `${entry.report_id}.json`), 'utf8'));
  if (request.name !== response.entity?.name || entry.screening_id !== response.screening_id) {
    throw new Error(`Report attachment mismatch: ${entry.report_id}`);
  }
  const current = reports.get(request.name);
  if (!current || response.completed_at < current.response.completed_at) reports.set(request.name, { request, response });
}

const output = [];
for (const [name, { request, response }] of reports) {
  if (onlyName && name !== onlyName) continue;
  const guard = createScreeningCostGuard(fetch);
  const classified = [];
  let classificationError = null;
  try {
    const evidence = response.results.map((item) => ({ ...item,
      source_reliability_score: sourceReliability(new URL(item.url).hostname) }));
    const result = await classifyWithAi(evidence, request, process.env.GEMINI_API_KEY,
      guard.fetch, null, response.screening_id);
    classified.push(...result.results);
  } catch (error) {
    classificationError = String(error?.message || error).slice(0, 100);
  }
  const assessed = classified.length === response.results.length
    && classified.every((item) => item.ai_classification?.confidence >= 0.75
      && item.ai_classification.subject_role !== 'unclear');
  const buckets = { adverse_media: [], general_news_mentions: [], no_impact_media: [] };
  for (const item of classified) {
    const classification = item.ai_classification;
    buckets[mediaBucket(item, response.entity)].push({
      title: item.title, url: item.url, publisher: item.publisher,
      score: item.risk_score, subject_role: classification.subject_role,
      adverse_assessment: classification.adverse, entity_match: classification.entity_match,
      legal_stage: resolveLegalStage(item, response.entity), confidence: classification.confidence,
      assessment: classification.summary
    });
  }
  const threshold = Number(request.review_threshold_percent || response.summary?.thresholds?.review_percent || 65) / 100;
  const sourceReasons = (response.coverage?.reason_codes || []).filter((reason) =>
    !['classification_incomplete', 'classification_uncertain'].includes(reason));
  const sourceComplete = sourceReasons.length === 0 && (response.coverage?.sources || []).every((source) =>
    ['complete', 'not_requested'].includes(source.status));
  const status = sourceComplete && assessed ? 'completed' : 'partial';
  const profile = status !== 'completed' ? 'inconclusive'
    : buckets.adverse_media.some((item) => item.score >= threshold) ? 'unsafe' : 'safe';
  output.push({
    name, entity_type: request.entity_type, screening_id: response.screening_id,
    prior_status: response.status, prior_outcome: response.summary?.outcome,
    prior_hit_count: response.results.length, status, profile, review_threshold: threshold,
    classified_hits: classified.length, gemini_calls: guard.providerCalls.gemini,
    reserved_provider_cost_usd: guard.reservedProviderCostUsd,
    classification_error: classificationError, bucket_counts: Object.fromEntries(
      Object.entries(buckets).map(([key, items]) => [key, items.length])), buckets
  });
  process.stdout.write(`${output.length}/${onlyName ? 1 : reports.size} ${name}: ${status}, ${profile}, ${classified.length}/${response.results.length} classified\n`);
  await writeFile(outputFile, JSON.stringify({ generated_at: new Date().toISOString(),
    method: 'saved_evidence_gemini_reclassification_no_search', cases: output }, null, 2));
}
