import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdvanceQueryPlan } from '../lib/adverse-media-advance-plan.mjs';
import { advanceTitleUrlCandidate } from '../lib/gdelt-archive-candidate.mjs';
import { normalizeAdvanceEvidence } from '../lib/adverse-media-advance-evidence.mjs';
import { createAdvanceNarrative } from '../lib/adverse-media-advance-narrative.mjs';
import { assessAdvanceScreening, withAdvanceAssessment } from '../lib/adverse-media-advance-classifier.mjs';
import { compileAdvancePolicySet } from '../lib/adverse-media-advance-policy.mjs';

test('AI7 EDD creates bounded name variants and search phrases for selected languages', async () => {
  const request = { entity_type: 'business', name: 'Example Group LLC', aliases: [],
    countries: ['CN'], languages: ['en', 'zh'] };
  const plan = await createAdvanceQueryPlan({ request,
    policySet: { policies: [{ event_type: 'fraud' }] }, apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.systemInstruction.parts[0].text, /untrusted data/);
      assert.equal(JSON.parse(body.contents[0].parts[0].text).countries[0], 'CN');
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ languages: [
        { code: 'en', name_variants: [], adverse_terms: ['fraud investigation'] },
        { code: 'zh', name_variants: ['示例集团'], adverse_terms: ['欺诈调查'] }
      ] }) }] } }] });
    } });
  assert.equal(plan.status, 'completed');
  assert.deepEqual(plan.transliterations.zh, ['示例集团']);
  assert.deepEqual(plan.search_terms.zh, ['欺诈调查']);
});

test('Archive title or URL selection excludes body-only names before article extraction', () => {
  const request = { name: 'Example Group LLC', entity_type: 'business', aliases: [],
    transliterations: {} };
  assert.equal(advanceTitleUrlCandidate({ title: 'Example Group fined', url: 'https://news.example/story' }, request).selected, true);
  assert.equal(advanceTitleUrlCandidate({ title: 'A market report', url: 'https://news.example/example-group-fraud-case' }, request).selected, true);
  assert.equal(advanceTitleUrlCandidate({ title: 'A market report', url: 'https://news.example/story',
    body: 'Example Group LLC was fined' }, request).selected, false);
});

test('Brave and Entity Map articles merge by canonical URL before AI7 EDD review', () => {
  const response = { results: [{ result_id: 'brave-1', title: 'Example Group fined',
    source_type: 'publisher_search', source_types: ['publisher_search', 'news_index'],
    search_call_ids: ['search-03', 'search-06'],
    excerpt: 'Example Group LLC was fined.', url: 'https://news.example/story?utm_source=brave' }] };
  const archive = [{ record_id: 'gdelt-1', title: 'Example Group fined',
    quote: 'Example Group LLC was fined.', status: 'adverse', subject_role: 'direct_actor',
    url: 'https://news.example/story' }];
  const merged = normalizeAdvanceEvidence(response, archive);
  assert.equal(merged.counts.unique_urls, 1);
  assert.equal(merged.counts.overlap_urls, 1);
  assert.deepEqual(merged.items[0].sources.sort(), ['kycprobe_entity_map', 'news_index', 'publisher_search']);
  assert.deepEqual(merged.items[0].search_call_ids, ['search-03', 'search-06']);
});

