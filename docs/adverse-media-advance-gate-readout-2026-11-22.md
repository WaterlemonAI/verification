# Adverse Media Advance release gate readout — 22 November 2026

Scope: draft PR #157, with draft PR #156 as its V2 dependency. Live environment checks were read-only; the duplicate-call failure found during this gate was fixed on the isolated branch. **Release decision: HOLD.** Advance is not enabled on the running API; no production deployment or customer activation was performed.

## Pass 1 — completeness and correctness

| Gate | Observation | Status |
| --- | --- | --- |
| V2 stored-range coverage | Azure Blob readback: V1 `2026-09-24T10:15:00Z` to `2026-11-22T01:30:00Z`; V2 `20260924101500` to `20261122013000`, index version 2, 5,630 committed intervals, last updated `2026-11-22T01:52:02Z`. The windows align. | Partial: current 50-subject parity and posting reconciliation remain unverified. |
| Ongoing V2 dual write | Current scheduled ingest and backfill Container App job templates have no `GDELT_V2_DUAL_WRITE` environment setting. The script enables V2 writes only when it equals `true`. Recent ingest executions succeeded, but their success does not prove future scheduled V2 maintenance. | Fail for ongoing coverage. |
| Live V1/V2 subject parity | The controlled 50-subject parity readback received Azure Table `AuthorizationPermissionMismatch` (403). No RBAC or secret changes were made. A prior 50-subject parity result predates this implementation. | Blocked. |
| Candidate selection and relationship logic | Focused local tests passed 43/43, including all returned Brave metadata decisions, >1,000 archive postings, missing evidence, three relationship classes, and the 20-item cap. The lexicon has 741 distinct terms at version `2026-11-22.1`. | Local pass; real-provider verification pending. |
| Signzy recall | Replaying the retained, pre-upgrade Signzy response identified 19 article entries, selected 8 by title/URL, and selected the one security-incident/data-leak entry. This proves metadata recall on that retained input only; article review and final attribution were not run on the new candidate. | Partial. |
| Controlled cohort | The required 10 earlier problematic and 10 independent real-provider cases have not been run against this commit. Historical artifacts are from an earlier candidate. The current local shell lacks the isolated candidate's managed identity and provider configuration; no suitable isolated candidate job was found. | Blocked. |

## Pass 2 — operations and cost

| Gate | Observation | Status |
| --- | --- | --- |
| One paid extraction and model decision per canonical URL/version | Gate inspection found a duplicate archive-stage Gemini call. The isolated branch now records selected archive metadata as `deferred` and sends the merged canonical URL through the final Advance extractor and model reviewer once. A local overlap/replay test counted zero archive-stage calls, one extraction and one model decision, with no extra call on replay. | Local pass; real-provider and crash replay proof pending. |
| Replay, owner isolation, pagination, callback, payload bounds and PDF cap | Local tests cover parts of these behaviors. No post-upgrade crash replay, owner isolation, callback delivery, large-register export or PDF readback was exercised on an isolated real-provider candidate. | Pending live proof. |
| Usage, cost and latency | No post-upgrade candidate run exists from which to measure per-source/model spend or cold/warm end-to-end p50/p90/p95/p99. | Pending. |
| Log/PDF sensitive-data review | No post-upgrade run artifacts exist for the required log and PDF inspection. | Pending. |
| Staged rollback | The running API has no `ADVERSE_MEDIA_ADVANCE_ENABLED` setting, and the route remains disabled. A staged enable/disable drill retaining evidence was not run. | Pending; currently off. |

## Required before release

1. Make scheduled V2 dual writes durable, then obtain authorized Azure Table read access for current parity and posting-count reconciliation. Keep the running Advance route disabled while checking these.
2. Verify the new deferred archive path on the isolated real-provider candidate, including overlap, interruption and replay, before accepting the one-call cost invariant.
3. Deploy an isolated, digest-pinned candidate with the required managed identity and approved provider configuration. Run the 10 + 10 real-provider cohort, retain bounded evidence and callback artifacts, and measure costs, timing, PDF cap, source reconciliation and rollback. A metadata-only Signzy match is not a finding about the company.

Evidence for this readout: Azure Blob V1/V2 state readback; current Container App job and API template readback; latest job execution statuses; focused Advance/Archive tests (43/43), including a new overlap/replay call-count test; full local `npm test` (613/613); local matcher replay against the retained Signzy response. The private QA outputs under `output/` remain untracked and must not be committed.
