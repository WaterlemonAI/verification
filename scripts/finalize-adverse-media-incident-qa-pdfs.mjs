// Historical QA artifact upgrade only. The report API now returns its final
// JSON and signed PDF in one response; new live runs must use those bytes.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import forge from 'node-forge';
import { createMinistralJevSummary } from '../lib/adverse-media-jev-ministral-summary.mjs';
import { createJevIncidentPdf } from '../lib/adverse-media-jev-report-pdf.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/finalize-adverse-media-incident-qa-pdfs.mjs output-dir');
const records = JSON.parse(readFileSync(join(dir, 'private-run-ledger.json'), 'utf8'));
const pair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
const certificate = forge.pki.createCertificate();
certificate.publicKey = pair.publicKey;
certificate.serialNumber = '02';
certificate.validity.notBefore = new Date(Date.now() - 60_000);
certificate.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
const name = [{ name: 'commonName', value: 'KYCProbe QA Test Signer' },
  { name: 'organizationName', value: 'AI7 Lab' }];
certificate.setSubject(name);
certificate.setIssuer(name);
certificate.sign(pair.privateKey, forge.md.sha256.create());
const p12 = forge.pkcs12.toPkcs12Asn1(pair.privateKey, certificate, 'qa-password',
  { algorithm: '3des' });
const signing = { p12Bytes: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'),
  passphrase: 'qa-password', name: 'KYCProbe QA Test Signer' };
for (const record of records.filter((item) => item.status === 200)) {
  const jsonPath = join(dir, `${record.id}.response.json`);
  if (!existsSync(jsonPath)) throw new Error(`qa_response_missing:${record.id}`);
  const response = JSON.parse(readFileSync(jsonPath, 'utf8'));
  if (record.archive_access_denied) {
    response.status = 'completed_with_source_gap';
    response.coverage.source_coverage_status = 'incomplete';
    response.coverage.unavailable_sources = ['archived_media_index'];
  }
  if (response.event_register.articles.length === 0) response.screening_result = 'Safe';
  if (response.event_register.incidents.length === 0) {
    response.summary = (await createMinistralJevSummary({ response, apiKey: 'qa-no-call',
      fetchImpl: () => { throw new Error('unexpected_summary_call'); } })).summary;
  }
  const pdf = await createJevIncidentPdf({ response,
    narrative: { summary: response.summary }, signing });
  response.report = { filename: pdf.filename, media_type: 'application/pdf',
    sha256: createHash('sha256').update(pdf.bytes).digest('hex'),
    page_count: pdf.pageCount, digitally_signed: pdf.digitallySigned,
    pdf_base64: pdf.bytes.toString('base64') };
  writeFileSync(join(dir, `${record.id}.pdf`), pdf.bytes, { mode: 0o600 });
  writeFileSync(jsonPath, JSON.stringify(response, null, 2), { mode: 0o600 });
  record.pdf_sha256 = response.report.sha256;
  record.pages = response.report.page_count;
  process.stdout.write(JSON.stringify({ id: record.id, pages: record.pages }) + '\n');
}
writeFileSync(join(dir, 'private-run-ledger.json'), JSON.stringify(records, null, 2), { mode: 0o600 });
