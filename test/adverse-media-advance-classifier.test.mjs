import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceArchiveMediaItems, assessAdvanceScreening as assessScreening, withAdvanceAssessment } from '../lib/adverse-media-advance-classifier.mjs';
import { compileAdvancePolicySet } from '../lib/adverse-media-advance-policy.mjs';
import { createAdverseMediaNarrative } from '../lib/adverse-media-report.mjs';

const subject = { entity_type: 'business', name: 'Example Trading LLC' };
const base = { entity: subject, summary: { unresolved_results: 0 },
  coverage: { complete: true, archive_review: { status: 'completed', expected_postings: 0 } },
  media_buckets: { adverse_media: [], general_news_mentions: [], no_impact_media: [] } };
const quote = 'The regulator fined Example Trading LLC, registration 12345, for false accounting.';
const article = { result_id: 'article-1', title: 'Regulator action concerning Example Trading LLC',
  excerpt: quote, url: 'https://publisher.example/story' };
const policySet = compileAdvancePolicySet({ policy_ids: ['FIN-01'] });

// Test only: emulate a verified article body containing the quoted source text.
function assessAdvanceScreening(options) {
  return assessScreening({ extractArticle: async (item) => ({ text: item.text }), ...options });
}

function tagFetch(tag, inspect = () => {}, sourceQuote = quote) {
  return async (_url, options) => {
    inspect(JSON.parse(options.body));
    const key = JSON.parse(options.body).contents[0].parts[0].text;
    const storyKey = JSON.parse(key).articles[0].story_key;
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events: [
      { story_key: storyKey, adverse_assessment: 'adverse', subject_role: 'direct_actor',
        entity_match: 'confirmed', event_type_ids: ['FIN-01'], severity: 'serious',
        legal_stage: 'regulatory_action', supporting_quote: sourceQuote, confidence: 0.95,
        subject_relationship: tag.subject_role === 'namesake' ? 'indirect' : 'direct',
        report_priority: 80, ...tag }
    ] }) }] } }] });
  };
}

test('fully resolved zero-result screening is Safe without a model call', async () => {
  const result = await assessAdvanceScreening({ response: base, policySet, apiKey: '',
    fetchImpl: () => { throw new Error('model_must_not_run'); } });
  assert.equal(result.evidence_profile.status, 'safe');
  assert.equal(result.policy_outcome.status, 'acceptable');
});

test('Advance JSON omits the Official records coverage field from an older response', async () => {
  const response = { ...base, coverage: { ...base.coverage, sources: [
    { source: 'open_web', status: 'complete' },
    { source: 'official_records', status: 'not_requested' }
  ] } };
  const assessment = await assessAdvanceScreening({ response, policySet, apiKey: '' });
  assert.deepEqual(withAdvanceAssessment(response, assessment).coverage.sources,
    [{ source: 'open_web', status: 'complete' }]);
});

test('a directly supported adverse article with a matching registration is Unsafe', async () => {
  const response = { ...base, media_buckets: { ...base.media_buckets, adverse_media: [article] } };
  const result = await assessAdvanceScreening({ response, policySet,
    identifiers: { registration_numbers: ['12345'] }, apiKey: 'test-key',
    fetchImpl: tagFetch({}, (body) => {
      assert.match(body.systemInstruction.parts[0].text, /untrusted data/);
      assert.match(body.systemInstruction.parts[0].text, /one continuous 12 to 600 character span/);
      assert.doesNotMatch(JSON.stringify(body.contents), /test-key|registration_numbers/);
      const input = JSON.parse(body.contents[0].parts[0].text);
      assert.equal(input.policy_catalog.length, 64);
      assert.deepEqual(input.policy_catalog[0], { id: 'FIN-01', label: 'Fraud' });
      assert.equal(body.generationConfig.responseJsonSchema.properties.events.items.properties.event_type_ids.items.enum, undefined);
    }) });
  assert.equal(result.evidence_profile.status, 'unsafe');
  assert.equal(result.policy_outcome.status, 'escalate');
});

