import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWithAi, mediaBucket, presentAdverseMediaResponse, screenAdverseMedia, validateAdverseMediaRequest } from '../lib/adverse-media.mjs';

async function screenFixture({ name, entity_type = 'individual', search_plus = false, max_results = 15, articles, onAiBatch }) {
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      return url.pathname.includes('/news/')
        ? Response.json({ results: [] })
        : Response.json({ web: { results: articles.map(({ ai, ...article }) => article) } });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    if (url.hostname === 'generativelanguage.googleapis.com') {
      const payload = JSON.parse(options.body);
      const prompt = JSON.parse(payload.contents[0].parts[0].text);
      onAiBatch?.(prompt.evidence.length);
      assert.equal(prompt.job, 'classify_adverse_media_evidence');
      assert.equal(payload.generationConfig.responseJsonSchema.properties.classifications.items.properties.subject_role.type, 'string');
      const classifications = prompt.evidence.map((item) => {
        const fixture = articles.find((article) => article.title === item.title);
        assert.ok(fixture, `Missing fixture for ${item.title}`);
        return {
          result_id: item.result_id,
          entity_match: fixture.ai.entity_match || 'confirmed',
          subject_role: fixture.ai.subject_role,
          media_bucket: fixture.ai.media_bucket || (fixture.ai.subject_role === 'direct_actor' && fixture.ai.adverse === 'confirmed'
            ? 'adverse_media' : ['victim', 'namesake'].includes(fixture.ai.subject_role) ? 'no_impact_media' : 'general_news_mentions'),
          adverse: fixture.ai.adverse,
          categories: fixture.ai.categories || ['financial_crime'],
          legal_stage: fixture.ai.legal_stage || 'media_mention',
          confidence: fixture.ai.confidence ?? 0.96,
          summary: fixture.ai.summary
        };
      });
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ classifications }) }] } }],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 200 } });
    }
    throw new Error(`Unexpected provider: ${url.hostname}`);
  };
  const request = validateAdverseMediaRequest({ entity_type, name, languages: ['en'], search_plus, max_results });
  return presentAdverseMediaResponse(await screenAdverseMedia({ request, apiKey: 'test-brave', aiApiKey: 'test-gemini', fetchImpl }));
}

function article(title, slug, description, ai) {
  return { title, url: `https://news.example/${slug}`, description, page_age: '2026-10-20T10:00:00Z', ai };
}

test('victim and namesake evidence cannot make Tim Cook high risk', async () => {
  const response = await screenFixture({ name: 'Tim Cook', articles: [
    article('Fraudsters use a deepfake of Tim Cook to promote a crypto scam', 'tim-deepfake',
      'Scammers impersonated Apple executive Tim Cook. He did not participate.', {
        subject_role: 'victim', adverse: 'not_adverse', summary: 'Tim Cook was impersonated by fraudsters.'
      }),
    article('Tim Cook, law-firm partner, investigated for fraud', 'tim-namesake',
      'The law-firm partner is a different person from the Apple executive.', {
        subject_role: 'namesake', adverse: 'not_adverse', entity_match: 'unlikely', summary: 'This concerns a different Tim Cook.'
      }),
    article('Apple settles lawsuit over Tim Cook comments', 'apple-settlement',
      'Apple reached a settlement concerning an alleged fraud in its sales disclosures.', {
        subject_role: 'related_party', adverse: 'possible', legal_stage: 'settled', summary: 'Apple settled a corporate lawsuit; Tim Cook was mentioned.'
      })
  ] });
  assert.equal(response.status, 'completed');
  assert.equal(response.summary.outcome, 'no_material_results');
  assert.equal(response.summary.profile_status, 'safe');
  assert.equal(response.results.length, 0);
  assert.equal(response.media_buckets.general_news_mentions.length, 1);
  assert.equal(response.media_buckets.general_news_mentions[0].subject_role, 'related_party');
  assert.equal(response.media_buckets.general_news_mentions[0].legal_stage, 'allegation');
  assert.equal(response.media_buckets.no_impact_media.length, 2);
});

