import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.API_PUBLIC_BASE_URL = 'https://api.ai7uae.com';
const apiKey = 'ai7_adverse_test_key';
process.env.AI7_API_KEY_HASHES = createHash('sha256').update(apiKey).digest('hex');

const { createAppServer } = await import('../server.mjs');
const { EnvironmentStore } = await import('../lib/api-store.mjs');

const store = new EnvironmentStore();
await store.setMasterKey('adverse-media', 'private-search-key');
await store.setMasterKey('adverse-media-ai', 'private-ai-key');

let app;
let appUrl;
const requests = [];

const indexedResult = {
  title: 'John Example charged in international fraud investigation',
  url: 'https://publisher.example/news/john-example?utm_source=test',
  description: 'Prosecutors charged John Example with fraud and money laundering after an investigation.',
  page_age: '2026-10-20T10:00:00Z',
  meta_url: { hostname: 'publisher.example' },
  extra_snippets: ['The criminal prosecution remains before the court.']
};

before(async () => {
  app = createAppServer({
    store,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.hostname === 'api.search.brave.com') {
        assert.equal(options.headers['x-subscription-token'], 'private-search-key');
        const query = url.searchParams.get('q');
        const failureCheck = query.includes('AI Failure Example');
        const schemaEscapeCheck = query.includes('Schema Escape Example');
        const chinaCheck = query.includes('华信科技');
        const russiaCheck = query.includes('ООО Ромашка');
        const regionalCheck = query.includes('Region Example');
        const mismatchCheck = query.includes('Prabhpreet Singh Gill');
        const associationCheck = query.includes('Pay10') || query.includes('Harry Gill');
        const highConfidenceMismatchCheck = query.includes('Query Person Mismatch');
        const partialNameCheck = query.includes('Ansh Bodele');
        const coverageFailureCheck = query.includes('Coverage Failure Example');
        assert.ok(query.includes('John Example') || failureCheck || schemaEscapeCheck || chinaCheck || russiaCheck || regionalCheck || mismatchCheck || associationCheck || highConfidenceMismatchCheck || partialNameCheck || coverageFailureCheck);
        if (coverageFailureCheck) return Response.json({ error: 'temporary' }, { status: 503 });
        let result = url.searchParams.get('search_lang') === 'de' ? {
          ...indexedResult,
          title: 'John Example wegen Betrug angeklagt',
          description: 'Die Ermittlungen wegen Geldwäsche und Korruption dauern an.'
        } : indexedResult;
        if (failureCheck) result = {
          ...indexedResult,
          title: 'AI Failure Example charged in fraud investigation',
          url: 'https://publisher.example/news/ai-failure',
          description: 'Prosecutors charged AI Failure Example with fraud.'
        };
        if (schemaEscapeCheck) result = {
          ...indexedResult,
          title: 'Schema Escape Example charged in fraud investigation',
          url: 'https://publisher.example/news/schema-escape',
          description: 'Prosecutors charged Schema Escape Example with fraud.'
        };
        if (chinaCheck) result = {
          ...indexedResult,
          title: '华信科技因欺诈被立案调查',
          url: 'https://news.example.cn/华信科技-调查',
          description: '监管机构对华信科技涉嫌欺诈和非法集资立案调查。',
          meta_url: { hostname: 'news.example.cn' }
        };
        if (russiaCheck) result = {
          ...indexedResult,
          title: 'ООО Ромашка: расследование мошенничества',
          url: 'https://news.example.ru/romashka-investigation',
          description: 'Начато расследование в отношении ООО Ромашка по делу о мошенничестве.',
          meta_url: { hostname: 'news.example.ru' }
        };
        if (mismatchCheck) result = {
          ...indexedResult,
          title: query.includes('"founder"')
            ? 'About Us - Pay10 Global'
            : 'Prabhpreet Singh Gill named in fraud investigation',
          url: query.includes('"founder"')
            ? 'https://publisher.example/profile/prabhpreet-singh-gill'
            : 'https://publisher.example/news/prabhpreet-singh-gill',
          description: query.includes('"founder"')
            ? 'Leadership includes Prabhpreet Singh Gill (Harry Gill).'
            : 'Authorities investigated Prabhpreet Singh Gill over alleged fraud.'
        };
        if (associationCheck) result = {
          ...indexedResult,
          title: 'Authorities investigate Pay10 in money laundering probe',
          url: 'https://publisher.example/news/pay10-investigation',
          description: 'The investigation concerns Pay10, founded by Prabhpreet Singh Gill, also known as Harry Gill.'
        };
        if (partialNameCheck) result = {
          ...indexedResult,
          title: 'Ansh mentioned in unrelated community report',
          url: 'https://publisher.example/news/unrelated-ansh',
          description: 'The report concerns another individual with a different family name.'
        };
        if (highConfidenceMismatchCheck) result = {
          ...indexedResult,
          title: 'Search for Query Person Mismatch surfaces case concerning another person',
          url: 'https://publisher.example/news/another-person',
          description: 'Authorities investigated another person over alleged fraud; Query Person Mismatch was not the subject.'
        };
        if (url.pathname.includes('/news/')) return Response.json({ results: [result] });
        return Response.json({ web: { results: [result] } });
      }
      if (url.hostname === 'api.gdeltproject.org') {
        assert.equal(options.headers['x-subscription-token'], undefined);
        assert.equal(url.searchParams.get('format'), 'json');
        assert.equal(url.searchParams.get('timespan'), '1y');
        const failureCheck = url.searchParams.get('query').includes('AI Failure Example');
        const schemaEscapeCheck = url.searchParams.get('query').includes('Schema Escape Example');
        const chinaCheck = url.searchParams.get('query').includes('华信科技');
        const russiaCheck = url.searchParams.get('query').includes('ООО Ромашка');
        const mismatchCheck = url.searchParams.get('query').includes('Prabhpreet Singh Gill');
        const highConfidenceMismatchCheck = url.searchParams.get('query').includes('Query Person Mismatch');
        const partialNameCheck = url.searchParams.get('query').includes('Ansh Bodele');
        const coverageFailureCheck = url.searchParams.get('query').includes('Coverage Failure Example');
        return Response.json({ articles: [{
          title: failureCheck ? 'AI Failure Example charged in fraud investigation'
            : schemaEscapeCheck ? 'Schema Escape Example charged in fraud investigation'
              : chinaCheck ? '华信科技因欺诈被立案调查'
                : russiaCheck ? 'ООО Ромашка: расследование мошенничества'
                  : mismatchCheck ? 'Prabhpreet Singh Gill named in fraud investigation'
                    : highConfidenceMismatchCheck ? 'Search for Query Person Mismatch surfaces case concerning another person'
                      : partialNameCheck ? 'Ansh mentioned in unrelated community report'
                        : coverageFailureCheck ? 'Coverage Failure Example charged in fraud investigation'
                  : indexedResult.title,
          url: failureCheck ? 'https://publisher.example/news/ai-failure'
            : schemaEscapeCheck ? 'https://publisher.example/news/schema-escape'
              : chinaCheck ? 'https://news.example.cn/华信科技-调查'
                : russiaCheck ? 'https://news.example.ru/romashka-investigation'
                  : mismatchCheck ? 'https://publisher.example/news/prabhpreet-singh-gill'
                    : highConfidenceMismatchCheck ? 'https://publisher.example/news/another-person'
                      : partialNameCheck ? 'https://publisher.example/news/unrelated-ansh'
                        : coverageFailureCheck ? 'https://publisher.example/news/coverage-failure'
                  : indexedResult.url,
          domain: chinaCheck ? 'news.example.cn' : russiaCheck ? 'news.example.ru' : 'publisher.example',
          seendate: '20261020T100000Z',
          language: chinaCheck ? 'Chinese' : russiaCheck ? 'Russian' : 'English'
        }] });
      }
      if (url.hostname === 'www.cbr.ru') {
        assert.equal(url.pathname, '/warninglistapi/Search');
        assert.equal(url.searchParams.get('sphrase'), 'ООО Ромашка');
        assert.equal(url.searchParams.get('page'), '0');
        assert.equal(options.headers['x-subscription-token'], undefined);
        return Response.json({ Data: [{
          id: 41001,
          dt: '2026-10-18',
          nameOrg: 'ООО Ромашка',
          comment: 'Признаки нелегальной деятельности на финансовом рынке'
        }] });
      }
      if (url.hostname === 'generativelanguage.googleapis.com') {
        assert.equal(options.headers['x-goog-api-key'], 'private-ai-key');
        assert.match(url.pathname, /gemini-3\.5-flash-lite:generateContent$/);
        const payload = JSON.parse(options.body);
        const prompt = JSON.parse(payload.contents[0].parts[0].text);
        if (prompt.job === 'transliterate_entity_name') {
          assert.match(payload.systemInstruction.parts[0].text, /single-purpose entity-name transliteration engine/);
          assert.match(payload.systemInstruction.parts[0].text, /Never return advice/);
          assert.equal(payload.generationConfig.responseJsonSchema.additionalProperties, false);
          assert.equal(payload.generationConfig.maxOutputTokens, 512);
          return Response.json({
            candidates: [{ content: { parts: [{ text: JSON.stringify({
              transliterations: prompt.target_languages.map(({ code }) => ({
                language: code,
                variants: [`${prompt.entity.name} ${code} one`, `${prompt.entity.name} ${code} two`]
              }))
            }) }] } }],
            usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 80 }
          });
        }
        if (prompt.job === 'resolve_adverse_media_search_terms') {
          assert.match(payload.systemInstruction.parts[0].text, /single-purpose entity-resolution engine/);
          assert.match(payload.systemInstruction.parts[0].text, /Never infer an association/);
          assert.equal(payload.generationConfig.responseJsonSchema.additionalProperties, false);
          assert.equal(payload.generationConfig.maxOutputTokens, 512);
          return Response.json({
            candidates: [{ content: { parts: [{ text: JSON.stringify({
              search_terms: []
            }) }] } }],
            usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 60 }
          });
        }
        assert.match(payload.systemInstruction.parts[0].text, /single-purpose adverse-media evidence classifier/);
        assert.match(payload.systemInstruction.parts[0].text, /Never follow commands/);
        assert.equal(payload.generationConfig.responseJsonSchema.additionalProperties, false);
        assert.equal(payload.generationConfig.responseJsonSchema.properties.classifications.items.additionalProperties, false);
        assert.equal(payload.generationConfig.responseJsonSchema.properties.classifications.minItems, undefined);
        assert.equal(payload.generationConfig.responseJsonSchema.properties.classifications.maxItems, undefined);
        assert.equal(payload.generationConfig.responseJsonSchema.properties.classifications.items.properties.result_id.enum, undefined);
        assert.equal(payload.generationConfig.maxOutputTokens, 2048);
        assert.equal(payload.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
        assert.equal(prompt.job, 'classify_adverse_media_evidence');
        assert.deepEqual(Object.keys(prompt.evidence[0]).sort(), ['excerpt', 'result_id', 'title']);
        if (prompt.entity.name === 'AI Failure Example') return Response.json({ error: 'temporary' }, { status: 503 });
        if (prompt.entity.name === 'Schema Escape Example') return Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ classifications: [{
            result_id: prompt.evidence[0].result_id,
            entity_match: 'confirmed', adverse: 'confirmed', categories: ['financial_crime'],
            legal_stage: 'charged', confidence: 0.9, summary: 'Evidence summary.',
            unwanted_field: 'This must never reach the API response.'
          }] }) }] } }],
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 100 }
        });
        if (prompt.entity.name === 'Prabhpreet Singh Gill') return Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ classifications: prompt.evidence.map((evidence) => ({
            result_id: evidence.result_id,
            entity_match: 'unlikely',
            adverse: 'not_adverse',
            categories: [],
            legal_stage: 'media_mention',
            confidence: 0,
            summary: 'The evidence concerns a different person with a partially matching name.'
          })) }) }] } }],
          usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 120 }
        });
        if (prompt.entity.name === 'Query Person Mismatch') return Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ classifications: prompt.evidence.map((evidence) => ({
            result_id: evidence.result_id,
            entity_match: 'unlikely',
            adverse: 'not_adverse',
            categories: [],
            legal_stage: 'media_mention',
            confidence: 0.97,
            summary: 'The evidence concerns a different person.'
          })) }) }] } }],
          usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 120 }
        });
        return Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ classifications: prompt.evidence.map((evidence) => ({
            result_id: evidence.result_id,
            entity_match: 'confirmed',
            adverse: 'confirmed',
            categories: ['financial_crime'],
            legal_stage: 'charged',
            confidence: 0.94,
            summary: 'The supplied evidence describes potentially adverse conduct involving the named entity.'
          })) }) }] } }],
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 }
        });
      }
      throw new Error(`Unexpected host: ${url.hostname}`);
    }
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${app.address().port}`;
});

after(async () => new Promise((resolve) => app.close(resolve)));

test('adverse media endpoint returns a customer-safe evidence response', async () => {
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      entity_type: 'individual',
      name: 'John Example',
      aliases: ['J Example'],
      countries: ['AE'],
      languages: ['en'],
      date_from: '2025-01-01',
      max_results: 25
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'completed');
  assert.equal(body.entity.name, 'John Example');
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].legal_stage, 'charged');
  assert.ok(body.results[0].categories.includes('financial_crime'));
  assert.equal(body.results[0].url, 'https://publisher.example/news/john-example');
  assert.equal(body.results[0].review_required, true);
  assert.equal(body.summary.risk_threshold, 0.65);
  assert.deepEqual(body.summary.thresholds, { high_risk_percent: 90, review_percent: 65, safe_below_percent: 65 });
  assert.equal(body.summary.results_at_or_above_threshold, 1);
  assert.equal(body.summary.threshold_status, 'high_risk');
  assert.equal(body.summary.risk_distribution.high_risk, 1);
  assert.equal(body.results[0].risk_level, 'high');
  assert.deepEqual(Object.keys(body).sort(), ['completed_at', 'coverage', 'entity', 'report', 'results', 'screening_id', 'status', 'summary']);
  assert.equal(body.report.transaction_id, body.screening_id);
  assert.equal(body.report.retention, 'permanent');
  assert.match(body.report.sha256, /^[0-9a-f]{64}$/);
  assert.match(body.report.download_url, /^https:\/\/api\.ai7uae\.com\/service\/adverse_media\/reports\/[0-9a-f-]{36}\.pdf$/);
  const reportResponse = await fetch(`${appUrl}${new URL(body.report.download_url).pathname}`);
  assert.equal(reportResponse.status, 200);
  assert.equal(reportResponse.headers.get('content-type'), 'application/pdf');
  assert.equal(reportResponse.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(reportResponse.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(Buffer.from(await reportResponse.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const missingReport = await fetch(`${appUrl}/service/adverse_media/reports/00000000-0000-4000-8000-000000000000.pdf`);
  assert.equal(missingReport.status, 404);
  assert.equal(body.methodology, undefined);
  assert.equal(body.usage, undefined);
  assert.equal(body.transliterations, undefined);
  for (const field of ['ai_classification', 'matched_terms', 'entity_match_score', 'adverse_relevance_score', 'source_reliability_score', 'severity_score', 'final_disposition']) {
    assert.equal(body.results[0][field], undefined);
  }
  assert.equal(requests.length, 6);
});

test('identical checks reuse cached evidence without paid search calls', async () => {
  const paidSearchCount = () => requests.filter(({ url }) => url.hostname === 'api.search.brave.com').length;
  const beforeCount = paidSearchCount();
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      entity_type: 'individual', name: 'John Example', aliases: ['J Example'], countries: ['AE'],
      languages: ['en'], date_from: '2025-01-01', risk_threshold: 1, max_results: 25
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.summary.risk_threshold, 1);
  assert.equal(body.summary.results_at_or_above_threshold, 0);
  assert.equal(body.summary.human_review_required, false);
  assert.equal(body.summary.threshold_status, 'safe');
  assert.equal(body.summary.risk_level, 'safe');
  assert.equal(body.results[0].risk_level, 'safe');
  assert.equal(body.results[0].review_required, false);
  assert.equal(paidSearchCount(), beforeCount);
});

test('customers can configure High Risk and Review percentage bands', async () => {
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      entity_type: 'individual', name: 'John Example', aliases: ['J Example'], countries: ['AE'],
      languages: ['en'], date_from: '2025-01-01', high_risk_threshold_percent: 95,
      review_threshold_percent: 91, max_results: 25
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.summary.thresholds, { high_risk_percent: 95, review_percent: 91, safe_below_percent: 91 });
  const expectedBand = body.results[0].risk_score >= 0.95 ? 'high' : body.results[0].risk_score >= 0.91 ? 'review' : 'safe';
  assert.equal(body.results[0].risk_level, expectedBand);
  assert.equal(body.summary.risk_distribution[expectedBand === 'high' ? 'high_risk' : expectedBand], 1);
  assert.equal(body.results[0].review_required, expectedBand !== 'safe');
});

test('uses native adverse-event terms for a non-English language pack', async () => {
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'individual', name: 'John Example', languages: ['de'], max_results: 5 })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.coverage.languages_searched[0].code, 'de');
  assert.ok(body.results[0].categories.includes('financial_crime'));
  assert.equal(body.results[0].legal_stage, 'charged');
});

test('China pack uses native terms, official-domain targeting, and an archive language filter without extra paid queries', async () => {
  const beforeCount = requests.length;
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'business', name: '华信科技', countries: ['CN'], languages: ['zh'], max_results: 5 })
  });
  const body = await response.json();
  const callSet = requests.slice(beforeCount);
  const paidCalls = callSet.filter(({ url }) => url.hostname === 'api.search.brave.com');
  const archiveCall = callSet.find(({ url }) => url.hostname === 'api.gdeltproject.org');
  const officialWebCall = paidCalls.find(({ url }) => url.pathname.includes('/web/'));
  assert.equal(response.status, 200);
  assert.equal(paidCalls.length, 3);
  assert.ok(paidCalls.every(({ url }) => url.searchParams.get('search_lang') === 'zh-hans'));
  assert.match(officialWebCall.url.searchParams.get('q'), /site:csrc\.gov\.cn/);
  assert.match(officialWebCall.url.searchParams.get('q'), /立案调查/);
  assert.match(archiveCall.url.searchParams.get('query'), /sourcelang:chinese/);
  assert.ok(paidCalls.every(({ url }) => url.searchParams.get('q').includes('华信科技')));
  assert.ok(body.results[0].categories.includes('financial_crime'));
});

test('Russia business pack includes free structured regulatory evidence without extra paid queries', async () => {
  const beforeCount = requests.length;
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'business', name: 'ООО Ромашка', countries: ['RU'], languages: ['ru'], max_results: 10 })
  });
  const body = await response.json();
  const callSet = requests.slice(beforeCount);
  const paidCalls = callSet.filter(({ url }) => url.hostname === 'api.search.brave.com');
  const archiveCall = callSet.find(({ url }) => url.hostname === 'api.gdeltproject.org');
  assert.equal(response.status, 200);
  assert.equal(paidCalls.length, 3);
  assert.match(archiveCall.url.searchParams.get('query'), /sourcelang:russian/);
  const officialResult = body.results.find((result) => result.source_type === 'official_regulatory');
  assert.ok(officialResult);
  assert.equal(officialResult.publisher, 'cbr.ru');
  assert.match(officialResult.url, /id=41001$/);
  assert.equal(officialResult.legal_stage, 'regulatory_action');
});

test('Gulf, India, USA, and ANZ packs target regional official domains without extra paid queries', async () => {
  const cases = [
    { id: 'gulf', name: 'Gulf Region Example', countries: ['AE', 'SA', 'QA', 'KW', 'BH', 'OM'], languages: ['ar'], domain: 'site:gov.ae' },
    { id: 'india', name: 'India Region Example', countries: ['IN'], languages: ['en'], domain: 'site:sebi.gov.in' },
    { id: 'usa', name: 'USA Region Example', countries: ['US'], languages: ['en'], domain: 'site:sec.gov' },
    { id: 'anz', name: 'ANZ Region Example', countries: ['AU', 'NZ'], languages: ['en'], domain: 'site:asic.gov.au' }
  ];

  for (const regionalCase of cases) {
    const beforeCount = requests.length;
    const response = await fetch(`${appUrl}/service/adverse_media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_type: 'business', name: regionalCase.name, countries: regionalCase.countries,
        languages: regionalCase.languages, max_results: 5
      })
    });
    const body = await response.json();
    const callSet = requests.slice(beforeCount);
    const paidCalls = callSet.filter(({ url }) => url.hostname === 'api.search.brave.com');
    const officialWebCall = paidCalls.find(({ url }) => url.pathname.includes('/web/'));
    assert.equal(response.status, 200);
    assert.equal(paidCalls.length, 3);
    assert.ok(officialWebCall.url.searchParams.get('q').includes(regionalCase.domain));
  }
});