test('a documented breach victim is Direct adverse media and makes the profile Unsafe without alleging culpability', async () => {
  const breachQuote = 'Example Trading LLC disclosed a data breach affecting customer records.';
  const response = { ...base, media_buckets: { ...base.media_buckets,
    adverse_media: [{ ...article, title: 'Example Trading LLC data breach', excerpt: breachQuote }] } };
  const result = await assessAdvanceScreening({ response,
    policySet: compileAdvancePolicySet({ policy_ids: ['CYB-05'] }), apiKey: 'test-key',
    fetchImpl: tagFetch({ adverse_assessment: 'adverse', subject_role: 'victim',
      subject_relationship: 'direct', entity_match: 'confirmed', event_type_ids: ['CYB-05'],
      severity: 'moderate', legal_stage: 'media_mention', supporting_quote: breachQuote },
    () => {}, breachQuote) });
  assert.equal(result.evidence_register[0].subject_relationship, 'direct');
  assert.equal(result.evidence_register[0].ai7_edd_review_status, 'reviewed');
  assert.equal(result.finding_decisions[0].status, 'confirmed_event');
  assert.equal(result.evidence_profile.status, 'unsafe');
  assert.equal(result.report_selection.selected_count, 1);
  const final = withAdvanceAssessment(response, result);
  assert.equal(final.media_buckets.adverse_media.length, 1);
  assert.equal(final.media_buckets.adverse_media[0].subject_relationship, 'direct');
  assert.equal(final.summary.confirmed_distinct_adverse_articles, 1);
  assert.equal(final.summary.potentially_relevant_results, 1);
  assert.equal(final.summary.unresolved_results, 0);
  assert.match(final.summary.statement, /Verified adverse media met the Unsafe profile rule/);
});

test('a verified lead-body incident can corroborate a generic headline and long exact quote', async () => {
  const longQuote = 'India\'s Signzy, an online ID verification and digital onboarding provider used by hundreds of financial institutions around the world, has confirmed a security incident affecting customer information after a recent cyberattack.';
  assert.ok(longQuote.length > 180 && longQuote.length <= 600);
  const response = { ...base, entity: { entity_type: 'business', name: 'Signzy' },
    media_buckets: { ...base.media_buckets, adverse_media: [{ ...article,
      title: 'Digital identity platform confirms incident',
      excerpt: `${longQuote} Signzy is investigating the incident. Signzy notified customers.` }] } };
  const result = await assessAdvanceScreening({ response,
    policySet: compileAdvancePolicySet({ policy_ids: ['CYB-05'] }), apiKey: 'test-key',
    fetchImpl: tagFetch({ adverse_assessment: 'adverse', subject_role: 'victim',
      subject_relationship: 'direct', entity_match: 'confirmed', event_type_ids: ['CYB-05'],
      severity: 'moderate', legal_stage: 'media_mention', supporting_quote: longQuote },
    () => {}, longQuote) });
  assert.equal(result.finding_decisions[0].status, 'confirmed_event');
  assert.equal(result.evidence_register[0].subject_relationship, 'direct');
  assert.equal(result.evidence_register[0].ai7_edd_assessment, 'adverse');
});

test('a model cannot clear a documented breach victim by calling the incident not adverse', async () => {
  const breachQuote = 'Example Trading LLC disclosed a data breach affecting customer records.';
  const response = { ...base, media_buckets: { ...base.media_buckets,
    adverse_media: [{ ...article, title: 'Example Trading LLC data breach', excerpt: breachQuote }] } };
  const result = await assessAdvanceScreening({ response,
    policySet: compileAdvancePolicySet({ policy_ids: ['CYB-05'] }), apiKey: 'test-key',
    fetchImpl: tagFetch({ adverse_assessment: 'not_adverse', subject_role: 'victim',
      subject_relationship: 'direct', entity_match: 'confirmed', event_type_ids: [],
      supporting_quote: breachQuote }, () => {}, breachQuote) });
  assert.equal(result.classification_completed, false);
  assert.equal(result.evidence_register[0].subject_relationship, null);
  assert.equal(result.evidence_profile.status, 'inconclusive');
});

