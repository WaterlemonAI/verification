import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import forge from 'node-forge';
import { createJevIncidentPdf, jevIncidentReportModel } from '../lib/adverse-media-jev-report-pdf.mjs';

function qaSigningIdentity() {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  const subject = [{ name: 'commonName', value: 'KYCProbe QA Test Signer' }];
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, certificate, 'qa-password',
    { algorithm: '3des' });
  return { p12Bytes: Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'),
    passphrase: 'qa-password', name: 'KYCProbe QA Test Signer' };
}
const signing = qaSigningIdentity();

const article = (story_key, incident_id, adverseness = 'adverse') => ({
  story_key, incident_id, title: `Example Trading ${story_key} fraud case update`,
  url: `https://publisher.example/${story_key}`, publisher: 'Example Publisher',
  published_at: '2026-11-24T10:00:00Z', excerpt: 'A reported case involving Example Trading.',
  adverseness, relationship: 'direct'
});
const response = {
  contract: 'advance-jev-integrated-test-v1', subject: { name: 'Example Trading' },
  period: { from: '2026-11-01', to: '2026-11-25' },
  policy_evaluation_status: 'not_run', coverage: { omitted_due_to_test_limit: 0 },
  redundant: [{ story_key: 'removed', tag: 'redundant' }],
  event_register: {
    articles: [article('one', 'inc-one'), article('two', 'inc-one'),
      article('three', 'inc-two', 'non-adverse'), article('four', null, 'inconclusive')],
    incidents: [
      { incident_id: 'inc-one', story_keys: ['one', 'two'] },
      { incident_id: 'inc-two', story_keys: ['three'] }
    ]
  }
};

test('incident PDF creates exactly the sections present in each finalized case', async () => {
  const full = await createJevIncidentPdf({ response, narrative: { summary: 'Two distinct cases were identified.' },
    generatedAt: '2026-11-25T10:00:00Z', signing });
  assert.equal(full.incidentCount, 2);
  assert.equal(full.pageCount, 6);
  assert.equal((await PDFDocument.load(full.bytes)).getPageCount(), 6);
  assert.equal(full.digitallySigned, true);
  assert.match(full.bytes.toString('latin1'), /\/ByteRange\s*\[\s*0\s+\d+\s+\d+\s+\d+\s*\]/);
  assert.match(full.bytes.toString('latin1'), /\/SubFilter\s*\/adbe\.pkcs7\.detached/);
  assert.match(full.bytes.toString('latin1'), /\/Subtype\s*\/Link/);
  assert.match(full.bytes.toString('latin1'), /https:\/\/publisher\.example\/one/);
  const single = { ...response, event_register: { articles: [article('one', 'inc-one')],
    incidents: [{ incident_id: 'inc-one', story_keys: ['one'] }] } };
  const compact = await createJevIncidentPdf({ response: single,
    generatedAt: '2026-11-25T10:00:00Z', signing });
  assert.equal(compact.incidentCount, 1);
  assert.equal(compact.pageCount, 4);
  const empty = { ...response, event_register: { articles: [], incidents: [] } };
  const noIncidents = await createJevIncidentPdf({ response: empty,
    generatedAt: '2026-11-25T10:00:00Z', signing });
  assert.equal(noIncidents.incidentCount, 0);
  assert.equal(noIncidents.pageCount, 3);
});

test('dashboard counts come from finalized article labels and evidence grades', () => {
  const model = jevIncidentReportModel(response);
  assert.deepEqual(model.counts, {
    adverse: 2, nonAdverse: 1, adverseInconclusive: 1,
    direct: 4, indirect: 0, relationshipInconclusive: 0,
    body: 0, excerpt: 0, otherEvidence: 4
  });
});

test('Safe with retained non-adverse media keeps the signed incident-register layout', async () => {
  const safe = { ...response, screening_result: 'Safe', event_register: {
    articles: [article('ordinary', null, 'non-adverse')], incidents: [] } };
  const report = await createJevIncidentPdf({ response: safe, signing });
  assert.equal(report.pageCount, 4);
  assert.equal(report.digitallySigned, true);
  assert.equal((await PDFDocument.load(report.bytes)).getPageCount(), 4);
});

test('incident PDF cannot be generated without a signing identity', async () => {
  await assert.rejects(() => createJevIncidentPdf({ response }),
    { message: 'pdf_signing_certificate_required' });
});

test('incident PDF rejects a group assignment missing from the finalized JSON', () => {
  const invalid = { ...response, event_register: { ...response.event_register,
    articles: response.event_register.articles.map((item) => item.story_key === 'two'
      ? { ...item, incident_id: 'different' } : item) } };
  assert.throws(() => jevIncidentReportModel(invalid), { message: 'invalid_jev_report_json' });
});