test('returns deterministic evidence when optional AI classification is unavailable', async () => {
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'business', name: 'AI Failure Example', languages: ['en'], max_results: 5 })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].ai_classification, undefined);
  assert.equal(body.status, 'partial');
  assert.equal(body.summary.decision_eligible, false);
  assert.equal(body.summary.threshold_status, 'incomplete_coverage');
  assert.equal(body.methodology, undefined);
  assert.equal(body.usage, undefined);
});

test('does not suppress exact-name adverse evidence using a zero-confidence AI negative', async () => {
  const beforeCount = requests.length;
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'individual', name: 'Prabhpreet Singh Gill', countries: ['IN'], languages: ['en'], max_results: 5 })
  });
  const body = await response.json();
  const paidCalls = requests.slice(beforeCount).filter(({ url }) => url.hostname === 'api.search.brave.com');
  assert.equal(response.status, 200);
  assert.equal(body.status, 'completed');
  assert.ok(body.results.length >= 1);
  assert.ok(body.results.some((result) => /Prabhpreet Singh Gill|Pay10/.test(result.title)));
  assert.equal(body.summary.potentially_relevant_results, body.results.length);
  assert.equal(body.summary.raw_candidate_results, undefined);
  assert.equal(body.summary.ai_excluded_results, undefined);
  assert.ok(body.summary.results_at_or_above_threshold >= 1);
  assert.equal(body.summary.risk_level, 'high');
  assert.equal(body.summary.human_review_required, true);
  assert.equal(body.summary.decision_eligible, true);
  assert.ok(paidCalls.length <= 12);
  assert.ok(paidCalls.some(({ url }) => {
    const query = url.searchParams.get('q');
    return query.includes('Prabhpreet Singh Gill') && query.includes('"founder"') && query.includes('"also known as"');
  }));
  assert.ok(paidCalls.some(({ url }) => {
    const query = url.searchParams.get('q');
    return query.includes('Pay10') && query.includes('Harry Gill') && query.includes('"money laundering"')
      && !query.includes('"embezzlement"');
  }));
});

