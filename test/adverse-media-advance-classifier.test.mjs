import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceArchiveMediaItems, assessAdvanceScreening, withAdvanceAssessment } from '../lib/adverse-media-advance-classifier.mjs';
import { compileAdvancePolicySet } from '../lib/adverse-media-advance-policy.mjs';

const subject = { entity_type: 'business', name: 'Example Trading LLC' };
const base = { entity: subject, summary: { unresolved_results: 0 },
  coverage: { complete: true, archive_review: { status: 'completed', expected_postings: 0 } },
  media_buckets: { adverse_media: [], general_news_mentions: [], no_impact_media: [] } };
const quote = 'The regulator fined Example Trading LLC, registration 12345, for false accounting.';
const article = { result_id: 'article-1', title: 'Regulator action concerning Example Trading LLC',
  excerpt: quote, url: 'https://publisher.example/story' };
const policySet = compileAdvancePolicySet({ policy_ids: ['FIN-01'] });

function tagFetch(tag, inspect = () => {}) {
  return async (_url, options) => {
    inspect(JSON.parse(options.body));
    const key = JSON.parse(options.body).contents[0].parts[0].text;
    const storyKey = JSON.parse(key).articles[0].story_key;
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events: [
      { story_key: storyKey, adverse_assessment: 'adverse', subject_role: 'direct_actor',
        entity_match: 'confirmed', event_type_ids: ['FIN-01'], severity: 'serious',
        legal_stage: 'regulatory_action', supporting_quote: quote, confidence: 0.95, ...tag }
    ] }) }] } }] });
  };
}

test('fully resolved zero-result screening is Safe without a model call', async () => {
  const result = await assessAdvanceScreening({ response: base, policySet, apiKey: '',
    fetchImpl: () => { throw new Error('model_must_not_run'); } });
  assert.equal(result.evidence_profile.status, 'safe');
  assert.equal(result.policy_outcome.status, 'acceptable');
});

test('a directly supported adverse article with a matching registration is Unsafe', async () => {
  const response = { ...base, media_buckets: { ...base.media_buckets, adverse_media: [article] } };
  const result = await assessAdvanceScreening({ response, policySet,
    identifiers: { registration_numbers: ['12345'] }, apiKey: 'test-key',
    fetchImpl: tagFetch({}, (body) => {
      assert.match(body.systemInstruction.parts[0].text, /untrusted data/);
      assert.doesNotMatch(JSON.stringify(body.contents), /test-key|registration_numbers/);
      const input = JSON.parse(body.contents[0].parts[0].text);
      assert.equal(input.policy_catalog.length, 64);
      assert.deepEqual(input.policy_catalog[0], { id: 'FIN-01', label: 'Fraud' });
      assert.equal(body.generationConfig.responseJsonSchema.properties.events.items.properties.event_type_ids.items.enum, undefined);
    }) });
  assert.equal(result.evidence_profile.status, 'unsafe');
  assert.equal(result.policy_outcome.status, 'escalate');
});

test('Advance can resolve legacy article uncertainty without inheriting stale unresolved counts', async () => {
  const benignQuote = 'Example Trading LLC, registration 12345, opened a new office.';
  const response = { ...base, summary: { unresolved_results: 7 },
    media_buckets: { ...base.media_buckets, general_news_mentions: [{ ...article, excerpt: benignQuote }] } };
  const result = await assessAdvanceScreening({ response, policySet,
    identifiers: { registration_numbers: ['12345'] }, apiKey: 'test-key',
    fetchImpl: tagFetch({ adverse_assessment: 'not_adverse', event_type_ids: [], supporting_quote: benignQuote }) });
  assert.equal(result.evidence_profile.status, 'safe');
  assert.equal(result.policy_outcome.status, 'acceptable');
});

test('a name-only match and missing archive evidence cannot be declared Safe or Unsafe', async () => {
  const response = { ...base, coverage: { ...base.coverage,
    archive_review: { status: 'completed', expected_postings: 1, adverse: 1 } },
  media_buckets: { ...base.media_buckets, adverse_media: [article] } };
  const result = await assessAdvanceScreening({ response, policySet, apiKey: 'test-key',
    fetchImpl: tagFetch({}) });
  assert.equal(result.evidence_profile.status, 'inconclusive');
  assert.equal(result.policy_outcome.status, 'review');
  assert.ok(result.counts.unresolved_stories > 0);
});

test('model failure remains Inconclusive with no second provider attempt', async () => {
  let calls = 0;
  const response = { ...base, media_buckets: { ...base.media_buckets, adverse_media: [article] } };
  const result = await assessAdvanceScreening({ response, policySet, apiKey: 'test-key',
    fetchImpl: async () => { calls++; return new Response('', { status: 503 }); } });
  assert.equal(calls, 1);
  assert.equal(result.evidence_profile.status, 'inconclusive');
  assert.equal(result.classification_completed, false);
});

test('a supported archive direct-actor finding remains Unsafe and is visible in the report evidence', async () => {
  const archiveItem = { record_id: 'archive-1', title: 'Regulator action concerning Example Trading LLC',
    url: 'https://publisher.example/archive-1', publisher: 'Publisher',
    quote: 'The regulator fined Example Trading LLC for false accounting.',
    status: 'adverse', subject_role: 'direct_actor', reason: 'article_party_fact_supported' };
  const response = { ...base, coverage: { ...base.coverage,
    archive_review: { status: 'inconclusive', expected_postings: 2, adverse: 1,
      adverse_sample: [archiveItem], unresolved: 1 } } };
  const assessment = await assessAdvanceScreening({ response, policySet, apiKey: '',
    fetchImpl: () => { throw new Error('model_must_not_run'); } });
  assert.equal(assessment.evidence_profile.status, 'unsafe');
  assert.equal(assessment.evidence_profile.decision_eligible, false);
  const evidence = advanceArchiveMediaItems(response);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].url, archiveItem.url);
  assert.match(evidence[0].excerpt, /fined Example Trading LLC/);
  const final = withAdvanceAssessment({ ...response, usage: { cost_guardrail_usd: 0.15,
    reserved_provider_cost_upper_bound_usd: 0.12 } }, assessment);
  assert.equal(final.summary.profile_status, 'unsafe');
  assert.equal(final.summary.outcome, 'unsafe');
  assert.equal(final.media_buckets.adverse_media.length, 1);
  assert.equal(final.summary.media_bucket_counts.adverse_media, 1);
  assert.equal(final.usage.reserved_provider_cost_upper_bound_usd, 0.12);
  assert.equal(Object.hasOwn(final.usage, 'cost_guardrail_usd'), false);
});

test('a reviewed archive fact using the subject alias cannot be cleared as Safe', async () => {
  const response = { ...base, coverage: { ...base.coverage,
    archive_review: { status: 'completed', expected_postings: 1, adverse: 1,
      adverse_sample: [{ record_id: 'archive-alias', title: 'Regulatory action',
        url: 'https://publisher.example/alias', matched_name: 'ET LLC',
        quote: 'The regulator fined ET LLC for inaccurate accounts.',
        status: 'adverse', subject_role: 'direct_actor', reason: 'article_party_fact_supported' }] } } };
  const assessment = await assessAdvanceScreening({ response, policySet, apiKey: '',
    fetchImpl: () => { throw new Error('model_must_not_run'); } });
  assert.equal(assessment.evidence_profile.status, 'unsafe');
  assert.equal(withAdvanceAssessment(response, assessment).media_buckets.adverse_media[0].identity_match.matched_input, 'ET LLC');
});
