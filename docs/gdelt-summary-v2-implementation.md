# GDELT V2 materialized lookup: implementation and release plan

This plan applies to the unreleased adverse-media candidate merged with current `main`. V1 raw ZIPs and `GdeltEntityMentions` remain the audit source. No live routing changes until the V2 verification gate passes.

## Exact file map

| File | Change |
| --- | --- |
| `lib/gdelt-summary-v2.mjs` (new) | Deterministic interval manifests, bounded per-entity summaries, idempotent conditional updates, contiguous V2 watermark, point-read search. |
| `scripts/gdelt-ingest.mjs` | Dual-write V2 after V1 batch success; publish an interval only after every summary update succeeds. Preserve source ZIP hash. Bound the optional V2 write concurrency at 64. |
| `scripts/gdelt-backfill.mjs` | Pass V2 clients to the same interval processor; keep the two-hour UAE schedule and V1 checkpoint behavior. |
| `scripts/gdelt-index-v2-rebuild.mjs` (new) | Replay stored immutable ZIPs from the V1 watermark range with bounded resume; no public GDELT re-download. Track both ends of a contiguous cursor, handle newly backfilled older history, reject legacy high-only cursors, and keep explicit repair runs from changing the normal cursor. |
| `scripts/gdelt-index-v2-verify.mjs` (new) | Independently check every manifest, ZIP digest, parsed count, and summary interval bit before cutover. Allow an explicit historical segment to be audited before the full V2 watermark is contiguous. |
| `lib/gdelt-local-index.mjs` | Feature-flagged V2 point reads; V1 remains the fallback before a verified contiguous V2 snapshot. Read a fresh source/V2 watermark signature for cache invalidation. |
| `lib/adverse-media.mjs` | Separate date gaps from retrieval/evidence limits; propagate unreviewed archive evidence into the locked Inconclusive decision. Invalidate the 12-hour completed-result cache when archive coverage changes and expose unresolved classification reason codes. |
| `server.mjs` | Start the listener only when executed as the program entry point, permitting an isolated HTTP QA runner to import the production handler without also binding port 8080. |
| `scripts/adverse-candidate-live-qa.mjs` (new) | Guarded internal-only real-provider HTTP runner with ephemeral billing/report stores, subject cohort and PDF validation. |
| `scripts/gdelt-v2-live-probe.mjs` (new) | Read-only managed-identity point-read probe that reports counts and latency without leaking raw article references. |
| `infrastructure/api-gdelt-platform.bicep` | Add the V2 summary and manifest tables in the existing account; identities already have scoped Table roles. |
| `infrastructure/api-gdelt-v2-tables.bicep` (new) | Deploy only the two V2 tables against the existing account. The full platform template's what-if also proposed unrelated Blob and role-assignment modifications, so it is not the safe table-creation path. |
| `.github/workflows/deploy-gdelt-backfill.yml` | Bind the new V2 runtime files to the reviewed image SHA, retain the dual-write setting on job redeploy, and check that both tables exist before enabling it. |
| `.github/workflows/deploy-api.yml` | Pass the V2 read environment setting into both API preview and deployment; avoid silently resetting a later canary on redeploy. |
| `infrastructure/api-gdelt-job.bicep`, `infrastructure/api-gdelt-backfill-job.bicep` | Supply V2 table names and dual-write flag to ingestion jobs. |
| `infrastructure/api.bicep` | Supply V2 read flag and table names to API; start disabled. Set undated Azure-only policy on; explicit historical date gaps retain public DOC fallback. |
| `test/gdelt-summary-v2.test.mjs` (new) | Idempotence, retry, watermark gaps, popular-name bounds, exact-name lookup, and unreviewed-evidence behavior. |
| `test/adverse-media-profile-decision.test.mjs` | Preserve an explicit uncertainty reason when a completed Gemini call still leaves unresolved evidence. |
| `test/adverse-media-public-coverage.test.mjs` | Direct public DOC retry tests use explicit historical dates; undated Azure-only behavior is checked in the V2 test file. Existing V1 ingestion and local-index tests run unchanged. |
| `docs/gdelt-v2-live-validation-2026-11-20.md`, `docs/gdelt-v2-live-results-2026-11-20.json`, `docs/gdelt-v2-masdar-live-2026-11-20.json`, `docs/gdelt-v2-point-probe-2026-11-20.json` (new) | Record the isolated Azure job evidence, nine real-provider API outcomes, point-read metrics and open release gates. |

The second review found that the existing locked profile unit test also encoded the superseded “one confirmed adverse plus partial coverage is Inconclusive” rule. `lib/adverse-media-profile-decision.mjs`, `test/adverse-media-profile-decision.test.mjs`, and one assertion in `test/adverse-media.test.mjs` are therefore in scope: any confirmed direct adverse article remains Unsafe, with the coverage gap still reported.

No HTML, Flo, billing, or customer data files are involved. A full-evidence review worker and paged export are **a separate release gate**: the V2 point summary intentionally cannot claim Safe for unreviewed mentions. They require a documented source-text licence, classification policy, cost budget, and durable worker contract; until then those cases stay Inconclusive. The raw V1 index remains available for authorized investigation. This prevents the proposed fast lookup from silently changing the evidence standard.

## Build order

