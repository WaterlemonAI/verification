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

## Gates before customer enablement

1. Run varied representative samples for all eight document types, including low-quality scans, absent fields and wrong-document cases. The first actual utility-bill sample is recorded below.
2. Confirm Emirates ID portrait and signature crops and their five-minute private URLs through the authenticated worker.
3. Exercise the authenticated API, queue, malware gate, idempotent billing, tenant isolation, 30-day purge, and dead-letter path before enabling customer routes.

The isolated worker, malware sidecar, purge job, and authenticated live API were subsequently exercised as described below. These earlier gates are retained here as the release checklist; the customer gate was enabled only after those checks.

## Isolated Azure S0 sample run — 27 October 2026

The dedicated UAE North OCR account and private storage were provisioned from the reviewed Bicep with a one-time, user-approved Owner-account exception after the GitHub workflow identity was denied resource-creation permissions. The Azure account is S0 with local keys disabled; the storage account has public Blob and shared-key access disabled. The customer route gate read back as `DOCUMENT_OCR_PRODUCTION_ENABLED=0`. A temporary Cognitive Services User assignment for sample testing was removed and verified absent afterward.

The source documents and all extracted personal values remained outside this report. Azure analyze results were deleted after each direct QA call. The live QA observed:

| Case | Azure/model outcome | Review state |
| --- | --- | --- |
| UAE trade licence | 11 populated fields; one absent date returned `Not Found` | No review flag |
| Passport | Passport ID model supplied a checksum-valid TD3 MRZ; 12 populated fields | No review flag |
| Power of attorney | Six populated fields; absent period returned `Not Found` | No review flag after the bounded Azure submit timeout was raised to 90 seconds |
| Memorandum of association | Five populated fields; absent registration number returned `Not Found` | No review flag |
| Articles of association | Five populated fields | No review flag |
| Emirates ID | TD1 MRZ passed in the Linux worker; the final Gemini call identified tight portrait and signature crops | Review required for two visually present fields that were not backed by Azure text evidence |
| Fictional cancelled cheque | Three populated fields; cheque number, amount and MICR returned `Not Found` | Review required because the cheque number is missing |
| Tenancy certificate submitted as utility bill | No utility-bill fields populated; classified as `unclassified` | Rejected for review as the wrong document type |
| DEWA utility bill, four pages | Seven requested fields populated and classified as `utility_bill`; the printed four-digit bill year was safely shortened to the required `DD/MM/YY` output | No review flag after date-format correction; the address was assembled from source-backed lines |

For Emirates ID, the worker renders pages only after malware scanning. Its bundled local OCR accepts a TD1 MRZ only when every check digit passes. A production-sized page-image test yielded a verified MRZ and small portrait/signature crops without publishing a full ID page. The final Gemini response still required human review for unsupported back-side fields. The passport-specific Azure ID model returned a verified TD3 MRZ; the wrapper now uses that checked value when Gemini mistranscribes it. These are sample outcomes, not a population-level accuracy claim.

The DEWA sample was processed directly through the isolated Azure Layout account and dedicated Gemini structuring path. The first run populated all seven fields but returned `DD/MM/YYYY`, which correctly triggered a format review flag. After a deterministic, source-backed year conversion, the repeat run returned `DD/MM/YY` with no review flags. All other populated fields were source backed; the composed address used words present in the OCR text. A temporary sample-testing role was removed and its absence read back after this run. This validates one bill, not general accuracy across UAE utilities.

The dedicated worker later passed a synthetic queue smoke, the ClamAV sidecar became ready with no restarts, and the hourly purge job completed a manual run. Unit and integration tests cover admission, idempotent billing, tenant isolation, bounded provider calls, dead-letter/refund, encryption, signed crop URLs, and expiry handling. The synthetic prompt-injection sample preserved the required schema and set a review flag. Deliberately invalid MRZ documents and varied low-quality scans remain useful additions to the accuracy corpus; no population-wide accuracy rate is claimed from these samples.

## Authenticated production API sample run — 27 October 2026

One disposable key in the existing AI7LAB UAE workspace was used for live submissions of user-provided sample documents. Values and OCR text are deliberately omitted from this record. All eight results used a unique transaction ID, returned the documented field count, passed the malware gate, and showed bounded Azure and Gemini provider counts. Review-required outcomes are not automated approvals.

| Module | Live result | Fields | Source-backed evidence | Review finding |
| --- | --- | ---: | ---: | --- |
| UAE trade licence | `review_required` | 12 | 11 | One absent date was `Not Found`; director/owner value requires source review |
| Passport ICAO OCR | `completed` | 12 | 10 | None; TD3 verification performed |
| UAE power of attorney | `completed` | 7 | 5 | One absent field was `Not Found` |
| UAE utility bill | `completed` | 7 | 7 | None |
| Cheque OCR | `review_required` | 6 | 3 | Fictional sample lacks a cheque number; three fields were `Not Found` |
| MOA analysis | `completed` | 6 | 6 | One absent field was `Not Found` |
| Articles of association | `completed` | 5 | 13 | None |
| Emirates ID | `review_required` | 17 | 13 | Four visually present values were withheld as `Not Readable` because Azure text did not corroborate them; private photo and signature crop links were returned |

The Emirates ID result was intentionally held for review rather than treating image-only or conflicting text as verified data. A second submission with separate front and back PDFs returned HTTP 200 `review_required`, all 17 fields, 16 evidence citations, and private photo and signature crop links. The one unsupported gender value was withheld as `Not Readable`. It used two Azure analyses and one Gemini call, as expected for two files.

After a fresh portal load, all eight modules appeared in the signed-in Document Extraction sidebar and service health listed them as enabled. The customer meter increased its charged-call count by nine for the nine accepted sample submissions; job/result polling generated separate HTTP 202/200 log rows with zero cost and did not increment the charged-call count. The internal test workspace currently has zero-priced rates; these outcomes do not establish customer pricing.