test('rejects one-token individual-name noise before AI classification', async () => {
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'individual', name: 'Ansh Bodele', languages: ['en'], max_results: 5 })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'completed');
  assert.equal(body.results.length, 0);
  assert.equal(body.summary.outcome, 'no_material_results');
  assert.equal(body.summary.risk_level, 'no_material_results');
});

test('suppresses only high-confidence AI-confirmed mismatches', async () => {
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'individual', name: 'Query Person Mismatch', languages: ['en'], max_results: 5 })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'completed');
  assert.equal(body.results.length, 0);
  assert.equal(body.summary.outcome, 'no_material_results');
});

test('retries transient provider failures and reports partial coverage instead of completed', async () => {
  const beforeCount = requests.length;
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'business', name: 'Coverage Failure Example', languages: ['en'], max_results: 5 })
  });
  const body = await response.json();
  const paidCalls = requests.slice(beforeCount).filter(({ url }) => url.hostname === 'api.search.brave.com');
  assert.equal(response.status, 200);
  assert.equal(paidCalls.length, 6);
  assert.equal(body.status, 'partial');
  assert.equal(body.coverage.complete, false);
  assert.equal(body.summary.outcome, 'inconclusive');
  assert.equal(body.summary.risk_level, 'indeterminate');
  assert.deepEqual(body.coverage.sources, [
    { source: 'current_news', status: 'unavailable' },
    { source: 'open_web', status: 'unavailable' },
    { source: 'archive', status: 'complete' },
    { source: 'official_records', status: 'not_requested' }
  ]);
  assert.deepEqual(body.coverage.reason_codes, ['current_news_unavailable', 'open_web_unavailable']);
  assert.equal(body.coverage.retryable, true);
  assert.equal(body.coverage.source_status, undefined);
  assert.equal(body.coverage.indexes_attempted, undefined);
  assert.equal(body.summary.decision_eligible, false);
  assert.equal(body.summary.threshold_status, 'incomplete_coverage');
  assert.equal(body.summary.human_review_required, true);
});

