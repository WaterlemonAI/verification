# Adverse Media Advance API — current status and artifact index

Status snapshot: 24 November 2026 (Asia/Kolkata). This README covers the Advance API work on draft [PR #157](https://github.com/WaterlemonAI/verification/pull/157), based on the V2 archive-index dependency in draft [PR #156](https://github.com/WaterlemonAI/verification/pull/156). Both draft PRs are open and their latest hosted `test` checks passed at inspection. The implementation is **not released to customers**. The release decision remains **HOLD**. PR #157's hosted check passed at source/documentation head `485c20a`; the V7 code change is `2261339`. The full local suite passed 634/634 before the final V7 PDF adjustment, and focused Advance tests passed 64/64 afterward. The latest private candidate was restored to its baseline image and observed at zero replicas. Recheck live state before a release decision.

## What the current V7 source does

- Scans the title and URL path of returned Brave and subject-matched V2 archive items with a versioned **748-term** adverse-signal lexicon (`2026-11-22.2`). A signal selects an article for review; it is not an adverse finding. The register keeps selected items, metadata exclusions, source provenance and matched terms.
- Reviews selected article evidence through resumable Gemini batches. The only assessed public subject relationships are `direct`, `indirect` and `no_association`. A relationship stays `null` with a separate review status when the evidence or model response cannot support a verified decision. Adverseness, subject role, identity and source-quote verification remain separate gates.
- Marks a subject **Unsafe** after one independently verified Direct adverse article, including a directly affected victim without implying culpability. Four distinct confirmed adverse articles across Direct or Indirect relationships stop later research and return Unsafe. Negative customer or employee reviews alone are not adverse media. Unresolved evidence cannot establish Safe.
- Selects at most 20 ranked items from the adjudicated set for the PDF; the full register also records candidates left unreviewed by an authorized early stop. The public JSON/PDF omit the Official records coverage field.
- In V7, detects a Gemini `PROHIBITED_CONTENT`/safety block before parsing the response, splits only the affected batch, checkpoints child results and records an individually blocked article as unresolved with a blocked review status. A refusal is not an adverse finding or a Safe finding. The $0.25 per-screening provider guard remains in force.

## Updated file map in PR #157

| Area | Files | Update |
| --- | --- | --- |
| API and job orchestration | `server.mjs`, `api/openapi.json`, `lib/adverse-media-advance-request.mjs`, `lib/adverse-media-advance-store.mjs` | Gated asynchronous Advance route, request/version scope, job persistence, owner-scoped evidence paging, result and callback contract. |
| Source discovery | `lib/adverse-media.mjs`, `lib/adverse-media-advance-lexicon.mjs`, `lib/gdelt-archive-candidate.mjs`, `lib/gdelt-archive-review.mjs`, `lib/adverse-media-advance-plan.mjs` | Preserve returned Brave metadata before legacy filtering; match archive title/URL signals; page and reconcile the V2 archive; plan bounded searches. |
| Evidence and classification | `lib/adverse-media-advance-evidence.mjs`, `lib/adverse-media-advance-classifier.mjs`, `lib/adverse-media-advance-policy.mjs`, `lib/adverse-media-advance-policy-catalog.mjs` | Canonical candidate register, three-way relationship and separate adverseness, identity/quote gates, V6 Unsafe rule, V7 blocked-batch isolation and checkpointing. |
| Report and storage | `lib/adverse-media-report-pdf.mjs`, `lib/adverse-media-report.mjs`, `lib/adverse-media-advance-narrative.mjs`, `lib/adverse-media-report-store.mjs`, `lib/adverse-media-json-store.mjs`, `lib/adverse-media-review-source.mjs` | Ranked PDF selection and review statuses, JSON/PDF consistency, stored result/evidence references and omission of Official records from public output. |
| Private QA runner | `scripts/adverse-async-candidate-qa.mjs` | Retains request, response, PDF, evidence, provider exchanges, cost, callback verification and budget-stop artifacts when available. |
| Tests | `test/adverse-media-advance-api.test.mjs`, `test/adverse-media-advance-classifier.test.mjs`, `test/adverse-media-advance-event-register.test.mjs`, `test/adverse-media-advance-pipeline.test.mjs`, `test/adverse-media-advance-policy.test.mjs`, `test/adverse-media-advance-request.test.mjs`, `test/adverse-media-report.test.mjs`, `test/adverse-media.test.mjs`, `test/adverse-media-adjudication.test.mjs` | API, selection, policy, relationship, report and fail-closed regression coverage, including V7 content blocks and cost propagation. |
| Documentation | `docs/adverse-media-advance-policy-framework.md`, `docs/adverse-media-advance-event-register-upgrade.md`, `docs/adverse-media-advance-candidate-qa-2026-11-21.md`, `docs/adverse-media-advance-gate-readout-2026-11-22.md`, `docs/adverse-media-advance-classification-rca-2026-11-23.md`, `docs/adverse-media-advance-five-case-evaluation-2026-11-23.md`, `docs/adverse-media-advance-seven-subject-evaluation-2026-11-24.md`, `docs/adverse-media-advance-content-block-recovery-2026-11-24.md` | Contract, original gap map, release gates, failure RCA and dated live-provider evaluations. Earlier dated results are historical; do not read them as a V7 release result. |

The V2 point-summary/index implementation is the dependency in PR #156. The authorized repair replayed 96 stored intervals, a 50-subject parity check found no V1/V2 count mismatch, and the two scheduled ingestion templates were configured for V2 dual-write. The V7 preflight observed matching V1/V2 end watermarks at 24 November 2026 01:30 UTC. These observations do not replace a fresh release-time readback.

## Private test results and exact locations

All paths below are relative to this repository root. **`output/` is local, private and untracked**; it is not part of PR #157. Provider exchanges and case data must remain private.

### Latest V7 isolated validation — Mickey Mouse

Directory: `output/adverse-advance-qa-2026-11-24/mickey-v7-content-block/`

The run selected 23 candidates. Three Gemini classification requests were blocked; smaller child requests recovered classifications for their articles. Gemini proposed classifications for 20 distinct articles (18 Indirect, two No Association, all proposed not adverse). Three candidates remained pending when the $0.25 guard stopped the run at $0.249248 reserved. **No final response JSON, PDF or callback was produced.** The worker returned a budget-blocked, decision-ineligible Inconclusive status; model proposals are not final verified findings.

| Material | File |
| --- | --- |
| Run metadata and restoration | `run-manifest.json` |
| Budget-stop response | `adverse-qa-artifacts/67bd9683-2d0a-470e-9bff-3263d7dc0773.budget-stop.json` |
| Provider responses and request bodies | `adverse-qa-artifacts/67bd9683-2d0a-470e-9bff-3263d7dc0773.provider-exchanges.json` |
| Submitted screening request | `adverse-qa-artifacts/67bd9683-2d0a-470e-9bff-3263d7dc0773.request.json` |
| Provider-cost record | `adverse-qa-artifacts/67bd9683-2d0a-470e-9bff-3263d7dc0773.cost.json` |
| Worker/build logs and retained package | `qa-mickey-v7.log`, `acr-build.log`, `qa-mickey-v7.tgz` |

### Seven-subject V6 isolated evaluation — completed reports

Directory: `output/adverse-advance-qa-2026-11-24/seven-revised-v6/`. The `run-manifest.json` maps each subject to its screening ID, profile, provider calls, cost, output hashes and callback check; `SHA256SUMS` covers retained artifacts. For each completed ID below, the directory contains **`<ID>.json` (final response), `<ID>.pdf` (report), `<ID>.request.json`, `<ID>.cost.json`, `<ID>.provider-exchanges.json`, `<ID>.evidence.json`, `<ID>.advance-evidence.json`**, plus a worker log. All five PDFs matched their recorded hashes and their signed callbacks verified.

| Subject | Screening ID | V6 profile | Final JSON/PDF |
| --- | --- | --- | --- |
| Mickey Mouse | `fdf7c740-a9b3-4679-a868-c46b0ac22e3b` | Inconclusive | Yes |
| Chota Bheem | `9b743eb7-2ce7-4f87-980d-e9e386a46ac2` | Safe | Yes |
| Jesus Christ | `c54a3e4d-c5a7-4e0f-8ccc-7c3485e8965a` | Inconclusive | Yes; archive posting-count mismatch |
| Gautam Buddha | `2d586998-c96a-4a1d-97ad-3f4ffb21be81` | Inconclusive | Yes |
| Vijay Mallya | `4a532345-667f-42f9-9db7-dc13d8e54fbd` | Inconclusive | Yes; 19 model-proposed Direct adverse relationships, none confirmed by the evidence gates |

Nirav Modi (`2dada8ea-4bad-41a4-8bd4-a57f9b7de27b`) and Lalit Modi (`4ddd724a-6bea-45be-a3c8-2cc6ab5cd2de`) were **budget blocked** on the trace-retention replay. Each has `<ID>.budget-stop.json`, `<ID>.request.json`, `<ID>.cost.json` and `<ID>.provider-exchanges.json`, plus worker logs; neither has final response JSON, PDF or callback. The directory also retains original run logs and transfer archives. The [seven-subject evaluation](./adverse-media-advance-seven-subject-evaluation-2026-11-24.md) explains the causal findings.

### Earlier Signzy live confirmation

Directory: `output/adverse-advance-qa-2026-11-23/five-global-v6/03-signzy/`. It contains `response.json`, `report.pdf`, `request.json`, `cost.json`, `provider-exchanges.json`, `evidence.json` and `advance-evidence.json`. That **historical** run found two verified Direct adverse security-incident articles concerning Signzy as an affected party and reconciled the JSON/PDF summary, but its Inconclusive profile predates the later one-Direct-implies-Unsafe source rule. See the [five-case evaluation](./adverse-media-advance-five-case-evaluation-2026-11-23.md); do not silently reinterpret the stored report as a current V7 result.

## Remaining release gates

The V7 source and hosted test check pass, but the full live release gate does not. Open work includes: exact source-span/quote recovery; independent identity evidence for name-only individual subjects; reconciliation of the missing one-of-7,508 Jesus Christ archive posting; a bounded handoff for individually blocked Gemini articles; cost handling for large candidate sets without silent omissions; and the controlled 10 + 10 release cohort with durable queue, owner-scoped export, callback, latency and rollback verification. The latest V7 run stopped before a final JSON/PDF. Keep customer Advance access off until these gates are resolved and reviewed.