test('a negative customer review is not adverse media even when Gemini proposes fraud', async () => {
  const reviewQuote = 'A customer called Example Trading LLC a fraud and gave it one star.';
  const response = { ...base, media_buckets: { ...base.media_buckets,
    adverse_media: [{ ...article, title: 'Example Trading LLC fraud reviews and ratings',
      url: 'https://www.trustpilot.com/review/example-trading-llc.com', excerpt: reviewQuote }] } };
  const result = await assessAdvanceScreening({ response, policySet, apiKey: 'test-key',
    fetchImpl: tagFetch({ supporting_quote: reviewQuote }, () => {}, reviewQuote) });
  assert.equal(result.evidence_profile.status, 'safe');
  assert.equal(result.finding_decisions[0].status, 'not_adverse');
  assert.equal(result.evidence_register[0].ai7_edd_assessment, 'not_adverse');
  assert.equal(withAdvanceAssessment(response, result).summary.confirmed_distinct_adverse_articles, 0);
});

test('a direct victim or incidental advertisement needs a quote naming the subject', async () => {
  const genericQuote = 'Customer records were exposed during the incident.';
  const response = { ...base, media_buckets: { ...base.media_buckets,
    adverse_media: [{ ...article, title: 'Example Trading LLC data breach',
      excerpt: `${genericQuote} Example Trading LLC was mentioned elsewhere.` }] } };
  for (const tag of [
    { adverse_assessment: 'adverse', subject_role: 'victim',
      subject_relationship: 'direct', event_type_ids: ['CYB-05'] },
    { adverse_assessment: 'not_adverse', subject_role: 'context_only',
      subject_relationship: 'no_association', event_type_ids: [] }
  ]) {
    const result = await assessAdvanceScreening({ response,
      policySet: compileAdvancePolicySet({ policy_ids: ['CYB-05'] }), apiKey: 'test-key',
      fetchImpl: tagFetch({ ...tag, supporting_quote: genericQuote }, () => {}, genericQuote) });
    assert.equal(result.evidence_register[0].subject_relationship, null);
    assert.equal(result.evidence_register[0].finding_status, 'unresolved');
  }
});

test('AI7 EDD places a supported namesake article in No Impact', async () => {
  const namesakeQuote = 'A different Example Trading LLC in another country announced a merger.';
  const namesake = { ...article, result_id: 'namesake-1', excerpt: namesakeQuote,
    title: 'Namesake company merger' };
  const response = { ...base, media_buckets: { adverse_media: [namesake],
    general_news_mentions: [], no_impact_media: [] } };
  const assessment = await assessAdvanceScreening({ response, policySet, apiKey: 'test-key',
    fetchImpl: tagFetch({ adverse_assessment: 'not_adverse', subject_role: 'namesake',
      entity_match: 'unlikely', event_type_ids: [], severity: 'minor',
      legal_stage: 'media_mention', supporting_quote: namesakeQuote, confidence: 0.95 },
    () => {}, namesakeQuote) });
  const final = withAdvanceAssessment(response, assessment);
  assert.equal(final.media_buckets.adverse_media.length, 0);
  assert.equal(final.media_buckets.no_impact_media.length, 1);
  assert.equal(final.results.length, 0);
});

test('a full legal business name with an independent exact-name match can support Unsafe', async () => {
  const legalQuote = 'The regulator found that Wirecard AG committed accounting fraud.';
  const legalArticle = { ...article, title: 'Wirecard AG accounting case', excerpt: legalQuote,
    identity_match: { type: 'exact_name', matched_input: 'Wirecard AG' } };
  const response = { ...base, entity: { name: 'Wirecard AG', entity_type: 'business' },
    media_buckets: { ...base.media_buckets, adverse_media: [legalArticle] } };
  const fetchImpl = tagFetch({}, () => {}, legalQuote);
  assert.equal((await assessAdvanceScreening({ response, policySet, apiKey: 'test-key', fetchImpl }))
    .evidence_profile.status, 'unsafe');
  const partial = { ...legalArticle, identity_match: { type: 'partial', matched_input: 'Wirecard' } };
  assert.equal((await assessAdvanceScreening({ response: { ...response,
    media_buckets: { ...base.media_buckets, adverse_media: [partial] } }, policySet,
  apiKey: 'test-key', fetchImpl })).evidence_profile.status, 'inconclusive');
});

