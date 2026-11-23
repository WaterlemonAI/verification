import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADVANCE_ADVERSE_TERMS, ADVANCE_LEXICON_VERSION,
  matchAdvanceTitleUrl } from '../lib/adverse-media-advance-lexicon.mjs';
import { normalizeAdvanceEvidence } from '../lib/adverse-media-advance-evidence.mjs';
import { assessAdvanceScreening, withAdvanceAssessment } from '../lib/adverse-media-advance-classifier.mjs';
import { compileAdvancePolicySet } from '../lib/adverse-media-advance-policy.mjs';

const policySet = compileAdvancePolicySet({ policy_ids: ['FIN-01'] });
const entity = { name: 'Example Trading LLC', entity_type: 'business' };
const quote = 'The regulator fined Example Trading LLC, registration 12345, for fraud.';
const baseline = (advance_source_results) => ({ entity, advance_source_results,
  coverage: { complete: true, archive_review: { status: 'completed', expected_postings: 0 } },
  summary: {}, media_buckets: { adverse_media: [], general_news_mentions: [], no_impact_media: [] } });

test('versioned lexicon has at least 500 distinct strings and recalls the Signzy incident', () => {
  assert.ok(ADVANCE_ADVERSE_TERMS.length >= 500);
  assert.equal(new Set(ADVANCE_ADVERSE_TERMS.map((item) => item.term.toLowerCase())).size,
    ADVANCE_ADVERSE_TERMS.length);
  const hit = matchAdvanceTitleUrl({ title: 'Signzy security incident exposed customer data',
    url: 'https://news.example/signzy-data%20leak' });
  assert.equal(hit.selected, true);
  assert.equal(hit.lexicon_version, ADVANCE_LEXICON_VERSION);
  assert.ok(hit.matches.some((item) => item.term === 'security incident'));
  assert.ok(hit.matches.some((item) => item.term === 'data leak' && item.locations.includes('url_path')));
  const returnedHeadline = matchAdvanceTitleUrl({
    title: "India's Digital Identity Titan Faces Cybersecurity Scare, Highlighting Concerns With Digital ID",
    url: 'https://reclaimthenet.org/indias-digital-identity-titan-faces-cybersecurity-scare-highlighting-concerns-with-digital-id'
  });
  assert.equal(returnedHeadline.selected, true);
  assert.ok(returnedHeadline.matches.some((item) => item.term === 'cybersecurity scare'));
  assert.equal(matchAdvanceTitleUrl({ title: 'Risk management update', url: 'https://news.example/risk' }).selected, false);
  assert.equal(matchAdvanceTitleUrl({ title: 'Anti fraudulence software', url: 'https://news.example/update' }).selected, false);
});

test('all returned Brave metadata receives a selected or excluded register decision', () => {
  const news = Array.from({ length: 60 }, (_, index) => ({ result_id: `b-${index}`,
    title: index === 51 ? 'Signzy data leak raises concern' : `Signzy product update ${index}`,
    url: `https://news.example/story-${index}`, source_type: 'news_index' }));
  const evidence = normalizeAdvanceEvidence(baseline(news));
  assert.equal(evidence.counts.search_returned, 60);
  assert.equal(evidence.counts.selected_candidates, 1);
  assert.equal(evidence.counts.metadata_excluded, 59);
  assert.equal(evidence.items.find((item) => item.result_id === 'b-51').selection_status, 'selected');
});

test('resumable review screens all 25 candidates then ranks at most 20 for the PDF', async () => {
  const news = Array.from({ length: 25 }, (_, index) => ({ result_id: `b-${index}`,
    title: `Example Trading LLC fraud case ${index}`,
    url: `https://news.example/fraud-${index}`, excerpt: quote,
    source_type: 'news_index' }));
  const response = baseline(news);
  const components = new Map();
  const checkpoint = { get: async (key) => components.get(key) || null,
    save: async (key, value) => { if (!components.has(key)) components.set(key, value); } };
  let modelCalls = 0;
  const options = { response, policySet, apiKey: 'test',
    identifiers: { registration_numbers: ['12345'] }, checkpoint, maxBatches: 1,
    extractArticle: async () => ({ text: `Article body. ${quote} Further verified context.` }),
    fetchImpl: async (_url, request) => {
      modelCalls += 1;
      const articles = JSON.parse(JSON.parse(request.body).contents[0].parts[0].text).articles;
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events:
        articles.map((item) => ({ story_key: item.story_key,
          adverse_assessment: 'adverse', subject_role: 'direct_actor', subject_relationship: 'direct',
          entity_match: 'confirmed', event_type_ids: ['FIN-01'], severity: 'serious',
          legal_stage: 'regulatory_action', supporting_quote: quote, confidence: 0.95,
          report_priority: Number(item.title.match(/(\d+)$/)[1]) })) }) }] } }] });
    } };
  assert.equal((await assessAdvanceScreening(options)).pending, true);
  assert.equal(modelCalls, 1);
  assert.equal((await assessAdvanceScreening(options)).pending, true);
  const assessment = await assessAdvanceScreening(options);
  assert.equal(modelCalls, 3);
  assert.equal(assessment.articles_considered, 25);
  assert.equal(assessment.evidence_profile.status, 'unsafe');
  assert.equal(assessment.report_selection.selected_count, 20);
  assert.equal(assessment.report_selection.omitted_count, 5);
  assert.equal(assessment.report_selection.selected_result_ids[0], 'b-24');
  assert.equal(assessment.evidence_register.filter((item) => item.subject_relationship === 'direct').length, 25);
  const final = withAdvanceAssessment(response, assessment);
  assert.equal(final.media_buckets.adverse_media.filter((item) => item.selected_for_pdf).length, 20);
});

