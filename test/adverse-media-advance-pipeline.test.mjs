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
  assert.equal(advanceTitleUrlCandidate({ title: 'A market report', url: 'https://news.example/example-group-case' }, request).selected, true);
  assert.equal(advanceTitleUrlCandidate({ title: 'A market report', url: 'https://news.example/story',
    body: 'Example Group LLC was fined' }, request).selected, false);
});

test('Brave and Entity Map articles merge by canonical URL before AI7 EDD review', () => {
  const response = { results: [{ result_id: 'brave-1', title: 'Example Group fined',
    excerpt: 'Example Group LLC was fined.', url: 'https://news.example/story?utm_source=brave' }] };
  const archive = [{ record_id: 'gdelt-1', title: 'Example Group fined',
    quote: 'Example Group LLC was fined.', status: 'adverse', subject_role: 'direct_actor',
    url: 'https://news.example/story' }];
  const merged = normalizeAdvanceEvidence(response, archive);
  assert.equal(merged.counts.unique_urls, 1);
  assert.equal(merged.counts.overlap_urls, 1);
  assert.deepEqual(merged.items[0].sources.sort(), ['brave_search', 'kycprobe_entity_map']);
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
          supporting_quote: archiveItems[0].quote, confidence: 0.95 }
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
