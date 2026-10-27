import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentAdverseMediaResponse, screenAdverseMedia, validateAdverseMediaRequest } from '../lib/adverse-media.mjs';

test('a named Indonesian issuer in an OJK enforcement notice is retained for review without attributing other parties fines to it', async () => {
  const request = validateAdverseMediaRequest({
    entity_type: 'business', name: 'PT Dian Swastatika Sentosa Tbk', max_results: 10
  });
  const queries = [];
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
      const results = query.includes('site:ojk.go.id') && query.includes('sanksi') ? [officialResult] : [];
      return url.pathname.includes('/news/') ? Response.json({ results }) : Response.json({ web: { results } });
    }
    if (url.hostname === 'api.gdeltproject.org') return Response.json({ articles: [] });
    if (url.hostname === 'generativelanguage.googleapis.com') {
      const prompt = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
      assert.equal(prompt.evidence.length, 1);
      return Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ classifications: [{
          result_id: prompt.evidence[0].result_id,
          entity_match: 'confirmed', adverse: 'possible', categories: ['regulatory_and_governance'],
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
  assert.equal(response.summary.threshold_status, 'review_required');
  assert.equal(response.summary.human_review_required, true);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].risk_level, 'review');
  assert.ok(response.results[0].categories.includes('regulatory_and_governance'));
  assert.match(response.results[0].evidence_assessment, /not the issuer/i);
});
