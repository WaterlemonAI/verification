import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentAdverseMediaResponse, screenAdverseMedia, validateAdverseMediaRequest } from '../lib/adverse-media.mjs';

test('a named Indonesian issuer in an OJK enforcement notice is retained for review without attributing other parties fines to it', async () => {
  const request = validateAdverseMediaRequest({
    entity_type: 'business', name: 'PT Dian Swastatika Sentosa Tbk', max_results: 10
  });
  const queries = [];
  let aiDisposition = 'possible';
  const officialResult = {
    title: 'OJK Putuskan Sanksi Pihak Terkait Emiten DSSA, BREN, dan CUAN',
    url: 'https://ojk.go.id/id/berita-dan-kegiatan/siaran-pers/Pages/OJK-Putuskan-Sanksi-Pihak-Terkait-Emiten-DSSA-BREN-dan-CUAN.aspx',
    description: 'OJK mengenakan sanksi kepada pihak-pihak terkait transaksi saham PT Dian Swastatika Sentosa Tbk. OJK menemukan manipulasi pasar saham DSSA.',
    page_age: '2026-10-16T00:00:00Z',
    meta_url: { hostname: 'ojk.go.id' }
  };
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      const query = url.searchParams.get('q');
      queries.push(query);
      if (query.includes('site:ojk.go.id')) assert.equal(url.searchParams.get('search_lang'), 'en');
      const results = query.includes('site:ojk.go.id') && query.includes('sanksi') ? [officialResult] : [];
      return url.pathname.includes('/news/') ? Response.json({ results }) : Response.json({ web: { results } });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    if (url.hostname === 'www.cbr.ru') return Response.json({ Data: [] });
    if (url.hostname === 'generativelanguage.googleapis.com') {
      const prompt = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
      assert.equal(prompt.evidence.length, 1);
      return Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ classifications: [{
          result_id: prompt.evidence[0].result_id,
          entity_match: 'confirmed', subject_role: 'related_party', media_bucket: 'general_news_mentions', adverse: aiDisposition, categories: ['regulatory_and_governance'],
          legal_stage: 'regulatory_action', confidence: 0.94,
          summary: 'The notice concerns trading in DSSA shares; OJK sanctioned parties involved, not the issuer.'
        }] }) }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80 }
      });
    }
    throw new Error(`Unexpected host: ${url.hostname}`);
  };

  const response = presentAdverseMediaResponse(await screenAdverseMedia({
    request, apiKey: 'test-search-key', aiApiKey: 'test-ai-key', fetchImpl
  }));
  assert.ok(queries.some((query) => query.includes('site:ojk.go.id') && query.includes('sanksi')));
  assert.ok(queries.length <= 12);
  assert.equal(response.status, 'completed');
  assert.ok(response.coverage.regional_packs.includes('indonesia'));
  assert.equal(response.summary.threshold_status, 'safe');
  assert.equal(response.summary.profile_status, 'safe');
  assert.equal(response.results.length, 0);
  assert.equal(response.media_buckets.general_news_mentions.length, 1);
  assert.match(response.media_buckets.general_news_mentions[0].evidence_assessment, /related party/i);

  // A high-confidence model negative must not silently clear an exact-name
  // official enforcement lead. Use a different request key to avoid the cache.
  aiDisposition = 'not_adverse';
  const conflicting = presentAdverseMediaResponse(await screenAdverseMedia({
    request: validateAdverseMediaRequest({ entity_type: 'business', name: 'PT Dian Swastatika Sentosa Tbk', countries: ['ID'] }),
    apiKey: 'test-search-key', aiApiKey: 'test-ai-key', fetchImpl
  }));
  assert.equal(conflicting.summary.threshold_status, 'safe');
  assert.equal(conflicting.results.length, 0);
  assert.match(conflicting.media_buckets.general_news_mentions[0].evidence_assessment, /human review/i);

  // The reported production run used five languages and Search+. Its old
  // ordering spent the standard budget on news before any official web query.
  aiDisposition = 'possible';
  const beforeSearchPlus = queries.length;
  const searchPlus = presentAdverseMediaResponse(await screenAdverseMedia({
    request: validateAdverseMediaRequest({
      entity_type: 'business', name: 'PT Dian Swastatika Sentosa Tbk',
      languages: ['en', 'ar', 'ru', 'hi', 'zh'], search_plus: true,
      review_threshold_percent: 80, high_risk_threshold_percent: 91
    }),
    apiKey: 'test-search-key', aiApiKey: 'test-ai-key', fetchImpl
  }));
  assert.ok(queries.slice(beforeSearchPlus).some((query) => query.includes('site:ojk.go.id')));
  assert.ok(queries.length - beforeSearchPlus <= 12);
  assert.equal(searchPlus.summary.threshold_status, 'safe');
  assert.equal(searchPlus.media_buckets.general_news_mentions.length, 1);
  assert.equal(searchPlus.coverage.sources.find((source) => source.source === 'open_web').status, 'complete');
  assert.match(searchPlus.coverage.limitation, /does not offer an Indonesian language filter/);
  assert.deepEqual(searchPlus.coverage.languages_requested.map((item) => item.code), ['en', 'ar', 'ru', 'hi', 'zh']);
  assert.deepEqual(searchPlus.coverage.languages_not_searched, []);
  for (const code of ['en', 'ar', 'ru', 'hi', 'zh']) {
    assert.ok(searchPlus.coverage.languages_searched.some((item) => item.code === code));
  }
  assert.ok(searchPlus.coverage.search_plus.publisher_batches_attempted > 0);
});

test('a non-adverse official disclosure containing an investigation disclaimer cannot set High Risk', async () => {
  const disclosure = {
    title: 'KETERBUKAAN INFORMASI PT DIAN SWASTATIKA SENTOSA TBK',
    url: 'https://www.idx.co.id/StaticData/NewsAndAnnouncement/announcement.pdf',
    description: 'KR tidak bertanggung jawab untuk melakukan penyelidikan atas informasi tersebut.',
    meta_url: { hostname: 'idx.co.id' }
  };
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'api.search.brave.com') {
      return url.pathname.includes('/news/')
        ? Response.json({ results: [] }) : Response.json({ web: { results: [disclosure] } });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    if (url.hostname === 'generativelanguage.googleapis.com') {
      const prompt = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ classifications: [{
        result_id: prompt.evidence[0].result_id,
        entity_match: 'confirmed', subject_role: 'context_only', media_bucket: 'general_news_mentions', adverse: 'not_adverse', categories: ['crime_and_enforcement'],
        legal_stage: 'media_mention', confidence: 0.8,
        summary: 'This is an ordinary disclosure without adverse conduct.'
      }] }) }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60 } });
    }
    throw new Error(`Unexpected host: ${url.hostname}`);
  };
  const result = presentAdverseMediaResponse(await screenAdverseMedia({
    request: validateAdverseMediaRequest({ entity_type: 'business', name: 'PT Dian Swastatika Sentosa Tbk',
      countries: ['ID'], languages: ['en'] }),
    apiKey: 'test-search-key', aiApiKey: 'test-ai-key', fetchImpl
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.outcome, 'no_material_results');
  assert.equal(result.results.length, 0);
});