test('cost ceiling pauses review without a model call or a Safe result', async () => {
  const response = baseline([{ result_id: 'blocked-1', title: 'Example Trading LLC fraud case',
    url: 'https://news.example/fraud', excerpt: quote, source_type: 'news_index' }]);
  const components = new Map();
  const checkpoint = { get: async (key) => components.get(key) || null,
    save: async (key, value) => { if (!components.has(key)) components.set(key, value); } };
  let extractionCalls = 0;
  const options = { response, policySet, apiKey: 'test', checkpoint,
    extractArticle: async () => { extractionCalls += 1; return { reason: 'article_cost_limit' }; },
    fetchImpl: async () => { throw new Error('model_must_not_run'); } };
  const first = await assessAdvanceScreening(options);
  const replay = await assessAdvanceScreening(options);
  assert.equal(first.reason, 'budget_blocked');
  assert.equal(first.pending_count, 1);
  assert.equal(replay.reason, 'budget_blocked');
  assert.equal(extractionCalls, 1);
  assert.equal(components.get('advance-budget-status:1').pending_count, 1);
});

test('a verified Signzy security incident reaches review with a direct affected-party relationship', async () => {
  const incident = 'Signzy reported that customer data was exposed in a security incident.';
  const response = { ...baseline([{ result_id: 'signzy-incident',
    title: 'Signzy security incident and data leak',
    url: 'https://news.example/signzy-data-leak', excerpt: incident,
    source_type: 'news_index' }]), entity: { name: 'Signzy', entity_type: 'business' } };
  const result = await assessAdvanceScreening({ response,
    policySet: compileAdvancePolicySet({ policy_ids: ['CYB-01'] }), apiKey: 'test',
    extractArticle: async () => ({ text: `Verified article body: ${incident} Customers received notice.` }),
    fetchImpl: async (_url, request) => {
      const key = JSON.parse(JSON.parse(request.body).contents[0].parts[0].text).articles[0].story_key;
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events: [{
        story_key: key, adverse_assessment: 'adverse', subject_role: 'victim',
        subject_relationship: 'direct', entity_match: 'confirmed', event_type_ids: ['CYB-01'],
        severity: 'serious', legal_stage: 'media_mention', supporting_quote: incident,
        confidence: 0.9, report_priority: 90
      }] }) }] } }] });
    } });
  assert.equal(result.articles_considered, 1);
  assert.equal(result.evidence_register[0].subject_relationship, 'direct');
  assert.equal(result.evidence_register[0].ai7_edd_review_status, 'reviewed');
  assert.notEqual(result.evidence_profile.status, 'unsafe');
});

test('former employee and incidental advertisement receive distinct public relationships', async () => {
  const cases = [
    { result_id: 'former', title: 'Former Example Trading LLC employee charged with fraud',
      url: 'https://news.example/former-fraud', excerpt: 'A former Example Trading LLC employee was charged with fraud.' },
    { result_id: 'advert', title: 'Fraud trial with unrelated Example Trading LLC advertisement',
      url: 'https://news.example/trial-advert', excerpt: 'An Example Trading LLC advertisement appeared beside the article.' }
  ];
  const response = baseline(cases);
  const assessment = await assessAdvanceScreening({ response, policySet, apiKey: 'test',
    extractArticle: async (item) => ({ text: `Verified article. ${item.text} Additional context.` }),
    fetchImpl: async (_url, request) => {
      const articles = JSON.parse(JSON.parse(request.body).contents[0].parts[0].text).articles;
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events:
        articles.map((item) => item.title.startsWith('Former') ? {
          story_key: item.story_key, adverse_assessment: 'adverse', subject_role: 'related_party',
          subject_relationship: 'indirect', entity_match: 'confirmed', event_type_ids: ['FIN-01'],
          severity: 'moderate', legal_stage: 'charged', supporting_quote: cases[0].excerpt,
          confidence: 0.9, report_priority: 50
        } : { story_key: item.story_key, adverse_assessment: 'not_adverse',
          subject_role: 'context_only', subject_relationship: 'no_association',
          entity_match: 'confirmed', event_type_ids: [], severity: 'minor',
          legal_stage: 'media_mention', supporting_quote: cases[1].excerpt,
          confidence: 0.9, report_priority: 0 }) }) }] } }] });
    } });
  assert.deepEqual(assessment.evidence_register.map((item) => item.subject_relationship),
    ['indirect', 'no_association']);
  const final = withAdvanceAssessment(response, assessment);
  assert.equal(final.media_buckets.adverse_media.length, 1);
  assert.equal(final.media_buckets.adverse_media[0].subject_relationship, 'indirect');
  assert.equal(final.media_buckets.no_impact_media.length, 1);
});
