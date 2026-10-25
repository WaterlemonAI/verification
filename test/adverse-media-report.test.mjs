import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { createAdverseMediaAuditPdf, createAdverseMediaNarrative } from '../lib/adverse-media-report.mjs';
import { MemoryAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';

const request = {
  entity_type: 'individual', name: 'Example Person', aliases: [], countries: ['AE'], languages: ['en'],
  date_from: '', date_to: '', max_results: 25, risk_threshold: 0.65, deep_research: false,
  callback_url: '', customer_logo_url: ''
};
const response = {
  screening_id: '03e3be3d-9713-4c23-9d14-0e9128c7fe15', status: 'completed', completed_at: '2026-10-26T09:31:00.000Z',
  entity: { entity_type: 'individual', name: 'Example Person', aliases: [], countries: ['AE'] },
  summary: {
    outcome: 'potential_match', risk_level: 'high', highest_risk_score: 0.86, potentially_relevant_results: 1,
    categories: { financial_crime: 1 }, human_review_required: true,
    statement: 'One potentially relevant result reached the configured review threshold.', risk_threshold: 0.65,
    results_at_or_above_threshold: 1, decision_eligible: true, threshold_status: 'review_required'
  },
  coverage: {
    complete: true, sources: [{ source: 'current_news', status: 'complete' }], reason_codes: [], retryable: false,
    languages_searched: [{ code: 'en', name: 'English' }], date_from: null, date_to: null,
    searched_at: '2026-10-26T09:31:00.000Z', archive_window: 'up to one year', limitation: 'Indexed public sources only.'
  },
  results: [{
    result_id: 'r-1', title: 'Example Person named in investigation', url: 'https://news.example/case', publisher: 'news.example',
    published_at: '2026-10-20T00:00:00Z', language: 'en', source_type: 'news_index',
    excerpt: 'Authorities opened an investigation. No final judgment was reported.', risk_score: 0.86, risk_level: 'high',
    categories: ['financial_crime'], legal_stage: 'investigation', review_required: true
  }]
};

test('report narrative uses a strict single-purpose JSON contract', async () => {
  const narrative = await createAdverseMediaNarrative({
    response, apiKey: 'private', fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      assert.match(payload.systemInstruction.parts[0].text, /single-purpose adverse-media audit report writer/);
      assert.match(payload.systemInstruction.parts[0].text, /untrusted data/);
      assert.equal(payload.generationConfig.responseJsonSchema.additionalProperties, false);
      assert.equal(JSON.parse(payload.contents[0].parts[0].text).job, 'write_adverse_media_audit_summary');
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        summary: 'One potentially relevant result requires review.', findings: ['An investigation-stage result met the threshold.'],
        recommendations: ['Complete documented human review before making a decision.']
      }) }] } }] });
    }
  });
  assert.equal(narrative.findings.length, 1);
  assert.match(narrative.recommendations[0], /human review/);
});

test('PDF includes a complete multi-page audit artifact and stable integrity metadata', async () => {
  const report = await createAdverseMediaAuditPdf({
    request, response,
    narrative: { summary: 'A relevant result requires review.', findings: ['One result met the threshold.'], recommendations: ['Perform human review.'] },
    origin: { received_at: '2026-10-26T09:30:00.000Z', network_origin: '203.0.113.10', processing_location: 'Microsoft Azure UAE North' },
    generatedAt: '2026-10-26T09:32:00.000Z'
  });
  assert.equal(report.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(report.reportId, /^[0-9a-f-]{36}$/);
  assert.match(report.sha256, /^[0-9a-f]{64}$/);
  const parsed = await PDFDocument.load(report.bytes);
  assert.ok(parsed.getPageCount() >= 2);
  assert.match(parsed.getTitle(), /Adverse Media Screening Result/);
  assert.match(parsed.getSubject(), new RegExp(response.screening_id));
});

test('permanent report store retains owner isolation and supports public capability lookup', async () => {
  const store = new MemoryAdverseMediaReportStore();
  const metadata = { report_id: 'rpt', transaction_id: 'txn', generated_at: new Date().toISOString(), sha256: 'a'.repeat(64), filename: 'report.pdf', retention: 'permanent' };
  await store.save({ ownerId: 'customer-a', reportId: 'rpt', bytes: Buffer.from('%PDF-test'), metadata });
  assert.equal((await store.get({ ownerId: 'customer-a', reportId: 'rpt' })).metadata.retention, 'permanent');
  assert.equal(await store.get({ ownerId: 'customer-b', reportId: 'rpt' }), null);
  assert.equal((await store.getPublic({ reportId: 'rpt' })).metadata.filename, 'report.pdf');
  assert.equal(await store.getPublic({ reportId: 'missing' }), null);
});