test('neutral biography and layoffs do not create Jane Fraser adverse findings', async () => {
  const response = await screenFixture({ name: 'Jane Fraser', search_plus: true, articles: [
    article('Jane Fraser profile discusses bank regulatory action', 'jane-profile',
      'A leadership biography quotes Jane Fraser about regulatory action at the bank.', {
        subject_role: 'context_only', adverse: 'not_adverse', summary: 'This is a biography, not an adverse finding about Jane Fraser.'
      }),
    article('Jane Fraser announces bank layoffs', 'jane-layoffs',
      'The bank plans workforce restructuring under Jane Fraser.', {
        subject_role: 'context_only', adverse: 'not_adverse', categories: ['workforce_and_restructuring'],
        summary: 'This is a workforce announcement without misconduct attributed to Jane Fraser.'
      })
  ] });
  assert.equal(response.status, 'completed');
  assert.equal(response.summary.outcome, 'no_material_results');
  assert.equal(response.results.length, 0);
});

test('indictment, pardon, and infringement notice keep their distinct legal stages', async () => {
  const jho = await screenFixture({ name: 'Low Taek Jho', articles: [
    article('Low Taek Jho indicted in 1MDB bribery case', 'jho-indictment',
      'The indictment also discusses another defendant later convicted of corruption.', {
        subject_role: 'direct_actor', adverse: 'confirmed', legal_stage: 'charged', summary: 'Low Taek Jho was indicted; another defendant was convicted.'
      })
  ] });
  assert.equal(jho.results[0].legal_stage, 'charged');
  assert.equal(jho.summary.outcome, 'high_risk');

  const trevor = await screenFixture({ name: 'Trevor Milton', articles: [
    article('Trevor Milton pardoned after fraud conviction', 'trevor-pardon',
      'Trevor Milton had been convicted of fraud and later received a presidential pardon.', {
        subject_role: 'direct_actor', adverse: 'confirmed', legal_stage: 'pardoned', summary: 'Trevor Milton was convicted of fraud and subsequently pardoned.'
      })
  ] });
  assert.equal(trevor.results[0].legal_stage, 'pardoned');
  assert.match(trevor.results[0].evidence_assessment, /pardoned/i);

  const canva = await screenFixture({ name: 'Canva Pty Ltd', entity_type: 'business', articles: [
    article('Canva Pty Ltd pays infringement notices for late financial reports', 'canva-notice',
      'ASIC issued infringement notices and a financial penalty for late reports.', {
        subject_role: 'direct_actor', adverse: 'confirmed', categories: ['regulatory_and_governance'],
        legal_stage: 'regulatory_action', summary: 'Canva Group paid infringement notices for late financial reports.'
      })
  ] });
  assert.equal(canva.results[0].legal_stage, 'regulatory_action');
});

test('a former employee conviction cannot be attributed to Equifax itself', async () => {
  const response = await screenFixture({ name: 'Equifax Inc', entity_type: 'business', articles: [
    article('Former Equifax Inc employee convicted of insider trading', 'equifax-employee',
      'A former employee was convicted after trading in Equifax securities.', {
        subject_role: 'related_party', adverse: 'possible', legal_stage: 'media_mention',
        summary: 'A former employee, not Equifax, was convicted.'
      }),
    article('Equifax Inc reaches data-breach settlement with regulators', 'equifax-settlement',
      'Equifax agreed to pay a penalty as part of a regulatory settlement.', {
        subject_role: 'direct_actor', adverse: 'confirmed', categories: ['regulatory_and_governance'],
        legal_stage: 'settled', summary: 'Equifax settled a regulatory data-breach matter.'
      })
  ] });
  assert.equal(response.summary.outcome, 'high_risk');
  assert.equal(response.media_buckets.general_news_mentions.find((result) => result.url.endsWith('equifax-employee')).subject_role, 'related_party');
  assert.equal(response.media_buckets.general_news_mentions.find((result) => result.url.endsWith('equifax-employee')).risk_score, null);
  assert.equal(response.results.find((result) => result.url.endsWith('equifax-settlement')).legal_stage, 'settled');
});