test('Advance report buckets follow confirmed article decisions', async () => {
  const legalQuote = 'The regulator found that Wirecard AG committed accounting fraud.';
  const confirmed = { ...article, title: 'Wirecard AG accounting case', excerpt: legalQuote,
    identity_match: { type: 'exact_name', matched_input: 'Wirecard AG' } };
  const uncertain = { ...article, result_id: 'article-2', url: 'https://publisher.example/linked',
    title: 'Linked company story', excerpt: 'Wirecard AG was mentioned in the report.',
    identity_match: { type: 'partial', matched_input: 'Wirecard' } };
  const response = { ...base, entity: { name: 'Wirecard AG', entity_type: 'business' },
    media_buckets: { adverse_media: [uncertain], general_news_mentions: [confirmed], no_impact_media: [] } };
  const assessment = await assessAdvanceScreening({ response, policySet, apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const articles = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).articles;
      const events = articles.map(({ story_key, title }) => title === confirmed.title
        ? { story_key, adverse_assessment: 'adverse', subject_role: 'direct_actor',
          entity_match: 'confirmed', event_type_ids: ['FIN-01'], severity: 'serious',
          legal_stage: 'regulatory_action', supporting_quote: legalQuote, confidence: 0.95,
          subject_relationship: 'direct', report_priority: 80 }
        : { story_key, adverse_assessment: 'unclear', subject_role: 'unclear',
          entity_match: 'possible', event_type_ids: [], severity: 'minor',
          legal_stage: 'media_mention', supporting_quote: '', confidence: 0,
          subject_relationship: 'indirect', report_priority: 0 });
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events }) }] } }] });
    } });
  const final = withAdvanceAssessment(response, assessment);
  assert.equal(final.summary.profile_status, 'unsafe');
  assert.deepEqual(final.media_buckets.adverse_media.map((item) => item.title),
    ['Wirecard AG accounting case']);
  assert.deepEqual(final.media_buckets.general_news_mentions.map((item) => item.title),
    ['Linked company story']);
  assert.equal(final.summary.media_bucket_counts.adverse_media, 1);
  assert.equal(assessment.finding_decisions.find((item) => item.status === 'confirmed_event')?.subject_role,
    'direct_actor');
  const narrative = await createAdverseMediaNarrative({ response: final, apiKey: '' });
  assert.match(narrative.summary, /Collected news includes "Wirecard AG accounting case"/);
});

test('a quote about another convicted actor cannot implicate the named business', async () => {
  const otherQuote = 'Two executives at a linked firm were convicted of falsifying documents.';
  const source = { ...article, title: 'Case linked to Wirecard AG',
    excerpt: `Wirecard AG was mentioned. ${otherQuote}`,
    identity_match: { type: 'exact_name', matched_input: 'Wirecard AG' } };
  const response = { ...base, entity: { name: 'Wirecard AG', entity_type: 'business' },
    media_buckets: { ...base.media_buckets, adverse_media: [source] } };
  const result = await assessAdvanceScreening({ response, policySet, apiKey: 'test-key',
    fetchImpl: tagFetch({}, () => {}, otherQuote) });
  assert.equal(result.evidence_profile.status, 'inconclusive');
  assert.equal(result.counts.distinct_adverse_stories, 0);
  assert.equal(result.counts.unresolved_stories, 1);
  const linkedQuote = 'Two executives at a firm linked to Wirecard AG were convicted.';
  const linked = { ...source, excerpt: linkedQuote,
    evidence_assessment: `Other Executive: ${linkedQuote}` };
  const linkedResult = await assessAdvanceScreening({ response: { ...response,
    media_buckets: { ...base.media_buckets, adverse_media: [linked] } }, policySet,
  apiKey: 'test-key', fetchImpl: tagFetch({}, () => {}, linkedQuote) });
  assert.equal(linkedResult.evidence_profile.status, 'inconclusive');
  assert.equal(linkedResult.counts.distinct_adverse_stories, 0);
});

