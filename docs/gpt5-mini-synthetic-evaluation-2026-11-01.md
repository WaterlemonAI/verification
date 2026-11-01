# GPT-5 mini synthetic KYCProbe case evaluation — 1 November 2026

## Decision

**Hold the full Gemini replacement.** The Azure deployment handled structured document fields, evidence reconciliation, and a blocked injection attempt in this small synthetic case. It also assigned a director's personal penalty and a different company's charge to the screened company's `legal_stage` in the adverse-media classifier, and generated an unsupported alias in association expansion. Those are material EDD attribution errors. Gemini remains the production provider for the existing workflows.

## What was replayed

The entirely fictional [case fixture](../test/fixtures/gpt5-mini-synthetic-case.json) models a UAE company, one director, seven public-evidence snippets, an eighth snippet with an instruction attack, and nine OCR text submissions. The OCR submissions cover the eight current document classes and a tenancy certificate submitted to the utility-bill extractor as a wrong-document control. The adverse items mirror failure modes seen in the [40-case saved-evidence Gemini replay](adverse-media-40-case-gemini-replay-2026-10-27.md): direct company action, director-only action, a namesake, routine layoffs, an unsupported forum claim, and a secondary headline contradicted by a primary record. The document texts mirror the contracts and missing-field cases in [document sample QA](document-ocr-sample-qa.md). No customer record, identity document, or real person's data was used.

The [main replay runner](../scripts/evaluate-gpt5-mini-synthetic.mjs) called the live `ai7uae-gpt-5-mini` deployment through the existing API container's managed identity. It supplied the proposed AI7 UAE task instructions and strict JSON schemas. Document outputs were passed through the current `validateExtraction` implementation from the deployed app image. The [adjacent-task runner](../scripts/evaluate-gpt5-mini-synthetic-adjacent.mjs) exercised name transliteration, association search-term extraction, and an adverse-media audit narrative. Calls were sequential and had `reasoning.effort=minimal`. This was direct model evaluation from the API container, not an authenticated customer API/queue job. The production application and Gemini routing were unchanged.

The first attempt exposed a **replay-runner schema conversion bug**: 12 requests received `invalid_json_schema` before a valid model response. I fixed the conversion and added a local strict-schema check before running the measured replay. Those rejected requests are excluded from model-quality scores. Their Azure billing status was not checked.

## Measured results

| Task | Result | Main limitation |
| --- | --- | --- |
| Adverse-media classification, short task prompt | 7/7 items returned; buckets 5/7, roles 4/7, legal stages 6/7 | Misclassified an unsupported forum item and a contradicted headline; attributed a director action to the company legal stage. |
| Adverse-media classification, existing production Gemini classifier prompt supplied to GPT | 7/7 items returned; buckets 7/7, roles 6/7, legal stages 5/7 | R3 director penalty became company `regulatory_action`; R4 namesake company charge became screened company `charged`. R6 role was `context_only` rather than expected `unclear`. |
| Document structuring | 9/9 document classes, including wrong-document rejection; 26/26 selected scalar fields matched; all nine outputs passed the production extraction validator | Text-only inputs; image OCR accuracy, MRZ reading, portrait/signature crops, and full-field accuracy were not evaluated. |
| Source-bound research synthesis | Cited supplied R1/R3/R7, separated company and director actions, noted the contradictory headline and incomplete coverage, required human review | Sources were supplied in the fixture; no live search, retrieval, or source authenticity check. |
| Indirect instruction attack | HTTP 400 `content_filter` on the injected source | One attack wording only; the filter response is not a general prompt-injection success rate. |
| Arabic transliteration | Two distinct Arabic-script variants in the required JSON | Linguistic accuracy was not independently reviewed. |
| Association extraction | Correctly found the founded company, but also returned `Mira Vale` as an `alias` | The input gave that as the subject's own name, not an alias; the extra search term is unsupported. |
| Audit narrative | Distinguished company penalty, director penalty, and routine layoffs; stated coverage limits and human review | One narrative over three supplied snippets; no full report rendering or source retrieval. |

The measured run made **16 Azure request attempts**: 15 completed and one content-filtered. Completed calls reported **19,747 input tokens** and **6,048 output tokens** in total; the sequential requests took about **60.7 seconds**. The filtered request reported no token usage in its response. These are response telemetry, not invoiced cost. A current matching Global Standard price was not verified, so no dollar estimate is assigned.

The production-prompt classifier rerun is the fairer prompt test. It achieved the expected media buckets, but its legal-stage errors matter independently of the bucket score. In the current pipeline, [`resolveLegalStage`](../lib/adverse-media.mjs) gives a non-neutral headline stage priority. For R4, a headline about the separate company being `charged` could therefore remain `charged` even if a later bucket gate marks the item `no_impact_media`. This is a code-path risk identified by inspection; the end-to-end GPT-swapped pipeline was not run.

## Interpretation and next gate

This is **not a head-to-head accuracy comparison with Gemini**. The prior Gemini replay used 40 saved public subjects and 725 hits, and the document QA used private real samples. This new case is a small, deliberately difficult synthetic fixture; its expected labels are test judgments, not a population accuracy estimate. It proves that the live GPT deployment can produce the required JSON shape and that the current validator accepts these synthetic document fields. It does not establish equivalence on the previous cases, real scans, retrieval recall, customer API behavior, tenant isolation, billing, or regional processing.

Before replacing Gemini, correct the subject-specific legal-stage and association handling, then replay the same redacted or synthetic inputs through both providers with identical retrieval and validation. Add real document scans only through the approved privacy path, including MRZ and image crop checks. Keep human review and incomplete-source handling in place. Global Standard processing may occur outside the UAE; this synthetic evaluation did not send customer data.

## Reproduction

The runners expose `--dry-run`; the main runner also exposes `--classification-only` and `--production-classifier-prompt`. Live execution requires the API container's managed identity and `AI7UAE_EVAL_USE_APP_LIBS=1` to import the deployed document contracts and validator. The scripts intentionally do not modify Azure resources or production routing.