1. Provision V2 tables only; leave all flags off. Add manifest and summary format with `index_version=2`, bounded examples, exact mention counts, a compact applied-interval bitmap, and ETag guarded updates. Replaying a 36-hour overlap or weekend interval must not change counts.
2. Dual-write V2 during daily and weekend ingestion. Write the manifest only after all summary updates finish. Publish V2 watermark only across adjacent committed manifests; a source 404 or failed write stops advancement. Rebuild older stored ZIPs with a resumable cursor.
3. Verify every interval before enabling reads: raw SHA-256, source row and mention counts, per-entity applied bit, contiguous 15-minute timestamps, and a sample of V1 postings. A missing or mismatched interval fails the gate.
4. Enable V2 reads for controlled cases. Compare point-read results and exact counts with a paged V1 reference for low, medium, and high-volume names. V2 does not scan all V1 rows synchronously. Report `unreviewed_count` and sampled-ref limits separately from source coverage.
5. Benchmark warm and cold p50/p95/p99 on at least 50 controlled names. The target is archive lookup p95 under 250 ms for a ready exact-name summary; end-to-end Brave/Gemini/PDF remains a separate latency metric. Roll back by disabling the read flag.

### Operator sequence

1. Deploy `api-gdelt-v2-tables.bicep` only after its what-if shows exactly two `Create` changes and no modifications. Confirm table creation and identity access with a read/write probe in the GDELT job identity. Do not apply the full platform template for this step: its live what-if on 20 November also proposed unrelated Blob and role-assignment modifications.
2. Deploy the daily and weekend jobs with `v2DualWrite=true` and the same reviewed digest. The API remains at `gdeltV2ReadEnabled=false`. Confirm the daily job writes `verified=true` manifests and advances `state/v2-watermark.json`; a source or verifier failure must leave the V1 and V2 watermarks at their last committed intervals.
3. Start a **manual execution** of the existing ingestion job with its command overridden to `node scripts/gdelt-index-v2-rebuild.mjs`. It reads stored ZIPs only. The resumable cursor is `state/v2-rebuild.json`; each run processes at most `GDELT_V2_REBUILD_MAX_INTERVALS` (default 400). Repeat until `more=false`. Pause this manual task around the scheduled daily/weekend runs if storage throughput is constrained. An explicit `GDELT_V2_REBUILD_FROM` replays an earlier range after repair.
4. Start a manual execution with command `node scripts/gdelt-index-v2-verify.mjs` and a bounded `GDELT_V2_VERIFY_FROM`/`GDELT_V2_VERIFY_TO` range. The command exits 2 and returns `next_interval` when more intervals remain; advance the range until every V1 interval is checked. Treat any digest, count, V1 sample, manifest, or summary-bit disagreement as a failed release gate.
5. Only when V2 start/end covers the **fresh** V1 watermark, compare V2 and paged V1 results for at least 50 controlled names including common names. Enable `gdeltV2ReadEnabled=true` for a canary only after parity, p50/p95/p99 and fail-closed profile checks. Disable that parameter for immediate rollback.

The two manual commands use a digest-pinned candidate image and the existing ingestion identity. `az containerapp job start` supports `--command`, `--image`, and execution-only `--env-vars`; when overriding environment variables, pass the storage URL, archive container, V1 table and managed-identity client ID explicitly. Do not use the older localhost prototype or change the live API flag during rebuild. This plan does not claim that an all-article review can finish in milliseconds. The [20 November live validation](gdelt-v2-live-validation-2026-11-20.md) records the currently verified segment and the remaining gates.

## Review 1: data and migration

- The V1 watermark is not V2 proof. V2 has its own contiguous watermark; empty-name lookups are complete only inside that verified range.
- Manifests use immutable source ZIP bytes. V2 replay checks source SHA and deterministic counts. Summary updates are ETag-guarded and track each applied interval, so daily overlap and crash retries cannot double count.
- A Table entity stays bounded: the bitmap has a fixed maximum span, and only a small set of references is stored. Counts do not pretend to be deduplicated URL counts.
- Rebuild consumes existing ZIPs, not public DOC; explicit historical requests outside the committed V2 range retain the existing date-gap fallback. Undated all-stored requests remain Azure-only.

## Review 2: failure, decision, and rollout

- A scan cap, summary cap, or missing review is not a date gap. Do not call public GDELT for those conditions.
- Complete **source coverage** does not mean complete **article adjudication**. If any archive mention remains unreviewed, a Safe profile is forbidden. Confirmed direct adverse evidence can still be Unsafe under the locked policy.
- Absence of an entity summary is a valid zero only with a verified contiguous V2 watermark. Missing state, partial backfill, corrupt summary, overflowed bitmap, or verifier disagreement is Inconclusive or falls back to V1.
- Keep read and write flags independent. Deploy tables and dual write first, verify/rebuild, then canary reads. Do not enable V2 reads or declare production performance until the release gate is measured.

## Evidence-review follow-on file map

The materialized index is a fast **retrieval and coverage** layer. It intentionally leaves `unreviewedCount` positive for every GKG mention because GKG is co-mention metadata, not article text. To add the separate durable full-evidence process, create `lib/gdelt-evidence-review.mjs` and `scripts/gdelt-evidence-review.mjs` for resumable URL deduplication, licensed article retrieval, Gemini batch classification, source citations, review status and a bounded cost budget. Add `infrastructure/api-gdelt-review-job.bicep` for an isolated manual or queued worker, `lib/gdelt-evidence-export.mjs` and authenticated `server.mjs` routes for paged evidence retrieval, and `test/gdelt-evidence-review.test.mjs` plus API authorization tests. The worker may reduce `unreviewedCount` only after every posting for that entity and snapshot is resolved and independently reconciled. It must never infer Safe from a top-20 sample. Those files are excluded from the V2 retrieval cutover because article access rights, exact review policy, retention, and per-subject spend limits are not yet specified; enabling Safe from them without those controls would weaken the requested decision rule.
