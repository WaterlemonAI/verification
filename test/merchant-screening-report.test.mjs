import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { createMerchantScreeningAuditPdf } from '../lib/merchant-screening-report.mjs';

const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('merchant PDF includes actual screenshot evidence and audit metadata', async () => {
  const request = { website_url: 'https://example.com/', country_code: 'AE', declared_merchant_name: 'Example Merchant LLC', declared_mcc: null, max_pages: 12, high_risk_threshold_percent: 60, review_threshold_percent: 25, get_pdf: true, customer_logo_url: null };
  const response = {
    screening_id: 'a9f34887-868a-43c1-a037-ab621621b76a', status: 'partial', completed_at: '2026-10-26T10:05:00.000Z',
    merchant_identity: { names: ['Example Merchant LLC'], addresses: [], phones: [], emails: [], social_profiles: [], founders: [], senior_leadership: [], partnership_and_sponsorship_claims: [] },
    domain: { status: 'available', domain: 'example.com', created_at: '1995-08-14T00:00:00.000Z', age_days: 11396 },
    policies: { country_pack: { name: 'United Arab Emirates' }, missing_expected_items: [], privacy: { status: 'found', url: 'https://example.com/privacy' } },
    products: [], outgoing_links: [], security: { tls: { protocol: 'TLSv1.3', authorized: true }, missing_recommended_headers: [] },
    screenshots: { status: 'completed', items: [{ page_type: 'homepage' }] },
    crawl: { robots: { status: 'respected' }, pages_collected: 1, page_errors: [], limits: { maximum_pages: 12 } },
    findings: [], summary: { risk_score: 0, risk_level: 'safe', outcome: 'manual_review', confidence: 'low', decision_eligible: false, human_review_required: true, threshold_status: 'safe', thresholds: { high_risk_percent: 60, review_percent: 25, safe_below_percent: 25 }, coverage: { website: 'available', screenshots: 'completed', x_mentions: 'not_configured', destination_reputation: 'not_configured' } },
    evidence: [], methodology: { version: 'merchant-screening-foundation-1', cost_ceiling_usd: 0.05 }
  };
  const report = await createMerchantScreeningAuditPdf({
    request, response,
    origin: { received_at: '2026-10-26T10:00:00.000Z', network_origin: '203.0.113.10', processing_location: 'Microsoft Azure UAE North' },
    generatedAt: '2026-10-26T10:06:00.000Z',
    screenshots: [{ bytes: onePixelPng, content_type: 'image/png', page_type: 'homepage', source_url: request.website_url, final_url: request.website_url, viewport: { name: 'desktop', width: 1440, height: 900 }, captured_at: '2026-10-26T10:04:00.000Z', sha256: 'b'.repeat(64) }]
  });
  assert.equal(report.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(report.sha256, /^[0-9a-f]{64}$/);
  assert.match(report.filename, /^ai7-merchant-screening-example-merchant-llc-/);
  const parsed = await PDFDocument.load(report.bytes);
  assert.ok(parsed.getPageCount() >= 4);
  assert.match(parsed.getTitle(), /Merchant Website Screening Result/);
  assert.match(parsed.getSubject(), new RegExp(response.screening_id));
});
