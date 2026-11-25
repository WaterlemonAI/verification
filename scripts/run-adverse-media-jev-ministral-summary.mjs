import { readFileSync, writeFileSync } from 'node:fs';
import { createMinistralJevSummary } from '../lib/adverse-media-jev-ministral-summary.mjs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath || inputPath === outputPath)
  throw new Error('usage: MISTRAL_API_KEY=... node scripts/run-adverse-media-jev-ministral-summary.mjs finalized.json summarized.json');
const response = JSON.parse(readFileSync(inputPath, 'utf8'));
const result = await createMinistralJevSummary({ response, apiKey: process.env.MISTRAL_API_KEY });
const output = { ...response, report_narrative: { source: 'ministral_3b_with_verified_counts', summary: result.summary } };
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ output: outputPath, model: result.model, usage: result.usage,
  estimated_cost_usd_upper: Number(((result.usage.prompt_tokens + result.usage.completion_tokens) * 0.10 / 1_000_000).toFixed(8)) }) + '\n');