test('all 25 retained hits receive AI classification across bounded batches', async () => {
  const batches = [];
  const articles = Array.from({ length: 25 }, (_, index) => article(
    `Acme Audit Holdings regulatory fraud settlement case ${index + 1}`,
    `acme-settlement-${index + 1}`,
    `Acme Audit Holdings paid a regulator fine in case ${index + 1} after a documented compliance violation.`,
    { subject_role: 'direct_actor', adverse: 'confirmed', legal_stage: 'settled',
      summary: 'The regulator fined Acme Audit Holdings for a documented compliance violation.' }
  ));
  const response = await screenFixture({ name: 'Acme Audit Holdings', entity_type: 'business',
    max_results: 25, articles, onAiBatch: (size) => batches.push(size) });
  assert.equal(response.status, 'completed');
  assert.deepEqual(batches, [15, 10]);
  assert.equal(response.media_buckets.adverse_media.length, 25);
  assert.equal(response.results.length, 25);
  assert.equal(response.summary.media_bucket_counts.adverse_media, 25);
});

test('one malformed full Gemini batch splits once and still classifies every result', async () => {
  const request = validateAdverseMediaRequest({ entity_type: 'business', name: 'Acme Split Test', languages: ['en'] });
  const candidates = Array.from({ length: 15 }, (_, index) => ({
    result_id: `split-${index}`, title: `Acme Split Test regulatory fine ${index}`,
    excerpt: 'Acme Split Test paid a documented regulatory fine.'
  }));
  const sizes = [];
  const fetchImpl = async (_url, options) => {
    const prompt = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
    sizes.push(prompt.evidence.length);
    if (prompt.evidence.length === 15) return Response.json({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });
    const classifications = prompt.evidence.map((item) => ({
      result_id: item.result_id, entity_match: 'confirmed', subject_role: 'direct_actor',
      media_bucket: 'adverse_media', adverse: 'confirmed', categories: ['regulatory_and_governance'],
      legal_stage: 'regulatory_action', confidence: 0.95, summary: 'The company paid a regulatory fine.'
    }));
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ classifications }) }] } }] });
  };
  const classified = await classifyWithAi(candidates, request, 'test-key', fetchImpl, null, 'split-fixture');
  assert.deepEqual(sizes, [15, 8, 7]);
  assert.equal(classified.results.length, 15);
  assert.ok(classified.results.every((result) => result.ai_classification.confidence === 0.95));
});

test('a CEO quoted about a company incident is not a personal adverse finding', () => {
  const ai_classification = { confidence: 0.99, media_bucket: 'adverse_media',
    subject_role: 'direct_actor', entity_match: 'confirmed', adverse: 'confirmed' };
  const entity = { entity_type: 'individual', name: 'Satya Nadella', aliases: [] };
  assert.equal(mediaBucket({ title: 'Microsoft researchers leaked company data',
    excerpt: 'Microsoft CEO Satya Nadella addressed the company data leak.',
    source_reliability_score: 0.68, ai_classification }, entity), 'general_news_mentions');
  assert.equal(mediaBucket({ title: 'Founder sentenced in a fraud case',
    excerpt: 'Satya Nadella was sentenced to prison for fraud.',
    source_reliability_score: 0.68, ai_classification }, entity), 'adverse_media');
});

test('an employee indictment cannot become a direct company finding even if AI over-attributes it', () => {
  const ai_classification = { confidence: 0.99, media_bucket: 'adverse_media',
    subject_role: 'direct_actor', entity_match: 'confirmed', adverse: 'confirmed' };
  const company = { entity_type: 'business', name: 'Equifax Inc', aliases: [] };
  assert.equal(mediaBucket({ title: 'Former Equifax executive pleads guilty to insider trading',
    excerpt: 'A former executive was convicted.', ai_classification }, company), 'general_news_mentions');
  assert.equal(mediaBucket({ title: 'Equifax Inc settles with regulator over data breach',
    excerpt: 'Equifax Inc paid a settlement.', ai_classification }, company), 'adverse_media');
});
