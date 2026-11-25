import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMinistralJevSummary, ministralSummaryEvidence, MINISTRAL_MODEL } from '../lib/adverse-media-jev-ministral-summary.mjs';

const response = {
  contract: 'advance-jev-integrated-test-v1',
  subject: { name: 'Example Trading' },
  period: { from: '2026-11-01', to: '2026-11-25' },
  coverage: { omitted_due_to_test_limit: 2 },
  event_register: {
    articles: [{ story_key: 'a', incident_id: 'i', title: 'Fraud case update',
      excerpt: 'A company faces an allegation.', url: 'https://example.test/a',
      jev_review: { association_probability: 0.9 }, adverseness: 'adverse', relationship: 'direct' }],
    incidents: [{ incident_id: 'i', story_keys: ['a'] }]
  }
};

test('summary prompt contains finalized evidence but no provider traces or URLs', async () => {
  const evidence = ministralSummaryEvidence(response);
  assert.equal(evidence.incidents[0].label, 'Incident 1');
  assert.equal(evidence.counts.omitted_due_to_test_limit, 2);
  assert.equal(JSON.stringify(evidence).includes('association_probability'), false);
  assert.equal(JSON.stringify(evidence).includes('https://'), false);
  let request;
  const fetchImpl = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ model: MINISTRAL_MODEL,
      choices: [{ message: { content: '{"theme":"A reported fraud case update"}' } }],
      usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 } }) };
  };
  const result = await createMinistralJevSummary({ response, apiKey: 'test', fetchImpl });
  assert.equal(request.response_format.type, 'json_schema');
  assert.deepEqual(request.response_format.json_schema.schema.required, ['theme']);
  assert.equal(request.model, MINISTRAL_MODEL);
  assert.equal(result.usage.total_tokens, 230);
  assert.match(result.summary, /1 retained article: 1 in 1 incident group and 0 unassigned/);
  assert.match(result.summary, /Coverage concerns a reported fraud case update/);
  assert.match(result.summary, /test limit omitted 2 additional articles/);
});

test('summary rejects unexpected schema and provider references', async () => {
  for (const content of ['{"theme":"Coverage concerns fraud.","classification":"adverse"}',
    '{"theme":"Coverage concerns Jev results."}', '{"theme":"Coverage concerns 2 incidents."}']) {
    await assert.rejects(() => createMinistralJevSummary({ response, apiKey: 'test',
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }) }),
    /validation|schema/);
  }
});

test('summary accepts a model number that is part of an incident name', async () => {
  const result = await createMinistralJevSummary({ response, apiKey: 'test',
    fetchImpl: async () => ({ ok: true, json: async () => ({
      choices: [{ message: { content: '{"theme":"Boeing 737 MAX safety allegations"}' } }]
    }) }) });
  assert.match(result.summary, /Boeing 737 MAX safety allegations/);
});

test('zero incident report makes no unsupported narrative claim', async () => {
  const neutral = { ...response, event_register: {
    articles: [{ ...response.event_register.articles[0], incident_id: null,
      adverseness: 'non-adverse' }], incidents: [] } };
  const result = await createMinistralJevSummary({ response: neutral, apiKey: 'test',
    fetchImpl: () => { throw new Error('summary API must not be called'); } });
  assert.match(result.summary, /No specific adverse incident group was established/);
  assert.equal(result.usage.total_tokens, 0);
});
