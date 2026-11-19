# Adverse Media: complete coverage and three-state Gemini profile

**Base:** `codex/adverse-media-one-year-default` at `55c4e74` (unreleased). This is an implementation plan, not a claim that the changes below are built or deployed.

## Why this change is needed

The 19 November 2026 benchmark recorded 25 archive-covered ranges out of 50, but only 16 completed screenings; nine covered cases were partial because classification/adjudication was uncertain. The retained JSON/PDF files were generated later and disagree with the benchmark CSV for eight cases, so the two sets must not be treated as one frozen run. The retained reports also show apparent victim or historical-incident evidence classified as `Unsafe` (ADNOC, Masdar, Saudi Aramco). The current logic treats any candidate below a classification-confidence threshold as a reason to mark the entire screening partial, including candidates eventually placed in general news or no-impact buckets.

The goal is to eliminate the **internal contradiction** `coverage.complete=true` with `status=partial`. It is not possible to guarantee that a public search index contains every article on the internet. Here, **complete coverage** means every configured source/query and the declared time window was searched to the stated depth, with no source failure, missing interval, scan limit, unprocessed candidate, or silent truncation. The report must disclose that scope.

## Locked response contract

Keep the JSON values lowercase for API compatibility; the UI and PDF display the exact labels `Safe`, `Unsafe`, `Inconclusive`. `summary.profile_status` and the displayed profile may take **only** `safe`, `unsafe`, or `inconclusive`. Gemini selects the evidence verdict; the server validates it and may only downgrade an unsupported verdict to `inconclusive`. Neither thresholds nor the PDF renderer independently choose a profile.

| Source and processing state | `status` | `coverage.complete` | `summary.profile_status` | `summary.decision_eligible` |
| --- | --- | --- | --- | --- |
| All configured sources complete; Gemini finds no credible direct adverse evidence | `completed` | `true` | `safe` | `true` |
| All configured sources complete; Gemini identifies credible direct adverse evidence about this subject | `completed` | `true` | `unsafe` | `true` (human review still required) |
| All configured sources complete; evidence is unresolved or Gemini cannot return a valid verdict | `completed` | `true` | `inconclusive` | `false` |
| Any required source/time interval/query/candidate is incomplete after bounded retries | `partial` | `false` | `inconclusive` | `false` |
| Request is invalid or the service cannot start a screening | HTTP 4xx/5xx error | no completed screening | no profile claim | `false` |

**Hard invariants:**

1. `coverage.complete=true` implies `status=completed`, an empty coverage-failure reason list, every required source completed, every required archive interval covered, all planned source pages and candidate retrieval completed, and no scan/name/time/result cap hit. AI uncertainty is recorded under `adjudication`, never as missing source coverage.
2. `status=partial` implies `coverage.complete=false` and `profile_status=inconclusive`. A provider HTTP 200 alone is insufficient to set coverage complete.
3. `profile_status=safe` or `unsafe` requires `coverage.complete=true`, a validated Gemini decision, and a preserved evidence manifest. `inconclusive` is valid with either complete or incomplete coverage; its reason must say which.
4. A cached result is reusable only with the same normalized input, source-window manifest, classifier/model/prompt version, and still-valid coverage watermark. Return the original evidence basis and a new screening ID; do not silently upgrade a cached profile.
5. `summary.outcome`, `outcome_label`, PDF hero, UI badge, callback, JSON download and Flo/Forms display cannot contradict `summary.profile_status`. “No Adverse Media Found” may remain explanatory text, not a fourth profile label.

## Gemini decision design

Use a **common final Gemini decision step** for standard Adverse Media and Search+. Existing per-item classifiers may continue to extract facts, but neither their numerical risk score nor a single low-confidence unrelated hit decides the overall profile. The final step receives a bounded, immutable evidence manifest containing subject and aliases; declared coverage scope; every deduplicated candidate and its source/date; per-item entity match, subject role, event kind, adverse allegation or action, and uncertainty; and source links/IDs. Each item must be accounted for. Send untrusted article text only as data, with no executable tools or instructions from evidence.

Require a strict JSON schema with `profile` enum `safe|unsafe|inconclusive`, cited `finding_ids`, short rationale, `uncertainty_reason_codes`, and per-item disposition IDs. Validate exact IDs, item count, enum values, and consistency before accepting the response. Store model, prompt/schema version and input/output hashes. On timeout, invalid JSON, missing items, unsupported citations or prompt-injection attempt, retry within the existing cost budget; if unresolved, set `inconclusive` with `adjudication.reason_code`, while preserving truthful source coverage.

Decision rules for the prompt and server validator:

- **Unsafe:** credible evidence of a materially adverse allegation, enforcement action, misconduct, or directly attributable material event concerning the screened subject. Cite the specific articles and distinguish allegation from finding. A mere exact-name match or high keyword score is insufficient. A victim of an attack is not automatically an adverse actor; an operational incident may need a distinct policy category and human review.
- **Safe:** the configured sources completed, every plausible material candidate was assessed, and no credible direct adverse evidence for the same subject remains. Explain that this is a finding within the searched sources, not universal clearance.
- **Inconclusive:** unresolved identity/role, contradictory or thin evidence, uncertain timing, ambiguous material incident, Gemini failure, or incomplete source coverage. Name the affected item or source and the next review action. Do not turn an unrelated low-confidence item into a blanket “coverage incomplete” claim.

