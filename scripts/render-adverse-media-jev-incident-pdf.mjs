import { readFileSync, writeFileSync } from 'node:fs';
import { createJevIncidentPdf } from '../lib/adverse-media-jev-report-pdf.mjs';
import { loadJevPdfSigningFromKeyVault } from '../lib/adverse-media-jev-pdf-signing.mjs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('usage: node scripts/render-adverse-media-jev-incident-pdf.mjs response.json output.pdf');
const certificatePath = process.env.JEV_PDF_SIGNING_P12_PATH;
const passphrase = process.env.JEV_PDF_SIGNING_P12_PASSWORD;
const vaultUri = process.env.JEV_PDF_SIGNING_KEY_VAULT_URI;
const secretName = process.env.JEV_PDF_SIGNING_KEY_VAULT_SECRET_NAME;
if (certificatePath && (vaultUri || secretName))
  throw new Error('select_one_pdf_signing_source');
let signing;
if (vaultUri || secretName) {
  signing = await loadJevPdfSigningFromKeyVault({ vaultUri, secretName,
    managedIdentityClientId: process.env.RUNTIME_IDENTITY_CLIENT_ID });
} else if (certificatePath && typeof passphrase === 'string') {
  signing = { p12Bytes: readFileSync(certificatePath), passphrase };
} else throw new Error('pdf_signing_identity_required');
signing.name = process.env.JEV_PDF_SIGNING_NAME || signing.name || 'KYCProbe report signer';
const response = JSON.parse(readFileSync(inputPath, 'utf8'));
const report = await createJevIncidentPdf({ response,
  narrative: response.report_narrative || null,
  signing });
writeFileSync(outputPath, report.bytes, { mode: 0o600 });
process.stdout.write(JSON.stringify({ output: outputPath, pages: report.pageCount,
  incidents: report.incidentCount, digitally_signed: report.digitallySigned,
  sha256: report.sha256 }) + '\n');