test('AI7 EDD receives normalized Brave and archive evidence in one bounded review', async () => {
  const response = { entity: { name: 'Example Group LLC', entity_type: 'business' },
    summary: {}, coverage: { complete: true,
      archive_review: { status: 'completed', expected_postings: 1, unresolved: 0 } },
    results: [], media_buckets: { adverse_media: [], general_news_mentions: [{
      result_id: 'brave-1', title: 'Example Group investigated',
      excerpt: 'Example Group LLC is under investigation.', url: 'https://news.example/investigation',
      publisher: 'Example News', source_type: 'publisher_search',
      search_call_ids: ['search-05'] }], no_impact_media: [] } };
  const archiveItems = [{ record_id: 'archive-1', title: 'Example Group opens a branch',
    quote: 'Example Group LLC opened a branch in Dubai.', status: 'general',
    subject_role: 'direct_actor', url: 'https://archive.example/branch' }];
  let submitted;
  const assessment = await assessAdvanceScreening({ response, archiveItems,
    policySet: compileAdvancePolicySet({ policy_ids: ['FIN-01'] }), apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      submitted = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).articles;
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events:
        submitted.map((item) => ({ story_key: item.story_key, adverse_assessment: 'not_adverse',
          subject_role: 'direct_actor', entity_match: 'confirmed', event_type_ids: [],
          severity: 'minor', legal_stage: 'media_mention', supporting_quote: item.text.split('\n')[1],
          confidence: 0.95, subject_relationship: 'direct', report_priority: 20 })) }) }] } }] });
    }, extractArticle: async (item) => ({ text: item.text }) });
  assert.equal(submitted.length, 2);
  assert.ok(submitted.some((item) => item.sources.includes('publisher_search')
    && item.search_call_ids.includes('search-05')));
  assert.ok(submitted.some((item) => item.sources.includes('kycprobe_entity_map')));
  assert.equal(assessment.evidence_register.length, 2);
  assert.ok(assessment.evidence_register.every((item) =>
    ['reviewed', 'unassessed', 'unresolved'].includes(item.ai7_edd_review_status)));
});

test('Advance reviews both Brave and archive candidates beyond the former 50-article limit', async () => {
  const news = Array.from({ length: 51 }, (_, index) => ({ result_id: `brave-${index}`,
    title: `Example Group update ${index}`, excerpt: 'Example Group LLC published an update.',
    url: `https://news.example/update-${index}`, source_type: 'news_index' }));
  const response = { entity: { name: 'Example Group LLC', entity_type: 'business' }, summary: {},
    coverage: { complete: true, archive_review: { status: 'completed', expected_postings: 1, unresolved: 0 } },
    results: [], media_buckets: { adverse_media: [], general_news_mentions: news, no_impact_media: [] } };
  const archiveItems = [{ record_id: 'archive-1', title: 'Example Group branch',
    quote: 'Example Group LLC opened a branch.', status: 'general', subject_role: 'direct_actor',
    url: 'https://archive.example/branch' }];
  const received = [];
  const assessment = await assessAdvanceScreening({ response, archiveItems,
    policySet: compileAdvancePolicySet({ policy_ids: ['FIN-01'] }), apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const articles = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).articles;
      received.push(...articles);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events:
        articles.map((item) => ({ story_key: item.story_key, adverse_assessment: 'not_adverse',
          subject_role: 'direct_actor', entity_match: 'confirmed', event_type_ids: [],
          severity: 'minor', legal_stage: 'media_mention', supporting_quote: item.text.split('\n')[1],
          confidence: 0.95, subject_relationship: 'direct', report_priority: 20 })) }) }] } }] });
    } });
  assert.equal(received.length, 52);
  assert.ok(received.some((item) => item.sources.includes('kycprobe_entity_map')));
  assert.ok(received.some((item) => item.sources.includes('news_index')));
  assert.equal(assessment.evidence_register.length, 52);
  assert.equal(assessment.evidence_register.filter((item) => item.ai7_edd_review_status === 'unassessed').length, 51);
  assert.equal(assessment.evidence_profile.status, 'inconclusive');
});

