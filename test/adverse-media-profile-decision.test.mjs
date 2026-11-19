import assert from 'node:assert/strict';
import test from 'node:test';
import { decideAdverseMediaProfile } from '../lib/adverse-media-profile-decision.mjs';
import { presentAdverseMediaResponse, screenAdverseMedia, validateAdverseMediaRequest } from '../lib/adverse-media.mjs';

for (const [name, input, expected] of [
  ['safe requires full coverage and classification', { coverageComplete: true, classificationComplete: true,
    adverseCount: 0, unresolvedCount: 0 }, 'safe'],
  ['one confirmed adverse is unsafe', { coverageComplete: true, classificationComplete: true,
    adverseCount: 1, unresolvedCount: 0 }, 'unsafe'],
  ['two confirmed adverse are unsafe', { coverageComplete: true, classificationComplete: true,
    adverseCount: 2, unresolvedCount: 0 }, 'unsafe'],
  ['three confirmed adverse remain unsafe with missing coverage', { coverageComplete: false, classificationComplete: true,
    adverseCount: 3, unresolvedCount: 0 }, 'unsafe'],
  ['one adverse with missing coverage remains inconclusive', { coverageComplete: false, classificationComplete: true,
    adverseCount: 1, unresolvedCount: 0 }, 'inconclusive'],
  ['missing coverage cannot be safe', { coverageComplete: false, classificationComplete: true,
    adverseCount: 0, unresolvedCount: 0 }, 'inconclusive'],
  ['ambiguous evidence cannot be safe', { coverageComplete: true, classificationComplete: true,
    adverseCount: 0, unresolvedCount: 1 }, 'inconclusive'],
  ['classification failure cannot be safe', { coverageComplete: true, classificationComplete: false,
    adverseCount: 0, unresolvedCount: 0 }, 'inconclusive']
]) test(name, () => assert.equal(decideAdverseMediaProfile(input).profile, expected));

test('three distinct classified adverse articles keep Unsafe when archive coverage fails', async () => {
  const request = validateAdverseMediaRequest({ entity_type: 'business', name: 'Example Group', languages: ['en'],
    max_results: 1 });
  const articles = [1, 2, 3].map((index) => ({ title: `Example Group fined in case ${index}`,
    description: `Regulator fined Example Group in a documented case ${index}.`,
    url: `https://news.example/case-${index}`, page_age: '2026-11-18T00:00:00Z' }));
  const fetchImpl = async (input) => Response.json(new URL(input).pathname.includes('/news/')
    ? { results: articles } : { web: { results: articles } });
  const aiClassifier = async (results) => ({ status: 'completed', candidates: results.length,
    inputTokens: 0, outputTokens: 0, cost: 0,
    results: results.map((result) => ({ ...result, ai_classification: {
      confidence: 0.98, media_bucket: 'adverse_media', subject_role: 'direct_actor',
      entity_match: 'confirmed', adverse: 'confirmed', categories: ['regulatory_and_governance'],
      legal_stage: 'regulatory_action', summary: 'Regulator fined the screened business.'
    } })) });
  const result = presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey: 'test', fetchImpl,
    aiClassifier, archiveSearch: async () => ({ results: [], complete: false, origin: 'local_partial',
      hostedAttempts: 3, localFailure: 'public_archive_incomplete', state: null }) }));
  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.complete, false);
  assert.equal(result.summary.profile_status, 'unsafe');
  assert.equal(result.summary.decision_eligible, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.media_buckets.adverse_media.length, 3);
});

test('syndicated copy does not create a third adverse article', async () => {
  const request = validateAdverseMediaRequest({ entity_type: 'business', name: 'Syndicated Example Group',
    languages: ['en'], max_results: 9 });
  const articles = [1, 2, 1].map((index, copy) => ({
    title: `Syndicated Example Group fined by regulator in case ${index}`,
    description: `Regulator fined Syndicated Example Group in documented case ${index}.`,
    url: `https://publisher${copy}.example/case-${index}`, page_age: '2026-11-18T00:00:00Z'
  }));
  const result = presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey: 'test',
    fetchImpl: async (input) => Response.json(new URL(input).pathname.includes('/news/')
      ? { results: articles } : { web: { results: articles } }),
    aiClassifier: async (results) => ({ status: 'completed', candidates: results.length,
      inputTokens: 0, outputTokens: 0, cost: 0,
      results: results.map((item) => ({ ...item, ai_classification: {
        confidence: 0.98, media_bucket: 'adverse_media', subject_role: 'direct_actor',
        entity_match: 'confirmed', adverse: 'confirmed', categories: ['regulatory_and_governance'],
        legal_stage: 'regulatory_action', summary: 'Fined by regulator.'
      } })) }),
    archiveSearch: async () => ({ results: [], complete: false, origin: 'local_partial', hostedAttempts: 3 }) }));
  assert.equal(result.summary.profile_status, 'inconclusive');
  assert.equal(result.summary.media_bucket_counts.adverse_media, 3);
  assert.equal(result.summary.confirmed_distinct_adverse_articles, 2);
});

test('external attack and historical compilation require corroboration before Unsafe', async () => {
  const fixtures = [
    { name: 'Harbor Company', title: 'Harbor Company vessel attacked in cyberattack at sea',
      description: 'The vessel was targeted by an external cyberattack; no company misconduct was reported.',
      url: 'https://news.example/vessel' },
    { name: 'Archive Company', title: 'Archive Company - Wikipedia history of fraud and hacking incidents',
      description: 'Historical compilation of fraud and hacking attacks on the company, updated this week.',
      url: 'https://en.wikipedia.org/wiki/Archive_Company' }
  ];
  for (const fixture of fixtures) {
    const request = validateAdverseMediaRequest({ entity_type: 'business', name: fixture.name, languages: ['en'] });
    const result = presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey: 'test',
      fetchImpl: async (input) => Response.json(new URL(input).pathname.includes('/news/')
        ? { results: [fixture] } : { web: { results: [fixture] } }),
      aiClassifier: async (results) => ({ status: 'completed', candidates: results.length,
        inputTokens: 0, outputTokens: 0, cost: 0,
        results: results.map((item) => ({ ...item, ai_classification: {
          confidence: 0.99, media_bucket: 'adverse_media', subject_role: 'direct_actor',
          entity_match: 'confirmed', adverse: 'confirmed', categories: ['regulatory_and_governance'],
          legal_stage: 'media_mention', summary: 'Model called this adverse.'
        } })) }),
      archiveSearch: async () => ({ results: [], complete: true, origin: 'local', state: null }) }));
    assert.equal(result.status, 'completed');
    assert.equal(result.coverage.complete, true);
    assert.equal(result.summary.profile_status, 'inconclusive');
    assert.equal(result.summary.decision_eligible, false);
    assert.equal(result.results.length, 0);
    assert.match(result.media_buckets.general_news_mentions[0].evidence_assessment, /corroboration/);
  }
});
