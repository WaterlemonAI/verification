import assert from 'node:assert/strict';
import test from 'node:test';
import { createGptAdverseClassifier } from '../lib/ai7uae-gpt-adverse-api.mjs';

test('GPT party-fact adapter keeps a broker penalty off the screened company', async () => {
  const classify = createGptAdverseClassifier({
    credential: { getToken: async () => ({ token: 'synthetic-managed-token' }) },
    endpoint: 'https://aoai-ai7uae-uaen-001.openai.azure.com'
  });
  const results = [{
    result_id: 'R1', title: 'Example Ltd fined after share trading',
    excerpt: 'Regulator fined brokers who traded shares in Example Ltd.',
    publisher: 'Synthetic News', url: 'https://example.test/r1',
    categories: ['regulatory_and_governance']
  }];
  const request = { entity_type: 'business', name: 'Example Ltd', aliases: [], countries: ['AE'] };
  const calls = [];
  const outcome = await classify(results, request, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    return Response.json({ status: 'completed', output_text: JSON.stringify({ facts: [{
      result_id: 'R1', party_relation: 'related_party', acted_party: 'brokers',
      event_kind: 'legal_action', reported_stage: 'regulatory_action',
      supporting_quote: 'Regulator fined brokers who traded shares in Example Ltd.'
    }] }), usage: { input_tokens: 100, output_tokens: 20 } });
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'ai7uae-gpt-5-mini');
  assert.equal(calls[0].text.format.strict, true);
  assert.match(calls[0].instructions, /headline cannot override/i);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.results[0].ai_classification.subject_role, 'related_party');
  assert.equal(outcome.results[0].ai_classification.media_bucket, 'general_news_mentions');
  assert.equal(outcome.results[0].ai_classification.legal_stage, 'media_mention');
});

test('unsupported GPT quotes are withheld for human review', async () => {
  const classify = createGptAdverseClassifier({
    credential: { getToken: async () => ({ token: 'synthetic-managed-token' }) }
  });
  const results = [{ result_id: 'R2', title: 'Example Ltd opens an office',
    excerpt: 'Example Ltd announced a new office.', url: 'https://example.test/r2', categories: [] }];
  const request = { entity_type: 'business', name: 'Example Ltd', aliases: [], countries: [] };
  const outcome = await classify(results, request, { fetchImpl: async () => Response.json({
    status: 'completed', output_text: JSON.stringify({ facts: [{
      result_id: 'R2', party_relation: 'screened_subject', acted_party: 'Example Ltd',
      event_kind: 'legal_action', reported_stage: 'charged', supporting_quote: 'Example Ltd was charged with fraud.'
    }] }), usage: { input_tokens: 100, output_tokens: 20 }
  }) });
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.results[0].ai_classification, undefined);
  assert.equal(outcome.candidates, 1);
});

test('publisher markup does not break a verbatim supported allegation', async () => {
  const classify = createGptAdverseClassifier({
    credential: { getToken: async () => ({ token: 'synthetic-managed-token' }) }
  });
  const results = [{ result_id: 'R3', title: 'Nirav Modi PNB case',
    excerpt: '<strong>Nirav Modi was charged</strong> by Indian authorities for bank fraud.',
    publisher: 'Synthetic News', url: 'https://example.test/r3', categories: ['fraud'] }];
  const request = { entity_type: 'individual', name: 'Nirav Modi', aliases: [], countries: ['IN'] };
  let sent;
  const outcome = await classify(results, request, { fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ status: 'completed', output_text: JSON.stringify({ facts: [{
      result_id: 'R3', party_relation: 'screened_subject', acted_party: 'Nirav Modi',
      event_kind: 'legal_action', reported_stage: 'charged',
      supporting_quote: 'Nirav Modi was charged by Indian authorities for bank fraud.'
    }] }), usage: { input_tokens: 100, output_tokens: 30 } });
  } });
  assert.doesNotMatch(sent.input, /<strong>/);
  assert.match(sent.input, /Nirav Modi was charged by Indian authorities/);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.results[0].ai_classification.media_bucket, 'adverse_media');
});

test('large batches retry omitted facts in bounded groups without relaxing grounding', async () => {
  const classify = createGptAdverseClassifier({
    credential: { getToken: async () => ({ token: 'synthetic-managed-token' }) }
  });
  const results = Array.from({ length: 8 }, (_, index) => ({
    result_id: `R${index + 1}`, title: `Example Ltd charged in case ${index + 1}`,
    excerpt: `Example Ltd charged in case ${index + 1}.`,
    publisher: 'Synthetic News', url: `https://example.test/r${index + 1}`, categories: ['fraud']
  }));
  const request = { entity_type: 'business', name: 'Example Ltd', aliases: [], countries: [] };
  const callSizes = [];
  const outcome = await classify(results, request, { fetchImpl: async (_url, options) => {
    const input = JSON.parse(options.body).input;
    const selected = results.filter((item) => input.includes(`"id":"${item.result_id}"`));
    callSizes.push(selected.length);
    const returned = callSizes.length === 1 ? selected.slice(0, 1) : selected;
    return Response.json({ status: 'completed', output_text: JSON.stringify({ facts: returned.map((item) => ({
      result_id: item.result_id, party_relation: 'screened_subject', acted_party: 'Example Ltd',
      event_kind: 'legal_action', reported_stage: 'charged', supporting_quote: item.title
    })) }), usage: { input_tokens: 100, output_tokens: 30 } });
  } });
  assert.deepEqual(callSizes, [8, 3, 3, 1]);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.results.filter((item) => item.ai_classification?.media_bucket === 'adverse_media').length, 8);
});
