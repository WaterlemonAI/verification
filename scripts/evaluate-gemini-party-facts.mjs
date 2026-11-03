import { readFile } from 'node:fs/promises';
import { ai7uaeGptInstructions, ai7uaeUntrustedEvidence } from '../lib/ai7uae-gpt-guidelines.mjs';
import { adjudicateGptPartyFacts } from '../lib/ai7uae-gpt-party-facts.mjs';

const files = [
  'gpt5-mini-synthetic-case.json',
  'gpt5-mini-adverse-holdout.json',
  'gpt5-mini-party-facts-individual.json',
  'gpt5-mini-party-facts-fresh-holdout.json',
  'gpt5-mini-party-facts-arabic.json'
];
const model = process.argv[2] || 'gemini-3.5-flash';
if (!['gemini-3.5-flash-lite', 'gemini-3.5-flash'].includes(model)) throw new TypeError('unsupported_model');
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is required');

const schema = {
  type: 'object', additionalProperties: false, required: ['facts'],
  properties: { facts: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['result_id', 'party_relation', 'acted_party', 'event_kind', 'reported_stage', 'supporting_quote'],
    properties: {
      result_id: { type: 'string' },
      party_relation: { type: 'string', enum: ['screened_subject', 'related_party', 'different_entity', 'victim', 'incidental', 'unclear'] },
      acted_party: { type: 'string' },
      event_kind: { type: 'string', enum: ['legal_action', 'adverse_allegation', 'material_incident', 'ordinary_event', 'unsupported_claim', 'irrelevant'] },
      reported_stage: { type: 'string', enum: ['media_mention', 'allegation', 'investigation', 'arrested', 'charged', 'convicted', 'regulatory_action', 'settled', 'pardoned'] },
      supporting_quote: { type: 'string' }
    }
  } } }
};
const instructions = ai7uaeGptInstructions('edd', 'adverse_media_party_facts')
  + '\n\nCopy one short verbatim quote containing acted_party from the same item. For a formal stage, include the stage cue in that quote. Return every result_id exactly once or more when distinct parties have separate material actions.';
const totals = { model, expected: 0, exact: 0, withheld: 0, calls: 0, input_tokens: 0,
  output_tokens: 0, elapsed_ms: 0, cases: [] };

async function classify(subject, evidence, retry = false) {
  const payload = {
    systemInstruction: { parts: [{ text: instructions }] },
    contents: [{ role: 'user', parts: [{ text: 'Extract source facts for this test subject. '
      + ai7uaeUntrustedEvidence({ subject, evidence }) }] }],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema,
      maxOutputTokens: retry ? 2048 : 4096, thinkingConfig: { thinkingLevel: retry ? 'low' : 'minimal' } }
  };
  const started = performance.now();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(45_000)
  });
  const body = await response.json();
  totals.calls += 1;
  totals.elapsed_ms += Math.round(performance.now() - started);
  totals.input_tokens += body.usageMetadata?.promptTokenCount || 0;
  totals.output_tokens += (body.usageMetadata?.candidatesTokenCount || 0) + (body.usageMetadata?.thoughtsTokenCount || 0);
  if (!response.ok) throw new Error(`gemini_http_${response.status}:${body.error?.message || 'unknown'}`);
  const content = body.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return JSON.parse(content).facts;
}

for (const file of files) {
  const fixture = JSON.parse(await readFile(new URL(`../test/fixtures/${file}`, import.meta.url), 'utf8'));
  const evidence = fixture.evidence.map(({ expected_bucket, expected_role, expected_stage, ...item }) => item);
  const result = { case_id: fixture.case_id, expected: evidence.length, mismatches: [], review: [] };
  totals.expected += evidence.length;
  try {
    const facts = await classify(fixture.subject, evidence);
    const adjudicated = adjudicateGptPartyFacts({ subject: fixture.subject, evidence, facts });
    const actual = new Map(adjudicated.results.map((item) => [item.result_id, item]));
    result.review.push(...adjudicated.review);
    const missing = evidence.filter((item) => !actual.has(item.id));
    if (missing.length && missing.length <= 3) {
      try {
        const selected = missing.map((item) => item.id);
        const retryEvidence = evidence.filter((item) => selected.includes(item.id));
        const retried = adjudicateGptPartyFacts({ subject: fixture.subject, evidence: retryEvidence,
          facts: await classify(fixture.subject, retryEvidence, true) });
        for (const item of retried.results) actual.set(item.result_id, item);
        result.review.push(...retried.review);
      } catch (error) { result.retry_error = String(error.message || error).slice(0, 120); }
    }
    result.mismatches = fixture.evidence.filter((item) => {
      const found = actual.get(item.id);
      return found?.media_bucket !== item.expected_bucket || found.subject_role !== item.expected_role
        || found.legal_stage !== item.expected_stage;
    }).map((item) => ({ id: item.id,
      expected: [item.expected_bucket, item.expected_role, item.expected_stage],
      actual: actual.get(item.id) ? [actual.get(item.id).media_bucket, actual.get(item.id).subject_role,
        actual.get(item.id).legal_stage] : null }));
    result.withheld = evidence.filter((item) => !actual.has(item.id)).map((item) => item.id);
    totals.exact += evidence.length - result.mismatches.length;
    totals.withheld += result.withheld.length;
  } catch (error) {
    result.error = String(error.message || error).slice(0, 160);
    totals.withheld += evidence.length;
  }
  totals.cases.push(result);
}
console.log(JSON.stringify(totals, null, 2));
