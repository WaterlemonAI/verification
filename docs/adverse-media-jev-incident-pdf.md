# Jev incident-grouped PDF template

`createJevIncidentPdf()` renders an A4 report from a finalized `advance-jev-integrated-test-v1` or public `adverse-media-incident-report-v1` JSON object. It does not classify articles, change incident assignments, call a summary model, or invoke the customer report finalizer. A supplied `report_narrative.summary` is printed on the cover; otherwise the PDF states that no narrative summary was supplied.

The KYCProbe logo appears in the header of every page. Page one opens with the subject, period, incident/article/adverse/unassigned counts, and supplied narrative summary, then shows a distinct visual bucket for every incident group. Each bucket has its incident number, article count, adverse count, and a proportional adverseness bar. A representative headline is shown when there is enough space; the full headline appears in the incident section. The grid adapts from one to four columns and compresses larger group counts so the complete overview remains on the first page. The headline is explicitly an example article, not an invented incident title.

Page two shows proportional bars for adverseness, relationship, and evidence depth, followed by a compact comparison of media mentions across incident groups. These bars count the exact retained article states in the finalized JSON. The evidence bar distinguishes extracted article bodies from search excerpts, so the report does not imply that every article was screened from full text. Page three explains all adverseness and relationship labels, incident grouping, evidence depth, unassigned/redundant articles, how to verify the digital signature, and the public-source screening disclaimer. Subsequent incident sections show article count, adverse count, distinct publisher count, body availability, and publication dates before listing member articles. Small groups can share a page, while long groups flow across pages. Articles with `incident_id: null` appear in a separate review section, with their grouping reason when provided. Redundant articles are excluded from the article sections and counted on the cover.

Each article card shows the existing Jev adverseness and relationship labels, evidence depth, title, publisher, date, excerpt, and source URL. Source URL rows are clickable for HTTP(S) links; the link annotation retains the full target even when the printed URL is shortened to fit the card. The renderer checks that all group story keys refer to retained articles and that each article's `incident_id` agrees with its group. Invalid or conflicting finalized JSON fails rather than silently moving an article between incidents. The PDF states when policy evaluation has not run.

Every PDF generated through this renderer requires a PKCS#12 signing identity. It fails before writing a PDF if no certificate is supplied. The signature uses the `adbe.pkcs7.detached` subfilter; PDF viewers can verify document integrity and separately report whether the certificate is trusted. A locally generated QA certificate can prove the signing flow but does not establish KYCProbe's organizational identity. Production use requires an organization-issued document-signing certificate and secure key management. Do not place a P12 file or password in the repository.

To render a private local PDF with a signing identity:

```sh
export JEV_PDF_SIGNING_P12_PATH=/secure/path/document-signer.p12
export JEV_PDF_SIGNING_P12_PASSWORD='set-in-your-secret-store'
node scripts/render-adverse-media-jev-incident-pdf.mjs response.json output.pdf
pdfsig output.pdf
```

For an exportable certificate held in Azure Key Vault, configure the vault URI and the certificate's same-named backing secret. The runtime identity needs permission to read that secret. The PFX is loaded into memory and is never written to disk:

```sh
export JEV_PDF_SIGNING_KEY_VAULT_URI=https://your-vault.vault.azure.net/
export JEV_PDF_SIGNING_KEY_VAULT_SECRET_NAME=your-certificate-name
node scripts/render-adverse-media-jev-incident-pdf.mjs response.json output.pdf
pdfsig output.pdf
```

Key Vault returns an exportable certificate's PFX as base64 in an `application/x-pkcs12` secret, with an empty export password. A non-exportable or HSM certificate needs a remote signing adapter and cannot use this P12 path. The certificate name and access rights are still pending, so the two current previews use a temporary self-signed QA certificate; their document integrity verifies, but their issuer is not trusted as KYCProbe's organization identity.

The integrated-test API remains JSON only. The [signed incident report API](adverse-media-incident-final-report-api.md) invokes this renderer after the public JSON has been finalized and validated. It is separate from the existing legacy, Search+, and V7 customer PDF template.
