# Adverse-media candidate: implementation and release gates

**Candidate branch:** `codex/adverse-media-one-year-default`. This document describes the local candidate, not the live API. No production configuration or deployed revision was changed.

## Implemented locally

- Azure archive is searched first. A complete Azure scan makes no public GDELT call. An incomplete scan uses direct GDELT DOC requests for the missing window, with up to three attempts per failed window. The final screening waits for those attempts. Azure findings survive public failure.
- Public requests use `startdatetime` and `enddatetime`, validate JSON/article shape and reject a 250-result capped page as complete coverage. The response records window dates, attempt counts, HTTP statuses and the final reason. A window beyond the supported one-year public horizon remains incomplete.
- Search+ preserves the standard query plan and adds up to six approved-publisher batches. The response records selected, attempted, completed, failed and skipped publisher domains. The standard endpoint rejects `search_plus:true`; the separately entitled Search+ endpoint is required.
- Gemini classifications are applied before the display result cap. A single confirmed direct adverse article is Unsafe when coverage and classification complete. Three or more confirmed adverse articles are Unsafe even with partial coverage; the result stays decision-ineligible. Missing coverage or unresolved evidence cannot be Safe. The PDF reads the locked profile instead of recomputing it from risk-score thresholds.
- Source `status`/`coverage.complete` is separate from classification uncertainty. An inconclusive classification can have completed source coverage. Search+ returns a recorded partial report after source failure instead of discarding findings with HTTP 503.
- Conclusive completed screens use a twelve-hour, process-local cache keyed by the exact normalized request, classifier mode and methodology version. Inconclusive or incomplete screens are not cached. Cache hits retain the original `coverage.searched_at` receipt and create a new screening ID/report without provider calls. The map is capped at 500 entries; a restart clears it. A cached Safe result is a twelve-hour snapshot, not a claim of continuous monitoring.

## Evidence collected

- `npm test`: **450 passed, 0 failed** after the cache and evidence-count updates.
- API Bicep build, JavaScript syntax checks and `git diff --check`: passed.
- Focused tests cover three public DOC failures, success on the third attempt, Azure gap dates, capped responses, Search+ base-query preservation, entitlement bypass rejection, and three confirmed articles with partial coverage.
- A direct DOC request from this local environment timed out after 20 seconds on 19 November 2026. That does **not** establish the response or latency from the deployed Azure runtime.

## Gates before merge or live enablement

1. **Provider and runtime:** From an isolated candidate deployment with the same network egress as production, run direct public DOC calls for recent and historical windows. Capture status, response type, schema, returned dates and elapsed time. Run three-failure and third-attempt-success paths and verify total API time remains below ingress timeout with Gemini and PDF creation. If direct DOC egress is unavailable, keep this branch off production and resolve network/provider access.
2. **Actual Azure read:** Run a controlled request through the candidate API with a complete indexed window; prove zero public calls and compare indexed row count and watermark. Run an older window and a truncated Azure scan; prove the exact public gap, merged evidence and truthful partial status when the public source cannot cover it.
3. **Search+ and cost:** For the same controlled subject, compare standard and Search+ query manifests; every base query must be identical and Search+ must add publisher batches. Verify entitlement, pricing, skipped-domain accounting, the existing $0.14 provider reservation ceiling, and the final JSON/PDF on both paths.
   Confirm the twelve-hour cache freshness policy with the product owner before treating cached Safe profiles as current evidence; `coverage.searched_at` must remain the original search time.
4. **Decision quality:** Have a reviewer label the retained holdout cases (including attacked vessel, disrupted site, and historical compilation page). Confirm source text and event date support each Gemini classification. Any unsupported direct-adverse finding blocks release. Verify all six policy rows in the implementation plan through the HTTP API and PDF, including partial coverage with three adverse articles.
5. **Cohort reconciliation:** Rerun the previous 50 subjects against the candidate deployment with controlled credentials and live Azure reads. Save one immutable manifest per case containing request fingerprint, archive attempt telemetry, provider call counts, classification status, profile, response hash, PDF hash and runtime. Reconcile case counts and report labels; do not reuse the earlier contradictory CSV and later PDF set as one baseline.
6. **Operational rollback:** Review the API contract change (`search_plus:true` on the standard endpoint now returns 400), update consumers and documentation, deploy by pinned image digest, monitor source failures, p90/p95 latency and cost, and retain the prior revision for rollback.

**Release status:** Local implementation passes tests. Gates 1–6 require the candidate deployment and controlled evidence; the feature is not cleared for production release.