test('rejects model output containing fields outside the strict classification contract', async () => {
  const response = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'business', name: 'Schema Escape Example', languages: ['en'], max_results: 5 })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.results[0].ai_classification, undefined);
  assert.equal(body.methodology, undefined);
  assert.equal(JSON.stringify(body).includes('unwanted_field'), false);
  assert.equal(JSON.stringify(body).includes('This must never reach'), false);
});

test('adverse media endpoint validates credentials and input', async () => {
  const unauthorized = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity_type: 'business', name: 'Example LLC' })
  });
  assert.equal(unauthorized.status, 401);

  const invalid = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'person', name: 'A', languages: ['en', 'ar', 'fr', 'es', 'ru', 'hi'] })
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /entity_type|name|languages/);

  const invalidThreshold = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'business', name: 'Example LLC', risk_threshold: 1.1 })
  });
  assert.equal(invalidThreshold.status, 400);
  assert.match((await invalidThreshold.json()).error, /risk_threshold/);

  const invalidThresholdOrder = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      entity_type: 'business', name: 'Example LLC', review_threshold_percent: 91, high_risk_threshold_percent: 90
    })
  });
  assert.equal(invalidThresholdOrder.status, 400);
  assert.match((await invalidThresholdOrder.json()).error, /review_threshold_percent/);

  const callbackWithoutDeepResearch = await fetch(`${appUrl}/service/adverse_media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity_type: 'business', name: 'Example LLC', callback_url: 'https://example.com/webhook' })
  });
  assert.equal(callbackWithoutDeepResearch.status, 400);
  assert.match((await callbackWithoutDeepResearch.json()).error, /deep_research/);
});

test('deep research queues an optional signed HTTPS callback without exposing credentials', async () => {
  const jobs = [];
  const queue = { enqueue: async (job) => jobs.push(job) };
  const queuedApp = createAppServer({ store, fetchImpl: fetch, deepResearchQueue: queue, startWorker: false });
  await new Promise((resolve) => queuedApp.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${queuedApp.address().port}/service/adverse_media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_type: 'business', name: 'Example LLC', languages: ['en', 'ar'], deep_research: true,
        callback_url: 'https://example.com/ai7-webhook'
      })
    });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.status, 'queued');
    assert.equal(body.callback.configured, true);
    assert.equal(body.callback.signature_header, 'x-ai7-signature');
    assert.match(body.callback.signing_secret, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].screening_id, body.screening_id);
    assert.equal(jobs[0].callback_secret, body.callback.signing_secret);
    assert.equal(jobs[0].request.callback_url, '');
    assert.equal(JSON.stringify(body).includes('private-search-key'), false);
  } finally {
    await new Promise((resolve) => queuedApp.close(resolve));
  }
});

test('all-source outage fails closed with a customer-safe reason and transaction ID', async () => {
  const failedApp = createAppServer({ store, startWorker: false, deepResearchQueue: null,
    fetchImpl: async (input) => {
      const host = new URL(input).hostname;
      if (host === 'api.search.brave.com') return Response.json({ error: 'billing' }, { status: 402 });
      if (host === 'api.gdeltproject.org') return new Response('rate limited', { status: 429 });
      throw new Error('source_offline');
    } });
  await new Promise((resolve) => failedApp.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${failedApp.address().port}/service/adverse_media`, {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ entity_type: 'individual', name: 'Synthetic Outage Subject', languages: ['en'], regions: [] })
    });
    assert.equal(response.status, 502);
    assert.match(response.headers.get('x-ai7-transaction-id'), /^[a-f0-9-]{36}$/);
    const body = await response.json();
    assert.equal(body.reason_code, 'SEARCH_SOURCES_UNAVAILABLE');
    assert.equal(JSON.stringify(body).includes('billing'), false);
    assert.equal(JSON.stringify(body).includes('Synthetic Outage Subject'), false);
    assert.equal(JSON.stringify(body).includes('private-search-key'), false);
  } finally {
    await new Promise((resolve) => failedApp.close(resolve));
  }
});