test('official legal-name title and distinctive business name in its quote support attribution', async () => {
  const boeingQuote = 'Boeing breached its obligations under the agreement.';
  const source = { ...article, title: 'United States v. The Boeing Company',
    excerpt: boeingQuote, identity_match: { type: 'exact_name', matched_input: 'Boeing Company' } };
  const response = { ...base, entity: { name: 'Boeing Company', entity_type: 'business' },
    media_buckets: { ...base.media_buckets, adverse_media: [source] } };
  const fetchImpl = tagFetch({}, () => {}, boeingQuote);
  assert.equal((await assessAdvanceScreening({ response, policySet, apiKey: 'test-key', fetchImpl }))
    .evidence_profile.status, 'unsafe');
  const weakTitle = { ...source, title: 'Boeing case' };
  assert.equal((await assessAdvanceScreening({ response: { ...response,
    media_buckets: { ...base.media_buckets, adverse_media: [weakTitle] } }, policySet,
  apiKey: 'test-key', fetchImpl })).evidence_profile.status, 'inconclusive');
});

test('an individual name plus supplied organisation supports attribution', async () => {
  const personQuote = 'The regulator charged Bernard Madoff with securities fraud.';
  const response = { ...base, entity: { name: 'Bernard Madoff', entity_type: 'individual' },
    media_buckets: { ...base.media_buckets, adverse_media: [{ ...article,
      title: 'Bernard Madoff case', excerpt: `${personQuote} Madoff Securities was involved.` }] } };
  const fetchImpl = tagFetch({}, () => {}, personQuote);
  assert.equal((await assessAdvanceScreening({ response, policySet,
    identifiers: { associated_organisations: ['Madoff Securities'] }, apiKey: 'test-key', fetchImpl }))
    .evidence_profile.status, 'unsafe');
  assert.equal((await assessAdvanceScreening({ response, policySet, apiKey: 'test-key', fetchImpl }))
    .evidence_profile.status, 'inconclusive');
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
  const result = await assessScreening({ response, policySet, apiKey: 'test-key',
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

test('a contradictory model tag stays unresolved without erasing a supported adverse finding', async () => {
  const second = { ...article, result_id: 'article-2', url: 'https://publisher.example/second' };
  const response = { ...base, media_buckets: { ...base.media_buckets,
    adverse_media: [article, second] } };
  const result = await assessAdvanceScreening({ response, policySet,
    identifiers: { registration_numbers: ['12345'] }, apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const keys = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text)
        .articles.map((item) => item.story_key);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events: [
        { story_key: keys[0], adverse_assessment: 'adverse', subject_role: 'direct_actor',
          entity_match: 'confirmed', event_type_ids: ['FIN-01'], severity: 'serious',
          legal_stage: 'regulatory_action', supporting_quote: quote, confidence: 0.95,
          subject_relationship: 'direct', report_priority: 80 },
        { story_key: keys[1], adverse_assessment: 'adverse', subject_role: 'context_only',
          entity_match: 'confirmed', event_type_ids: ['FIN-01'], severity: 'serious',
          legal_stage: 'regulatory_action', supporting_quote: quote, confidence: 0.95,
          subject_relationship: 'no_association', report_priority: 0 }
      ] }) }] } }] });
    } });
  assert.equal(result.evidence_profile.status, 'unsafe');
  assert.equal(result.classification_completed, false);
  assert.equal(result.counts.unresolved_stories, 1);
  assert.equal(result.counts.distinct_adverse_stories, 1);
});

