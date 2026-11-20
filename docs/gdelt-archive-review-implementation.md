# GDELT archive review: shortest end-to-end implementation plan

**Status:** source implementation in progress on `codex/gdelt-versioned-summary`, 20 November 2026. The paged V1 worker, owner-scoped review ledger, profile integration, evidence route, Search+ async handling, PDF summary and off-by-default flag are present in the worktree. This has not been deployed. The V2 read flag remains off in the [last retained live validation](gdelt-v2-live-validation-2026-11-20.md); refresh cloud state before release.

**Remaining release gates:** No approved article-text provider or article-level Gemini adjudicator is wired, so an archive with unreviewed mentions remains Inconclusive. The source has an injected `adverseArticleResolver` seam for a reviewed provider adapter; do not enable the flag for customers until its contract, cost cap and evidence safeguards are implemented and tested. Full V2 rebuild and independent V1/V2 parity, controlled live subjects, cold/warm latency and cost measurement, and a complete callback/report pilot also remain outstanding. Local tests do not substitute for these gates.

The staged production sequence and evidence packet are in the [Adverse Media V2 go-live plan](adverse-media-v2-go-live-plan.md).

## Objective and boundary

Return a defensible **Safe**, **Unsafe**, or **Inconclusive** adverse-media profile without scanning the entire Azure archive in the HTTP request. The lookup should use the V2 summary; a first-time, evidence-heavy subject may need asynchronous review. A completed review can be reused only for the same subject identity, archive snapshot, review policy and owner. A fast count is not a completed screening.

Keep these existing behaviors: Search+ adds publisher searches; it does not replace standard searches. Undated requests search all history actually stored in Azure and do not call public GDELT. A dated gap may call only the public GDELT DOC fallback, with up to three attempts. A scan cap, missing review, provider failure or cost cap cannot be treated as complete evidence. Confirmed direct adverse evidence is Unsafe even when another source is incomplete; Safe requires complete required sources and resolved relevant evidence.

### Reuse instead of rebuilding

| Existing component | Use |
| --- | --- |
| `GdeltEntityMentions` (V1 Azure Table) and raw ZIPs | Complete archived mention references and audit source. Page V1 by exact name hash and RowKey date range; do not create a duplicate posting table. |
| `GdeltEntitySummaryV2` and verified manifest/watermark | Fast count and source-window lookup. The 20 sample references are for display only. |
| `adverse-media-deep-research` queue and `startDeepResearchWorker` | Existing retry, signed callback, dead-letter and cost-reservation mechanism. Add a bounded archive-review stage; do not provision another queue or job. |
| `AdverseMediaReports` table and existing report Blob container | Owner-scoped review cursor and article decisions in Table; final PDFs remain in the existing Blob container. No new Azure data resource or RBAC is proposed. |
| Existing Gemini party-facts schema/guard and profile decision function | Subject-role and event classification, with a separate durable archive review result. Gemini output never overrides source gaps or the deterministic profile rule. |

The source configuration grants the API identity **read** access to GDELT storage and uses a separate writable adverse-media report store. The worker runs in that API app. Confirm both permissions and private data paths in the target deployment before enabling the feature. Do not grant the API write access to the GDELT account.

## Review record and correctness rule

Issue an opaque server-generated `review_id` and calculate a separate reusable fingerprint. That fingerprint must include the owner, entity type, normalized name and aliases/transliterations, relevant associations, archived interval start/end or snapshot identifier, review-policy version and article-evidence adapter version. Search+ status belongs to the **screening** fingerprint; the Azure archive review may be reused across standard/Search+ only when the archive subject and snapshot keys are identical.

Persist an ETag-guarded manifest and immutable, bounded per-article decisions in the existing owner-partitioned report table. Each article decision records canonical URL/record IDs, source date and publisher, matched name, subject-role finding, adverse/general/irrelevant/unresolved classification, supported allegation and legal stage, short source quote or evidence reference, model/adapter version, reason code, review time and input digest. Store raw article text only where the source licence permits it. The public PDF and callback expose bounded, customer-ready evidence; the full ledger is available only through an authenticated, owner-scoped paged endpoint.

The worker scans **all** V1 postings in each requested exact-name range, with Azure continuation tokens and a persisted cursor. It tracks both posting count and deduplicated canonical-article count, and reconciles each exact-name posting count to the V2 summary for the same published interval window. Duplicate URLs or aliases must not inflate adverse article counts. A missing page, changed snapshot, alias overflow, unresolved relevant article, invalid count, lease conflict, provider outage or budget exhaustion leaves the review Inconclusive. No top-20 or top-50 result cap can certify Safe. A new daily interval or older backfill invalidates the completed snapshot; incremental review may reuse unchanged article decisions only after the new interval counts reconcile.

