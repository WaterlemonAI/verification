import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ai7uaeGptInstructions, ai7uaeUntrustedEvidence } from '../lib/ai7uae-gpt-guidelines.mjs';
import { adjudicateGptPartyFacts } from '../lib/ai7uae-gpt-party-facts.mjs';

const defaultFixtures = [
  new URL('../test/fixtures/gpt5-mini-synthetic-case.json', import.meta.url),
  new URL('../test/fixtures/gpt5-mini-adverse-holdout.json', import.meta.url),
  new URL('../test/fixtures/gpt5-mini-party-facts-individual.json', import.meta.url)
];
const args = process.argv.slice(2);
const effortArg = args.indexOf('--reasoning-effort');
const reasoningEffort = effortArg >= 0 ? args[effortArg + 1] : 'minimal';
if (!['minimal', 'low', 'medium'].includes(reasoningEffort)) throw new TypeError('invalid_reasoning_effort');
const idsArg = args.indexOf('--result-ids');
const selectedIds = idsArg >= 0 ? new Set((args[idsArg + 1] || '').split(',').filter(Boolean)) : null;
if (selectedIds && !selectedIds.size) throw new TypeError('invalid_result_ids');
const boundedRetry = args.includes('--bounded-retry');
const paths = args.filter((arg, index) => arg !== '--dry-run' && arg !== '--bounded-retry' && arg !== '--reasoning-effort'
  && (effortArg < 0 || index !== effortArg + 1) && arg !== '--result-ids'
  && (idsArg < 0 || index !== idsArg + 1));
