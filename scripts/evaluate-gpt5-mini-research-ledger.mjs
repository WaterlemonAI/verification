import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ai7uaeGptInstructions, ai7uaeUntrustedEvidence } from '../lib/ai7uae-gpt-guidelines.mjs';
import { validateGptSourceLedger } from '../lib/ai7uae-gpt-source-ledger.mjs';

const fixtureArg = process.argv.slice(2).find((arg) => arg !== '--dry-run');
const fixture = JSON.parse(await readFile(fixtureArg ? resolve(fixtureArg)
  : new URL('../test/fixtures/gpt5-mini-research-ledger.json', import.meta.url), 'utf8'));
const dryRun = process.argv.includes('--dry-run');
const endpoint = process.env.AZURE_OPENAI_ENDPOINT || 'https://aoai-ai7uae-uaen-001.openai.azure.com';
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'ai7uae-gpt-5-mini';
const schema = {
  type: 'object', additionalProperties: false, required: ['observations'],
  properties: { observations: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['source_id', 'acted_party', 'action_kind', 'supporting_quote', 'headline_disputed'],
    properties: {
      source_id: { type: 'string' }, acted_party: { type: 'string' },
      action_kind: { type: 'string', enum: [
        'formal_action', 'allegation', 'material_incident', 'ordinary_news', 'unsupported_claim', 'none'
      ] },
      supporting_quote: { type: 'string' }, headline_disputed: { type: 'boolean' }
    }
  } } }
};

async function tokenFromManagedIdentity() {
  if (!process.env.IDENTITY_ENDPOINT || !process.env.IDENTITY_HEADER || !process.env.RUNTIME_IDENTITY_CLIENT_ID) {
    throw new Error('managed_identity_required');
  }
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

const sources = fixture.sources.map(({ expected_party, expected_kind, expected_headline_disputed, ...item }) => item);
const payload = {
  model: deployment,
  instructions: ai7uaeGptInstructions('research', 'source_ledger') +
    '\n\nCopy a short supporting_quote containing acted_party exactly from each source. Use the excerpt and any cited notice described there to decide who was acted against. Return observations for every source ID exactly once.',
  input: 'Create a source ledger for this test case. ' + ai7uaeUntrustedEvidence({ subject: fixture.subject, sources }),
  reasoning: { effort: 'minimal' }, max_output_tokens: 2048,
  text: { format: { type: 'json_schema', name: 'source_ledger', schema, strict: true } }
};
if (dryRun) {
  console.log('DRY_RUN ' + JSON.stringify({ case_id: fixture.case_id,
    request_bytes: Buffer.byteLength(JSON.stringify(payload)) }));
  process.exit(0);
}
const token = await tokenFromManagedIdentity();
const started = performance.now();
const response = await fetch(endpoint + '/openai/v1/responses', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000)
});
const body = await response.json();
const result = { case_id: fixture.case_id, http: response.status, status: body.status || 'error',
  elapsed_ms: Math.round(performance.now() - started),
  input_tokens: body.usage?.input_tokens || 0, output_tokens: body.usage?.output_tokens || 0,
  reasoning_tokens: body.usage?.output_tokens_details?.reasoning_tokens || 0 };
if (response.ok && body.status === 'completed') {
  const output = body.output_text || (body.output || []).flatMap((item) => item.content || [])
    .map((item) => item.text || '').join('');
  try {
    const parsed = JSON.parse(output);
    const ledger = validateGptSourceLedger({ sources, observations: parsed.observations,
      verifiedEventRefs: fixture.verified_event_refs });
    const actual = new Map(ledger.observations.map((item) => [item.source_id, item]));
    result.score = { expected_sources: fixture.sources.length,
      accepted_sources: ledger.observations.length,
      exact_sources: fixture.sources.filter((item) => {
        const found = actual.get(item.id);
        return found && found.acted_party.toLowerCase().includes(item.expected_party.toLowerCase())
          && found.action_kind === item.expected_kind
          && found.headline_disputed === item.expected_headline_disputed;
      }).length,
      linked_events: ledger.linked_events,
      review: ledger.review,
      mismatches: fixture.sources.filter((item) => {
        const found = actual.get(item.id);
        return !found || !found.acted_party.toLowerCase().includes(item.expected_party.toLowerCase())
          || found.action_kind !== item.expected_kind
          || found.headline_disputed !== item.expected_headline_disputed;
      }).map((item) => ({ id: item.id, expected: [item.expected_party, item.expected_kind,
        item.expected_headline_disputed], actual: actual.get(item.id) ? [actual.get(item.id).acted_party,
        actual.get(item.id).action_kind, actual.get(item.id).headline_disputed,
        actual.get(item.id).supporting_quote] : null })) };
  } catch (error) {
    result.error = String(error.message || error).slice(0, 160);
  }
} else {
  result.error = body.error?.code || body.incomplete_details?.reason || 'model_incomplete';
}
console.log('CASE_RESULT ' + JSON.stringify(result));
