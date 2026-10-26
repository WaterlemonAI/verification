import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAdverseMediaAuditPdf } from '../lib/adverse-media-report.mjs';

const output = resolve('output/pdf/adverse-media-screening-sample.pdf');
const request = {
  entity_type: 'individual', name: 'Sample Customer', aliases: ['S Customer'], countries: ['AE'], languages: ['en', 'ar'],
  date_from: '2025-01-01', date_to: '', risk_threshold: 0.65,
  review_threshold_percent: 65, high_risk_threshold_percent: 90, max_results: 25, deep_research: false,
  callback_url: '', customer_logo_url: ''
};
const response = {
  screening_id: 'e24db404-2aa3-4019-a86b-f314aeeb6601', status: 'completed', completed_at: '2026-10-26T10:21:16.000Z',
  entity: { entity_type: 'individual', name: 'Sample Customer', aliases: ['S Customer'], countries: ['AE'] },
  summary: {
    outcome: 'review_required', risk_level: 'review', highest_risk_score: 0.82, potentially_relevant_results: 2,
    categories: { financial_crime: 1, regulatory_and_governance: 1 }, human_review_required: true,
    statement: 'One of two potentially relevant results reached the configured review threshold.', risk_threshold: 0.65,
    thresholds: { high_risk_percent: 90, review_percent: 65, safe_below_percent: 65 },
    risk_distribution: { high_risk: 0, review: 1, safe: 1 },
    results_at_or_above_threshold: 1, decision_eligible: true, threshold_status: 'review_required'
  },
  coverage: {
    complete: true, geographic_scope: 'country_targeted',
    sources: [{ source: 'current_news', status: 'complete' }, { source: 'open_web', status: 'complete' }, { source: 'archive', status: 'complete' }, { source: 'official_records', status: 'complete' }],
    reason_codes: [], retryable: false, languages_searched: [{ code: 'en', name: 'English' }, { code: 'ar', name: 'Arabic' }],
    date_from: '2025-01-01', date_to: null, searched_at: '2026-10-26T10:21:16.000Z', archive_window: 'up to one year',
    limitation: 'Coverage is limited to indexed, publicly discoverable sources and cannot guarantee every publication.'
  },
  results: [
    {
      result_id: 'result-001', title: 'Regulator opens investigation involving Sample Customer', url: 'https://publisher.example/investigation',
      publisher: 'publisher.example', published_at: '2026-10-18T07:30:00Z', language: 'en', source_type: 'news_index',
      excerpt: 'The regulator announced that it opened an investigation. The article did not report a final judgment or finding.',
      risk_score: 0.82, risk_level: 'review', categories: ['regulatory_and_governance'], legal_stage: 'investigation', review_required: true
    },
    {
      result_id: 'result-002', title: 'Court filing names Sample Customer in commercial dispute', url: 'https://records.example/case',
      publisher: 'records.example', published_at: '2026-09-05T00:00:00Z', language: 'en', source_type: 'official_regulatory',
      excerpt: 'A filing named the subject in a commercial dispute. The available source did not report a criminal charge or final determination.',
      risk_score: 0.48, risk_level: 'safe', categories: ['financial_crime'], legal_stage: 'allegation', review_required: false
    }
  ]
};
const report = await createAdverseMediaAuditPdf({
  request, response,
  narrative: {
    summary: 'Two potentially relevant records were identified. One investigation-stage result exceeded the configured review threshold; neither source reports a final judgment.',
    findings: ['One investigation-stage result exceeded the 65% review threshold.', 'A second commercial-dispute result remained in the Safe band.', 'All configured source groups completed.'],
    recommendations: ['Confirm identity using independent identifiers before attribution.', 'Review the underlying publications and document the disposition.', 'Apply enhanced due diligence only in accordance with the institution’s risk policy.']
  },
  origin: { received_at: '2026-10-26T10:20:43.000Z', network_origin: '203.0.113.24', processing_location: 'Microsoft Azure UAE North' },
  generatedAt: '2026-10-26T10:21:20.000Z'
});
await mkdir(resolve('output/pdf'), { recursive: true });
await writeFile(output, report.bytes);
console.log(output);