test('public documentation exposes the complete route without provider or key details', async () => {
  const config = await (await fetch(`${appUrl}/service/adverse_media/config`)).json();
  assert.equal(config.maximum_ai_candidates, 15);
  assert.equal(config.cost_guardrail_usd, 0.15);
  assert.equal(config.default_risk_threshold, 0.65);
  assert.equal(config.default_review_threshold_percent, 65);
  assert.equal(config.default_high_risk_threshold_percent, 90);
  assert.deepEqual(config.regions.gulf.countries, ['AE', 'SA', 'QA', 'KW', 'BH', 'OM']);
  assert.deepEqual(config.regions.anz.countries, ['AU', 'NZ']);
  const html = await (await fetch(`${appUrl}/adverse-media`)).text();
  const script = await (await fetch(`${appUrl}/adverse-media.js`)).text();
  const specText = await (await fetch(`${appUrl}/openapi.json`)).text();
  const spec = JSON.parse(specText);
  assert.ok(Object.hasOwn(spec.paths, '/service/adverse_media'));
  for (const field of ['entity_type', 'name', 'aliases', 'countries', 'languages', 'date_from', 'date_to', 'high_risk_threshold_percent', 'review_threshold_percent', 'search_plus', 'max_results', 'deep_research', 'callback_url']) {
    assert.ok(Object.hasOwn(spec.components.schemas.AdverseMediaRequest.properties, field));
    assert.ok(html.includes(field));
  }
  for (const region of ['Gulf countries', 'India', 'United States', 'Australia &amp; New Zealand', 'China', 'Russia']) {
    assert.ok(html.includes(region));
  }
  for (const regionId of ['gulf', 'india', 'usa', 'anz', 'china', 'russia']) {
    assert.ok(script.includes(`${regionId}:`));
  }
  for (const publicAsset of [html, script, specText]) {
    for (const providerName of ['brave', 'gdelt', 'gemini', 'cbr.ru']) assert.equal(publicAsset.toLowerCase().includes(providerName), false);
    assert.equal(publicAsset.includes('private-search-key'), false);
  }
});
