# Document extraction sample QA — 27 October 2026

This is a private-data-safe summary of transient local validation. Source documents, OCR text, model JSON, images, and identity values were not committed or added to this report. The document files remain at their user-provided local paths. The one-off QA runner stored page images only in a temporary directory and deleted them after the run.

## Method and result

The seven intended document types were read using their PDF text layer where available, or local macOS Vision OCR for scanned pages. The resulting text was passed through the production Gemini structuring code and the dedicated document Gemini key. One tenancy certificate was submitted as a negative control to the utility-bill extractor. This exercise validates schema behavior, field evidence checks, and the model prompt on real document layouts. It does not validate Azure Document Intelligence accuracy, document-figure crops, queue/billing behavior, or the live API.

| Case | Pages | Structured fields present | Not Found | Not Readable | Local outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| UAE trade licence | 9 | 10 | 1 | 0 | Expected document class; no review flags |
| Passport | 2 | 12 | 0 | 0 | TD3 MRZ checks passed; no review flags after deterministic gender corroboration |
| Power of attorney | 9 | 5 | 1 | 1 | One unsupported authority value withheld for review |
| Memorandum of association | 14 | 5 | 1 | 0 | Expected document class; no review flags |
| Articles of association | 4 | 5 | 0 | 0 | Expected document class; no review flags |
| Emirates ID | 2 | 12 | 5 | 0 | TD1 MRZ checks passed; portrait crop requires Azure figure validation |
| Dummy cancelled cheque | 1 | 3 | 3 | 0 | Missing cheque number correctly flagged for review |
| Tenancy certificate as utility bill | 4 | 0 | 7 | 0 | Rejected as wrong document class |

The passport initially produced an unnecessary review flag for a one-character gender citation. The validator now accepts that value only when a cited, valid TD3 MRZ corroborates it. The rerun passed without that flag. Missing or unsupported scalar values kept the documented `Not Found` and `Not Readable` labels.

## Release blockers

1. Obtain an actual UAE utility bill sample. The supplied tenancy certificate is only a negative control.
2. Run every sample through the isolated UAE North Azure Document Intelligence account and the same Gemini validator. The account and private storage are not yet provisioned. Record field-level source-image comparisons without storing personal data in CI or the repository.
3. Confirm Emirates ID portrait and signature crops from Azure Layout figures, including the five-minute private URLs. The local text-only run cannot establish crop accuracy.
4. Exercise the authenticated API, queue, malware gate, idempotent billing, tenant isolation, 30-day purge, and dead-letter path before enabling customer routes.

Until these checks pass, `DOCUMENT_OCR_PRODUCTION_ENABLED` and `DOCUMENT_OCR_ENABLED` stay off.
