# Adverse Media Advance release gate readout — 23 November 2026

**Later operational update, 23 November:** The user separately authorized V2 repair and the five-case rerun after the isolated-only scope recorded below. The 96 missing V2 intervals were replayed, the 50-subject parity check found zero count mismatches, and both scheduled jobs now have a V2-capable digest with dual-write enabled. A corrected private `advance-review-v5` candidate captured the previously missed Signzy security article as Direct adverse media. Four of five requested cases reached verified callbacks; Salman Khan was budget blocked before a final report at the existing $0.25 provider ceiling. The release decision remains **HOLD**. The [later evaluation](./adverse-media-advance-five-case-evaluation-2026-11-23.md) has the current source, digest, counts and remaining gates. The observations below are the earlier point-in-time readout.

Scope: draft [PR #157](https://github.com/WaterlemonAI/verification/pull/157) at `f243758aa0c2e5a51da541e073f0b08c07a68423`, based on the V2 index dependency in draft PR #156. **Release decision: HOLD.** The code and hosted test gate pass, but the live data and operational gates do not. The running customer API and scheduled ingestion jobs were not changed. The user authorized isolated validation only.

**23 November classification follow-up:** The branch now contains local `advance-review-v4` relationship/adverseness corrections described in the [classification RCA](./adverse-media-advance-classification-rca-2026-11-23.md). The live observations below remain from the earlier digest-pinned candidates; no `v4` real-provider result exists while V2 is behind V1.

## Implementation and local proof

The Advance branch implements the versioned 500+ adverse-term title/URL filter, a decision for every returned Brave result and V2 posting, paged candidate review, three-way subject relationship with an unassessed state, grounded quote checks, full owner-scoped evidence export, and deterministic selection of at most 20 PDF leads. It preserves a candidate as unresolved when article evidence or a model decision cannot be verified; it cannot turn a processing limit into `Safe`. Archive posting decisions are keyed by posting ID so a neutral and adverse posting with the same canonical URL cannot suppress the adverse candidate. The final review deduplicates by URL.

The lexicon version is `2026-11-22.2` with 748 distinct terms. A live Brave response exposed the exact title `India's Digital Identity Titan Faces Cybersecurity Scare, Highlighting Concerns With Digital ID`; the new `cybersecurity scare` phrase selects it for article review. The review schema is `advance-review-v3`, with an explicit prompt for a contiguous verbatim quote. The server still verifies that quote against source text rather than trusting the model.

Local `npm test` passed **615/615** at this head. The hosted `test` check passed in [run 45040582182](https://github.com/WaterlemonAI/verification/actions/runs/45040582182). The PR remains draft and targets PR #156's branch.

## Isolated real-provider proof

The private candidate had internal-only ingress, one replica during validation, and a digest-pinned image. It used an in-process QA queue, so these runs do not prove Azure Queue durability. No customer Advance access was enabled.

| Case and image | Observed result | Gate |
| --- | --- | --- |
| Signzy, `8213978` candidate | Delivered JSON/PDF with matching hashes and a verified signed callback. Brave returned 30 results / 28 unique; 17 selected and 11 excluded. Seventeen article extractions and four Gemini calls were recorded; reservation was USD 0.118488; end-to-end time was 65.366 s. The cybersecurity-scare title was missed by the earlier lexicon. | Recall fail; corrected in `ceaaecf`. |
| Signzy, `ceaaecf` candidate | Delivered JSON/PDF with matching hashes and a verified signed callback. Brave returned 29 results / 27 unique; the full 27-item evidence register was exported and reconciled. Sixteen selected, 11 excluded; 16 extractions and four Gemini calls; reservation USD 0.117515; end-to-end time 64.902 s. The cybersecurity-scare title was selected, extracted, sent to Gemini, and appeared among 15 PDF leads. Its relationship was **unassessed**: the model supplied a non-verbatim quote, so the server withheld the proposed finding. | Metadata recall pass; grounded classification remains unproven. Prompt revised in `f243758`. |
| Adobe Inc, `ceaaecf` candidate | Preflight found 106 archive postings and the worker reached the screened stage. The interactive run ended without a captured terminal result or retained artifact. | No pass claimed. |
| Signzy, `f243758` candidate | The QA preflight stopped before provider calls with `candidate_v2_snapshot_unavailable`. On 23 November, the V1 archive watermark was `2026-11-23T01:30:00Z`, while V2 remained at `20261122013000` (5,630 committed intervals). The V2 summary refuses a snapshot that no longer covers V1. | Live validation blocked by V2 drift; fail closed. |

The Signzy case is a recall and attribution test, **not** a finding that Signzy committed misconduct. The unresolved status is the correct outcome when the proposed evidence cannot be anchored.

## Remaining release gates

| Gate | Status and evidence |
| --- | --- |
| Continuous V2 coverage | **Fail.** Scheduled ingest and backfill jobs have no `GDELT_V2_DUAL_WRITE=true` setting. V1 advanced by one day while V2 did not. Changing those production job templates was outside the user's isolated-validation authorization. |
| Current V1/V2 parity | **Blocked.** The local 50-subject Azure Table data-plane read received `AuthorizationPermissionMismatch` (403); no RBAC change was made. Current posting-count reconciliation is therefore unproven. |
| Twenty-case controlled cohort | **Incomplete.** The required ten earlier problematic and ten independent cases were not run at this head. The latest candidate cannot start while V2 is behind V1. |
| Grounded relationship and adverse classification | **Open.** The live Signzy headline reached Gemini but failed quote anchoring under the preceding schema. The `advance-review-v3` prompt is tested locally, but has no successful real-provider run because of V2 drift. |
| Crash replay, private owner scope, Azure Queue, callback, cost and latency | **Partial.** Local tests cover replay and owner scope; the Signzy isolated run verified callback and artifact consistency. No full crash/restart drill, durable Azure Queue proof, private owner export readback, or cohort p50/p90/p95/p99 exists. |
| Rollback and customer flag | **Customer route remains off.** Private candidate revision `--0000061` was read back with its baseline digest `sha256:729f4cfc5c49668b459bed37379a4dcd6d6d8959f02a5eef91471bd6f02b5cab`, `minReplicas=0`, and provisioning `Succeeded`. No production flag or scheduled job was changed. |

## Release sequence after authorization

1. Review and authorize the production V2 maintenance scope separately. Make scheduled dual-write durable, catch V2 up to V1, and verify current 50-subject and posting-count parity with appropriate read access.
2. Re-run the digest-pinned `f243758` isolated Signzy case and the 10 + 10 cohort. Inspect article-level relationship, quote anchoring, complete register, 20-item PDF cap, JSON/PDF/callback agreement, cost, and latency. A model failure or exhausted budget must remain unresolved or budget-blocked.
3. Exercise durable Azure Queue replay, owner isolation, paged export, and rollback. Re-review PRs #156 and #157 and their hosted checks before any customer enablement.

Private QA outputs and provider exchanges remain outside the committed tree under `output/` or the candidate's temporary storage. Do not commit provider credentials, source bodies, or case artifacts.