test('Reviewed archive general articles appear in the final media buckets', async () => {
  const response = { entity: { name: 'Example Group LLC', entity_type: 'business' },
    summary: {}, coverage: { complete: true,
      archive_review: { status: 'completed', expected_postings: 1, unresolved: 0 } },
    results: [], media_buckets: { adverse_media: [], general_news_mentions: [], no_impact_media: [] } };
  const archiveItems = [{ record_id: 'archive-1', title: 'Example Group opens a branch',
    quote: 'Example Group LLC opened a branch in Dubai.', status: 'general',
    subject_role: 'direct_actor', url: 'https://news.example/branch' }];
  const policySet = compileAdvancePolicySet({ policy_ids: ['FIN-01'] });
  const assessment = await assessAdvanceScreening({ response, archiveItems, policySet,
    apiKey: 'test-key', fetchImpl: async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events: [
        { story_key: input.articles[0].story_key, adverse_assessment: 'not_adverse',
          subject_role: 'direct_actor', entity_match: 'confirmed', event_type_ids: [],
          severity: 'minor', legal_stage: 'media_mention',
          supporting_quote: archiveItems[0].quote, confidence: 0.95,
          subject_relationship: 'direct', report_priority: 20 }
      ] }) }] } }] });
    } });
  const final = withAdvanceAssessment(response, assessment);
  assert.equal(final.summary.profile_status, 'safe');
  assert.equal(final.media_buckets.general_news_mentions.length, 1);
  assert.equal(final.advance_assessment.evidence_register[0].archive_status, 'general');
});

test('Advance report writer receives the fixed PDF structure and rejects model branding', async () => {
  const response = { entity: { name: 'Example Group LLC', entity_type: 'business' },
    summary: { profile_status: 'inconclusive', media_bucket_counts: {
      adverse_media: 0, general_news_mentions: 1, no_impact_media: 0 } },
    media_buckets: { adverse_media: [], general_news_mentions: [{ title: 'Example Group update',
      excerpt: 'Company update.', url: 'https://news.example/story' }], no_impact_media: [] } };
  const narrative = await createAdvanceNarrative({ response, apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.systemInstruction.parts[0].text, /How to read this report/);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        summary: 'Gemini found no issue.', findings: [], recommendations: []
      }) }] } }] });
    } });
  assert.equal(narrative.source, 'ai7_edd_fallback');
  assert.doesNotMatch(JSON.stringify(narrative), /Gemini/i);
});

test('Advance fallback describes an affected victim without implying culpability', async () => {
  const response = { entity: { name: 'Example Group LLC', entity_type: 'business' },
    summary: { profile_status: 'safe', media_bucket_counts: {
      adverse_media: 1, general_news_mentions: 0, no_impact_media: 0 } },
    media_buckets: { adverse_media: [{ title: 'Example Group LLC confirms a breach',
      subject_role: 'victim', subject_relationship: 'direct', selected_for_pdf: true,
      review_status: 'reviewed' }], general_news_mentions: [], no_impact_media: [] } };
  const narrative = await createAdvanceNarrative({ response, apiKey: '' });
  assert.match(narrative.findings[0], /verified adverse incident article/);
  assert.doesNotMatch(narrative.findings[0], /directly attributable/);
});

test('Advance report writer accepts only evidence-linked findings consistent with the locked profile', async () => {
  const response = { entity: { name: 'Example Group LLC', entity_type: 'business' },
    summary: { profile_status: 'unsafe', media_bucket_counts: {
      adverse_media: 1, general_news_mentions: 0, no_impact_media: 0 } },
    media_buckets: { adverse_media: [{ title: 'Example Group fined',
      excerpt: 'The regulator fined Example Group LLC.', url: 'https://news.example/fine',
      selected_for_pdf: true, review_status: 'reviewed' }],
    general_news_mentions: [], no_impact_media: [] } };
  const fetchImpl = async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    summary: 'The profile is Unsafe following a reported regulatory fine.',
    findings: ['E01 reports a fine against the screened company.'],
    recommendations: ['Review E01 during enhanced due diligence.']
  }) }] } }] });
  const narrative = await createAdvanceNarrative({ response, apiKey: 'test-key', fetchImpl });
  assert.equal(narrative.source, 'ai7_edd');
  assert.equal(narrative.findings.length, 1);
  const unsupported = await createAdvanceNarrative({ response, apiKey: 'test-key',
    fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      summary: 'The profile is Unsafe.', findings: ['E99 reports a fine.'], recommendations: []
    }) }] } }] }) });
  assert.equal(unsupported.source, 'ai7_edd_fallback');
});
