import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createScreeningCostGuard } from '../lib/screening-cost-guard.mjs';
import { presentAdverseMediaResponse, screenAdverseMedia, validateAdverseMediaRequest } from '../lib/adverse-media.mjs';

const cases = [
  { name: 'PT Petrindo Jaya Kreasi Tbk', aliases: ['CUAN'], countries: ['ID'], languages: ['en', 'id'] },
  { name: 'PT Dian Swastatika Sentosa Tbk', aliases: ['DSSA'], countries: ['ID'], languages: ['en', 'id'] },
  { name: 'PT Barito Renewables Energy Tbk', aliases: ['BREN'], countries: ['ID'], languages: ['en', 'id'] },
  { name: 'Signzy', aliases: [], countries: ['IN'], languages: ['en', 'hi'] },
  { name: 'eMudhra', aliases: [], countries: ['IN'], languages: ['en', 'hi'] },
  { name: 'Smilesville Trading', aliases: [], countries: ['AE'], languages: ['en', 'ar'] }
];

const braveKey = process.env.BRAVE_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
if (!braveKey || !geminiKey) throw new Error('BRAVE_API_KEY and GEMINI_API_KEY must be set');
const selected = process.argv[2] === 'all' ? cases : cases.filter((_, index) => index === Number(process.argv[2]));
if (!selected.length) throw new Error('Choose all or a zero-based case number');

const records = [];
for (const item of selected) {
  const input = {
    entity_type: 'business', ...item, search_plus: true, max_results: 25,
    review_threshold_percent: 65, high_risk_threshold_percent: 90
  };
  const request = validateAdverseMediaRequest(input);
  const costGuard = createScreeningCostGuard(fetch);
  const started = performance.now();
  try {
    const raw = await screenAdverseMedia({ request, apiKey: braveKey, aiApiKey: geminiKey, costGuard });
    const response = presentAdverseMediaResponse(raw);
    const record = { input, duration_ms: Math.round(performance.now() - started),
      provider_calls: costGuard.providerCalls, reserved_provider_cost_usd: costGuard.reservedProviderCostUsd,
      response };
    records.push(record);
    process.stdout.write(`${JSON.stringify({
      subject: item.name, duration_ms: record.duration_ms, status: response.status,
      profile_status: response.summary?.profile_status, decision_eligible: response.summary?.decision_eligible,
      bucket_counts: response.summary?.media_bucket_counts, provider_calls: record.provider_calls,
      cost_upper_bound_usd: record.reserved_provider_cost_usd,
      coverage_reason_codes: response.coverage?.reason_codes,
      ai_status: raw.methodology?.ai_classification?.status
    })}\n`);
  } catch (error) {
    const record = { input, duration_ms: Math.round(performance.now() - started),
      provider_calls: costGuard.providerCalls, reserved_provider_cost_usd: costGuard.reservedProviderCostUsd,
      error: { message: error.message, status_code: error.statusCode, source_failures: error.sourceFailures } };
    records.push(record);
    process.stdout.write(`${JSON.stringify({ subject: item.name, error: record.error, duration_ms: record.duration_ms,
      provider_calls: record.provider_calls, cost_upper_bound_usd: record.reserved_provider_cost_usd })}\n`);
  }
}
const output = process.env.BENCHMARK_OUTPUT || '/tmp/ai7-six-adverse-media.json';
await writeFile(output, JSON.stringify({ generated_at: new Date().toISOString(), records }, null, 2));
process.stdout.write(`${JSON.stringify({ output, cases: records.length })}\n`);