The current classifier sees titles and excerpts, not complete articles. For a potentially material finding, add a bounded publisher-content/evidence verification step where content is legally and technically available. If the source content or event date cannot be corroborated, Gemini can return `inconclusive`; it must not label an entity `unsafe` from a snippet or a page's updated date alone. Preserve source excerpts and minimal citations under the existing retention controls.

## Implementation sequence and exact file map

| Step | Update existing files | Create files | Required change |
| --- | --- | --- | --- |
| 1. Separate coverage from adjudication | `lib/adverse-media.mjs`, `lib/gdelt-local-index.mjs` | `lib/adverse-media-coverage.mjs` | Compute a single source-coverage receipt before Gemini. Include requested/window covered, source attempts, pages exhausted, names queried, archive rows scanned, caps and reason codes. Make both routes use the same `coverage.complete` calculation. Stop deriving public coverage from `response.status`; eliminate `complete=true` plus `partial`. Keep the staged public-GDELT fallback disabled until an exact-range, verifiable fallback exists. |
| 2. Assess all relevant evidence | `lib/adverse-media.mjs`, `lib/ai7uae-gemini-adverse-api.mjs`, `lib/ai7uae-gpt-guidelines.mjs`, `lib/ai7uae-gpt-party-facts.mjs` | None | Remove the pre-Gemini `max_results` cut as a decision input; use it only for display. Bound and process all deduplicated plausible candidates, or mark coverage/processing incomplete when the budget or hard cap is reached. Fix victim, related-party, dated-incident and source-quality adjudication; retain item-level review reasons. |
| 3. Lock the profile | `lib/adverse-media.mjs` | `lib/adverse-media-profile-decision.mjs` | Add the common final Gemini schema, prompt, validation and evidence-ID checks. Set `status` from source execution, `profile_status` from validated Gemini assessment or fail-closed `inconclusive`, and `decision_eligible` separately. Remove threshold-derived profile selection from `applyRiskThreshold()` and `presentAdverseMediaResponse()`. Keep scores as supporting evidence only. |
| 4. Route, store and render consistently | `server.mjs`, `lib/adverse-media-report.mjs`, `lib/adverse-media-report-pdf.mjs`, `lib/flows/checks.mjs`, `api-site/adverse-media.js`, `api-site/adverse-media.html`, `api-site/adverse-media-coverage.html` | None | Standard and Search+ return the same three-state profile contract. Complete-source/Inconclusive cases return a completed screening and a report with an explicit evidence-review reason. Incomplete-source cases remain partial/Inconclusive. Make narrative, PDF, JSON, callback, API demo and Flo use the stored verdict verbatim; report coverage separately. Preserve `decision_eligible=false` for Inconclusive. Review existing clients that treat `status=completed` alone as clearance; version the response/route if any cannot be updated safely before promotion. |
| 5. Reconcile evidence and QA | `test/adverse-media.test.mjs`, `test/adverse-media-search-plus-api.test.mjs`, `test/adverse-media-public-coverage.test.mjs`, `test/adverse-media-adjudication.test.mjs`, `test/adverse-media-report.test.mjs`, `test/adverse-media-archive-full-api.test.mjs`, `test/forms.test.mjs`, `test/flo-supplier-onboarding-report.test.mjs` | `test/adverse-media-profile-decision.test.mjs`, `test/fixtures/adverse-media-profile-gold.json`, `docs/adverse-media-profile-qa.md` | Add source-coverage/property tests and a human-labelled holdout with direct misconduct, victims, old compilations, namesakes, related parties, clean cases, uncertain cases, multilingual aliases, source failures and archive boundaries. Regenerate one immutable per-case manifest linking request, raw source receipt, Gemini decision, JSON, PDF and hashes. Reconcile counts mechanically. Do not overwrite the prior 50-case record. |

**Files not required for this profile change:** storage account Bicep, GDELT ingestion job, Key Vault secret definitions and generic report stores. A 12-month historical backfill is a separate prerequisite for claiming complete coverage over that historical window; do not change its watermark to claim data that has not been indexed.

## Release gates

1. Every covered test case satisfies `coverage.complete=true -> status=completed`, including covered but inconclusive evidence. Every failed/older/limited source case has `coverage.complete=false`, `profile_status=inconclusive`, and a specific reason. Verify both API routes, cached responses, callbacks, Flo and PDFs.
2. Human reviewers label the holdout independently. Zero known victim/irrelevant/old-compilation cases may be auto-labelled `Unsafe`; zero known direct-adverse cases may be auto-labelled `Safe`. Measure false positives, false negatives and Inconclusive rate by category rather than reporting only HTTP success.
3. Re-run the 50 cases with an undated all-stored-history cohort and explicit covered/out-of-range dates. The API must read Azure in the actual request path. Produce one timestamped source SHA/image digest and matching CSV/JSON/PDF hashes; reject any report whose saved profile differs from its JSON.
4. Review the profile/status compatibility with existing API clients and Flo. Promote only after a controlled authenticated deployment run validates archive scans, Gemini verdicts, report retention, and rollback. Keep the existing production revision serving traffic until that gate passes.