The V2 row's current `unreviewedCount` resets to total mentions on each ingestion. Treat it as a **pre-review diagnostic**, not the authoritative review state. Authoritative `reviewed`, `excluded`, `unresolved` and `confirmed_adverse` counts come from the durable review manifest and pages. Source-window coverage and article adjudication are separate fields.

## Exact file map

### Update existing files

| File | Surgical change |
| --- | --- |
| `lib/gdelt-local-index.mjs` | Extract/reuse the exact-name, V1 RowKey-bounded query as a paged worker iterator with continuation tokens. Keep the existing synchronous 15-second/100,000-row protection unchanged. |
| `lib/gdelt-summary-v2.mjs` | Return a stable verified snapshot identifier and per-name mention counts; label the 20 links as samples. Do not derive review completion from `mentionCount`, `unreviewedCount`, or sample size. Reject all-stored reads when a row contains intervals outside the published snapshot until the snapshot model can isolate them. |
| `lib/adverse-media-report-store.mjs` | Add owner-scoped, conditional review-manifest writes and immutable article-decision reads/writes in the existing table; implement bounded, stable pagination. Memory implementation mirrors the contract for tests. Do not use short-lived deep-research component blobs as the final ledger. |
| `lib/deep-research-queue.mjs` | Add a versioned archive-review stage to the existing worker. Checkpoint and release a job before its 15-minute visibility lease expires; resume idempotently, reserve provider spend once, and retain the final signed callback/retry behavior. Carry the original standard/Search+ variant through the job; Search+ must use its current Gemini classifier and report type. Old version-2 jobs continue unchanged. |
| `lib/adverse-media.mjs` | Merge the durable archive's **aggregate** confirmed-adverse and unresolved counts before the 50-result display cap and deterministic profile decision; include a bounded selection of reviewed evidence in the response. Keep Brave/public-DOC source logic and Search+ planner unchanged. Add owner/review-version isolation to the 12-hour cache key or bypass cache for owner-scoped review results; invalidate on snapshot/review changes. |
| `lib/ai7uae-gemini-adverse-api.mjs` | Reuse the party-facts schema for bounded article evidence, with source text treated as untrusted. Validate the returned quote against the supplied evidence and fail closed on missing/ambiguous subject or unsupported adverse assertion. Do not classify an article from GKG co-mention metadata alone. |
| `server.mjs` | Reuse the existing `deep_research=true` plus public `callback_url` opt-in for standard requests, and permit it on entitled Search+ requests after the worker supports that variant. Return the existing 202 signed-callback contract; the stable review ID appears in the final result after the snapshot is known. Keep current synchronous behavior for callers that do not opt in: pending archive evidence is Inconclusive. Add authenticated `GET /service/adverse_media/reviews/{reviewId}/evidence?cursor=...` with owner checks, fixed page limit and no raw provider secrets. Finalize one immutable report after review settles, including a terminal Inconclusive result. |
| `lib/adverse-media-report-pdf.mjs` | Show archive window, reviewed/unresolved counts, source coverage versus adjudication status, review policy version and the reason for Inconclusive. Do not imply the 20 V2 samples are complete archive evidence. |
| `api/openapi.json`, `api-site/adverse-media.html`, `api-site/adverse-media.js` | Document/enable the opted-in async review for both endpoints, callback shape, evidence pagination, scope and pending Inconclusive state. Preserve existing request examples and Search+ entitlement UX. |
| `infrastructure/api.bicep`, `.github/workflows/deploy-api.yml` | Add and preserve an **off-by-default** archive-review flag and bounded per-review budget. Reuse existing storage URLs, identity and queue. Preview must show no new storage/RBAC resources. If an approved article provider needs a new secret, use the existing Key Vault integration and separately review that configuration change. |
| `test/gdelt-summary-v2.test.mjs`, `test/adverse-media-archive-full-api.test.mjs`, `test/deep-research-queue.test.mjs`, `test/adverse-media-search-plus-api.test.mjs`, `test/adverse-media-report.test.mjs` | Add focused regressions for snapshot parity, page/callback retries, standard/Search+ equivalence, count reconciliation, owner isolation, report truthfulness and fail-closed profile decisions. |

### Create only these files

| File | Purpose |
| --- | --- |
| `lib/gdelt-archive-review.mjs` | Paged V1 scan, URL deduplication, conservative candidate handling, evidence-access interface, Gemini adjudication orchestration, cursor/reconciliation and final review summary. Inject the article-evidence adapter; do not hard-code a vendor. |
| `test/gdelt-archive-review.test.mjs` | Meaningful low/high-volume, duplicate, changed-watermark, crash-resume, unavailable-content and false-Safe cases. |
| `test/gdelt-archive-review-api.test.mjs` | Authenticated pagination, tenant isolation, async callback, Search+ and report integration through the production handler. |