test('a later model outage preserves earlier supported adverse decisions', async () => {
  const items = Array.from({ length: 8 }, (_, index) => ({ ...article,
    result_id: `article-${index}`, url: `https://publisher.example/story-${index}` }));
  const response = { ...base, media_buckets: { ...base.media_buckets, adverse_media: items } };
  let calls = 0;
  const result = await assessAdvanceScreening({ response, policySet,
    identifiers: { registration_numbers: ['12345'] }, apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      if (++calls === 2) return new Response('', { status: 503 });
      const keys = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text)
        .articles.map((item) => item.story_key);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events: keys.map(
        (story_key, index) => ({ story_key, adverse_assessment: index < 3 ? 'adverse' : 'not_adverse',
          subject_role: index < 3 ? 'direct_actor' : 'context_only',
          entity_match: 'confirmed', event_type_ids: index < 3 ? ['FIN-01'] : [], severity: 'serious',
          legal_stage: 'regulatory_action', supporting_quote: quote, confidence: 0.95,
          subject_relationship: 'direct', report_priority: 80 })) }) }] } }] });
    } });
  assert.equal(calls, 2);
  assert.equal(result.evidence_profile.status, 'unsafe');
  assert.equal(result.classification_completed, false);
  assert.ok(result.counts.unresolved_stories >= 1);
});

test('a provider budget stop after a confirmed Direct article still returns Unsafe', async () => {
  const items = Array.from({ length: 6 }, (_, index) => ({ ...article,
    result_id: `budget-${index}`, url: `https://publisher.example/fraud-${index}` }));
  let extractions = 0;
  let modelCalls = 0;
  const result = await assessScreening({ response: { ...base,
    media_buckets: { ...base.media_buckets, adverse_media: items } }, policySet,
    identifiers: { registration_numbers: ['12345'] }, apiKey: 'test-key',
    extractArticle: async () => ++extractions > 4
      ? { reason: 'article_cost_limit' } : { text: quote },
    fetchImpl: async (_url, options) => {
      modelCalls += 1;
      const keys = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text)
        .articles.map((item) => item.story_key);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events: keys.map(
        (story_key, index) => ({ story_key, adverse_assessment: index === 0 ? 'adverse' : 'not_adverse',
          subject_role: index === 0 ? 'direct_actor' : 'context_only',
          subject_relationship: 'direct', entity_match: 'confirmed',
          event_type_ids: index === 0 ? ['FIN-01'] : [], severity: 'serious',
          legal_stage: 'regulatory_action', supporting_quote: quote,
          confidence: 0.95, report_priority: 80 })) }) }] } }] });
    } });
  assert.equal(result.pending, undefined);
  assert.equal(result.evidence_profile.status, 'unsafe');
  assert.equal(result.early_stop.reason, 'provider_budget_after_confirmed_direct_adverse');
  assert.equal(result.early_stop.pending_candidates, 2);
  assert.equal(result.counts.unresolved_stories, 2);
  assert.equal(modelCalls, 1);
  assert.equal(extractions, 5);
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

test('an archived review listing cannot supply an adverse-media shortcut', async () => {
  const review = { record_id: 'archive-review', title: 'Example Trading LLC fraud reviews',
    url: 'https://www.trustpilot.com/review/example-trading-llc.com',
    quote: 'A customer called Example Trading LLC a fraud and gave it one star.',
    status: 'adverse', subject_role: 'direct_actor', reason: 'article_party_fact_supported' };
  const response = { ...base, coverage: { ...base.coverage,
    archive_review: { status: 'completed', expected_postings: 1, adverse: 1,
      adverse_sample: [review] } } };
  const assessment = await assessAdvanceScreening({ response, policySet, apiKey: '' });
  assert.notEqual(assessment.evidence_profile.status, 'unsafe');
  assert.equal(advanceArchiveMediaItems(response).length, 0);
  assert.equal(withAdvanceAssessment(response, assessment).media_buckets.adverse_media.length, 0);
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
