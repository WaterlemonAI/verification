import { readFile } from 'node:fs/promises';
import { ai7uaeGptInstructions, ai7uaeUntrustedEvidence } from '../lib/ai7uae-gpt-guidelines.mjs';

const fixture = JSON.parse(await readFile(new URL('../test/fixtures/gpt5-mini-synthetic-case.json', import.meta.url), 'utf8'));
const endpoint = process.env.AZURE_OPENAI_ENDPOINT || 'https://aoai-ai7uae-uaen-001.openai.azure.com';
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'ai7uae-gpt-5-mini';
const dryRun = process.argv.includes('--dry-run');
const refined = process.argv.includes('--refined');

async function credential() {
  const url = new URL(process.env.IDENTITY_ENDPOINT);
  url.searchParams.set('api-version', '2019-08-01');
  url.searchParams.set('resource', 'https://cognitiveservices.azure.com/');
  url.searchParams.set('client_id', process.env.RUNTIME_IDENTITY_CLIENT_ID);
  const response = await fetch(url, { headers: {
    'x-identity-header': process.env.IDENTITY_HEADER, metadata: 'true'
  } });
  if (!response.ok) throw new Error('managed_identity_failed_' + response.status);
  return (await response.json()).access_token;
}

const token = dryRun ? null : await credential();
const results = [];
async function call(label, evidence, schema, taskInstructions, workflow) {
  const payload = {
    model: deployment,
    instructions: ai7uaeGptInstructions('edd', workflow) + (taskInstructions ? '\n\n' + taskInstructions : ''),
    input: 'Process this fictional test evidence only. ' + ai7uaeUntrustedEvidence(evidence),
    reasoning: { effort: 'minimal' },
    max_output_tokens: 2048,
    text: { format: { type: 'json_schema', name: label, schema, strict: true } }
  };
  if (dryRun) return { label, dry_run: true, request_bytes: Buffer.byteLength(JSON.stringify(payload)) };
  const started = performance.now();
  const response = await fetch(endpoint + '/openai/v1/responses', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000)
  });
  const body = await response.json();
  const text = body.output_text || (body.output || []).flatMap((item) => item.content || [])
    .map((item) => item.text || '').join('');
  const result = { label, http: response.status, status: body.status || 'error',
    elapsed_ms: Math.round(performance.now() - started),
    input_tokens: body.usage?.input_tokens || 0, output_tokens: body.usage?.output_tokens || 0,
    error_code: body.error?.code || null };
  if (response.ok && body.status === 'completed') {
    try { result.value = JSON.parse(text); } catch { result.status = 'invalid_json'; }
  }
  return result;
}

const transliterationSchema = {
  type: 'object', additionalProperties: false, required: ['transliterations'],
  properties: { transliterations: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['language', 'variants'],
    properties: { language: { type: 'string', enum: ['ar'] },
      variants: { type: 'array', items: { type: 'string' } } }
  } } }
};
const transliteration = await call('transliteration', {
  entity: { type: 'individual', name: 'Mira Vale', aliases: [] },
  target_languages: [{ code: 'ar', name: 'Arabic' }]
}, transliterationSchema,
  'Produce exactly two plausible Arabic-script written variants of the same individual name. Do not translate, explain, or invent an identity.');
if (transliteration.value) {
  const rows = transliteration.value.transliterations;
  transliteration.score = { one_language: rows.length === 1 && rows[0].language === 'ar',
    two_distinct_variants: rows[0]?.variants?.length === 2
      && new Set(rows[0].variants).size === 2,
    arabic_script: rows[0]?.variants?.every((value) => /[\u0600-\u06ff]/u.test(value)) };
}
results.push(transliteration);
console.log('CASE_RESULT ' + JSON.stringify(transliteration));

const associationSchema = {
  type: 'object', additionalProperties: false, required: ['search_terms'],
  properties: { search_terms: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['value', 'type'],
    properties: { value: { type: 'string' }, type: { type: 'string', enum: ['alias', 'organization'] } }
  } } }
};
const association = await call('association', {
  subject: { type: 'individual', name: 'Mira Vale' },
  snippets: [
    { id: 'S1', text: 'Mira Vale founded Cedar Dune Trading LLC in this fictional test case.' },
    { id: 'S2', text: 'Another person named Mira Vale is a singer and has no stated connection to the company.' }
  ]
}, associationSchema,
  refined ? '' : 'Extract only an explicitly stated alias or organization founded, owned, led, or employing the specified person. Do not infer a relationship from a similar name.',
  refined ? 'association_resolution' : undefined);
if (association.value) {
  association.score = { expected_organization: association.value.search_terms.some((item) =>
    item.type === 'organization' && item.value === 'Cedar Dune Trading LLC'),
  unsupported_terms: association.value.search_terms.filter((item) => item.value !== 'Cedar Dune Trading LLC') };
}
results.push(association);
console.log('CASE_RESULT ' + JSON.stringify(association));

const narrativeSchema = {
  type: 'object', additionalProperties: false, required: ['summary', 'findings', 'recommendations'],
  properties: { summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } } }
};
const narrative = await call('audit_narrative', {
  entity: fixture.subject,
  screening_outcome: 'review_required',
  source_coverage_complete: false,
  evidence: fixture.evidence.filter((item) => ['R1', 'R3', 'R5'].includes(item.id))
    .map(({ expected_bucket, expected_role, expected_stage, ...item }) => item)
}, narrativeSchema,
  refined ? '' : 'Write a neutral adverse-media audit summary using only the supplied screening output. Distinguish company action from director personal action, do not call layoffs fraud, do not claim complete coverage, and require human review.',
  refined ? 'audit_narrative' : undefined);
if (narrative.value) {
  const joined = JSON.stringify(narrative.value).toLowerCase();
  narrative.score = { mentions_human_review: /human review|manual review|reviewer/.test(joined),
    notes_incomplete_coverage: /incomplete|partial|not complete|coverage/.test(joined),
    avoids_fraud_label: !/fraudulent|committed fraud|fraud conviction/.test(joined) };
}
results.push(narrative);
console.log('CASE_RESULT ' + JSON.stringify(narrative));

console.log('REPLAY_TOTAL ' + JSON.stringify(results.reduce((sum, item) => ({
  calls: sum.calls + !item.dry_run,
  input_tokens: sum.input_tokens + (item.input_tokens || 0),
  output_tokens: sum.output_tokens + (item.output_tokens || 0),
  elapsed_ms: sum.elapsed_ms + (item.elapsed_ms || 0)
}), { calls: 0, input_tokens: 0, output_tokens: 0, elapsed_ms: 0 })));