**Conditional file:** create `lib/gdelt-article-evidence-provider.mjs` only after an approved source contract is selected and a controlled pilot proves URL/article evidence coverage, language support, latency, retention rights and price. The adapter calls only its configured provider endpoint; archived article URLs are untrusted identifiers, never arbitrary network destinations for the worker. No approved article-text adapter is present in this source. The worker must return `unresolved` without one; it must not silently scrape publisher pages or call a generic search hit a reviewed article.

## Build sequence and acceptance gates

1. **Finish the existing retrieval release gate.** Run the current V2 rebuild/verify against every stored V1 interval, then independently compare paged V1 and V2 exact-name counts for at least 50 low-, medium- and high-volume subjects, including the previously failing subjects. The retained 20 November run verified 20 historical intervals plus one current interval out of 2,706; refresh the actual count before execution. No API read cutover on a partial snapshot.
2. **Implement the paged worker and durable store.** Use a bounded number of V1 pages per dequeue, an ETag lease and immutable decision pages. Resume after crashes without duplicate Gemini/provider calls or duplicate costs. Reconcile posting counts, unique URLs and decisions before completing the review. Test older backfill and new daily intervals. Keep the feature flag off.
3. **Pilot article-level evidence.** Evaluate an approved article-evidence source against controlled English/Arabic, common-name, high-volume, direct-adverse and neutral cases. Require source quote/URL traceability and approved retention. First deduplicate and use trusted identity evidence to exclude clear namesakes or unrelated subjects. Do **not** clear a co-mention merely because its GKG title/themes lack adverse words. Obtain article-level evidence for every remaining plausible item; any inaccessible or unsupported item stays unresolved. Measure exclusion recall against a labeled corpus. Do not claim a generic adverse-media feed covers every GDELT URL without proving it.
4. **Wire final screening and reports.** Integrate the reviewed archive result with standard and Search+ without re-running their paid searches after a queue retry. Enforce: any confirmed direct adverse → Unsafe; incomplete required source, unresolved plausible article, review/budget failure → Inconclusive; Safe only with complete required source coverage and zero unresolved relevant articles. Preserve the dated public-GDELT three-attempt policy. Test the full 202 → worker → immutable JSON/PDF → signed callback and authenticated evidence export.
5. **Measure and release in stages.** Run the known failed subjects plus a larger labeled adverse/neutral/homonym corpus; 50 cases alone do not establish a low false-Safe rate. Record V1 page counts, review cost, provider and Gemini calls, cache behavior, and API p50/p90/p95/p99 separately for cold first review and warm completed review. Cap review concurrency in the shared API app and verify API latency is not degraded; use a separate worker only if this gate fails. Canary with the flag on for controlled callers; audit one standard and one Search+ result and their PDFs. Roll back by turning the flag off; retain already written audit evidence.

## Explicit completion criteria

- The V2 watermark covers and independently verifies the full stored V1 range with no unexplained interval or posting-count difference.
- Every reviewed subject has a durable manifest whose posting counts reconcile with the exact V2 snapshot, with article decisions or documented exclusions accounting for all relevant candidates.
- No failure path produces a false Safe result. Confirmed adverse is never hidden by a result-display cap, publisher failure, model error, missing article or archive timeout.
- Standard and Search+ preserve their existing source plans; Search+ remains additive. A warm completed archive review makes no repeat **article-evidence/Gemini review** calls for the exact same owner/subject/snapshot/policy; Brave searches continue under their existing 12-hour cache and freshness policy.
- Report, callback and authenticated export show the same final profile, reason codes, source window, review status and evidence counts. No cross-owner evidence access is possible.
- Provider cost is measured and capped separately from the existing synchronous search budget. A cap returns Inconclusive and a resumable state, not Safe.
- A queued review has explicit billing treatment; retries, resumed pages and callback delivery cannot charge a second screening or silently add an unpriced article-provider cost.

## Two review passes on this plan

**Pass 1 — shortest path:** V1 already has the full postings; the existing API app has GDELT read access, queue processing and private report storage. A second posting database, new queue, new job, new identity and GDELT write role are unnecessary for the first implementation. The only additional persisted data are review state and decisions.

**Pass 2 — failure and compatibility:** the V2 sample and mutable `unreviewedCount` cannot certify Safe; a finished review must be bound to its snapshot and owner. Existing synchronous calls and queued version-2 jobs must retain their contract. Search+ cannot silently drop publisher searches. The current 12-hour process cache needs owner/review isolation, and all final evidence export needs authenticated pagination. Article access and rights remain an explicit Safe-result release gate rather than an assumed capability.