if (selectedIds && paths.length !== 1) throw new TypeError('result_ids_require_one_fixture');
const fixtures = await Promise.all((paths.length ? paths.map((path) => resolve(path)) : defaultFixtures)
  .map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
const dryRun = process.argv.includes('--dry-run');
const endpoint = process.env.AZURE_OPENAI_ENDPOINT || 'https://aoai-ai7uae-uaen-001.openai.azure.com';
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'ai7uae-gpt-5-mini';

const schema = {
  type: 'object', additionalProperties: false, required: ['facts'],
  properties: { facts: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['result_id', 'party_relation', 'acted_party', 'event_kind', 'reported_stage', 'supporting_quote'],
    properties: {
      result_id: { type: 'string' },
      party_relation: { type: 'string', enum: [
        'screened_subject', 'related_party', 'different_entity', 'victim', 'incidental', 'unclear'
      ] },
      acted_party: { type: 'string' },
      event_kind: { type: 'string', enum: [
        'legal_action', 'adverse_allegation', 'material_incident', 'ordinary_event', 'unsupported_claim', 'irrelevant'
      ] },
      reported_stage: { type: 'string', enum: [
        'media_mention', 'allegation', 'investigation', 'arrested', 'charged',
        'convicted', 'regulatory_action', 'settled', 'pardoned'
      ] },
      supporting_quote: { type: 'string' }
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

const token = dryRun ? null : await tokenFromManagedIdentity();
const totals = { calls: 0, input_tokens: 0, output_tokens: 0, elapsed_ms: 0,
  expected_items: 0, exact_items: 0, withheld_items: 0 };
for (const fixture of fixtures) {
  const selectedEvidence = selectedIds ? fixture.evidence.filter((item) => selectedIds.has(item.id)) : fixture.evidence;
  if (selectedIds && selectedEvidence.length !== selectedIds.size) throw new TypeError('unknown_result_id');
  const evidence = selectedEvidence.map(({ expected_bucket, expected_role, expected_stage, ...item }) => item);
  const payload = {
    model: deployment,
    instructions: ai7uaeGptInstructions('edd', 'adverse_media_party_facts') +
      '\n\nFor every supporting_quote, copy one verbatim clause from its own item that contains acted_party and, when a formal stage is reported, the word supporting that stage. If no party is supported, use acted_party="" and party_relation=unclear. Return JSON only.',
    input: 'Extract source facts for this test subject. ' + ai7uaeUntrustedEvidence({ subject: fixture.subject, evidence }),
    reasoning: { effort: reasoningEffort }, max_output_tokens: 4096,
    text: { format: { type: 'json_schema', name: 'party_facts', schema, strict: true } }
  };
  if (dryRun) {
    console.log('CASE_RESULT ' + JSON.stringify({ case_id: fixture.case_id, dry_run: true,
      request_bytes: Buffer.byteLength(JSON.stringify(payload)) }));
    continue;
  }
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
  totals.calls++;
  totals.input_tokens += result.input_tokens;
  totals.output_tokens += result.output_tokens;
  totals.elapsed_ms += result.elapsed_ms;
  totals.expected_items += selectedEvidence.length;
  if (response.ok && body.status === 'completed') {
    const output = body.output_text || (body.output || []).flatMap((item) => item.content || [])
      .map((item) => item.text || '').join('');
    try {
      const parsed = JSON.parse(output);
      const adjudicated = adjudicateGptPartyFacts({ subject: fixture.subject, evidence, facts: parsed.facts });
      const actual = new Map(adjudicated.results.map((item) => [item.result_id, item]));
      const missing = selectedEvidence.filter((item) => !actual.has(item.id));
      if (boundedRetry && missing.length && missing.length <= 3) {
        const retryEvidence = evidence.filter((item) => missing.some((miss) => miss.id === item.id));
        const retryPayload = { ...payload,
          input: 'Extract source facts for this test subject. '
            + ai7uaeUntrustedEvidence({ subject: fixture.subject, evidence: retryEvidence }),
          reasoning: { effort: 'low' }, max_output_tokens: 2048 };
        const retryStarted = performance.now();
        const retryResponse = await fetch(endpoint + '/openai/v1/responses', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(retryPayload), signal: AbortSignal.timeout(90_000)
        });
        const retryBody = await retryResponse.json();
        result.retry = { ids: missing.map((item) => item.id), http: retryResponse.status,
          status: retryBody.status || 'error', elapsed_ms: Math.round(performance.now() - retryStarted),
          input_tokens: retryBody.usage?.input_tokens || 0, output_tokens: retryBody.usage?.output_tokens || 0 };
        totals.calls++;
        totals.elapsed_ms += result.retry.elapsed_ms;
        totals.input_tokens += result.retry.input_tokens;
        totals.output_tokens += result.retry.output_tokens;
        if (retryResponse.ok && retryBody.status === 'completed') {
          const retryText = retryBody.output_text || (retryBody.output || []).flatMap((item) => item.content || [])
            .map((item) => item.text || '').join('');
          try {
            const retryFacts = JSON.parse(retryText).facts;
            const recovered = adjudicateGptPartyFacts({ subject: fixture.subject,
              evidence: retryEvidence, facts: retryFacts });
            for (const item of recovered.results) actual.set(item.result_id, item);
            result.retry.review = recovered.review;
          } catch (error) {
            result.retry.error = String(error.message || error).slice(0, 120);
          }
        }
      }
      result.score = {
        expected_items: selectedEvidence.length,
        exact_items: selectedEvidence.filter((item) => {
          const found = actual.get(item.id);
          return found?.media_bucket === item.expected_bucket && found.subject_role === item.expected_role
            && found.legal_stage === item.expected_stage;
        }).length,
        withheld: selectedEvidence.filter((item) => !actual.has(item.id)).map((item) => ({
          result_id: item.id, reasons: adjudicated.review.filter((entry) => entry.result_id === item.id)
            .flatMap((entry) => entry.reasons)
        })),
        initial_review: adjudicated.review,
        mismatches: selectedEvidence.filter((item) => {
          const found = actual.get(item.id);
          return !found || found.media_bucket !== item.expected_bucket
            || found.subject_role !== item.expected_role || found.legal_stage !== item.expected_stage;
        }).map((item) => ({ id: item.id, expected: [item.expected_bucket, item.expected_role, item.expected_stage],
          actual: actual.get(item.id) ? [actual.get(item.id).media_bucket, actual.get(item.id).subject_role,
            actual.get(item.id).legal_stage] : null,
          fact: parsed.facts.find((fact) => fact.result_id === item.id) || null }))
      };
      totals.exact_items += result.score.exact_items;
      totals.withheld_items += selectedEvidence.length - actual.size;
    } catch (error) {
      result.error = String(error.message || error).slice(0, 160);
    }
  } else {
    result.error = body.error?.code || body.incomplete_details?.reason || 'model_incomplete';
  }
  console.log('CASE_RESULT ' + JSON.stringify(result));
}
console.log('REPLAY_TOTAL ' + JSON.stringify(totals));
