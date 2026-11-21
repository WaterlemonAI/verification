# Adverse Media Advance candidate QA — 21 November 2026 UTC

## Release state

The customer route remains disabled. Draft PR #157 at source commit `202c0a9` passed hosted CI. The isolated Azure UAE North candidate is pinned to `acrai7uaeuaen001.azurecr.io/ai7uae-api-adverse-candidate@sha256:6088f2aed7568e2f5f8f84ea764e5f039956312ff60b058624fe2d86ae3d2313` at revision `--0000038`, has no public ingress, and is parked at zero minimum replicas. The production API and GDELT schedules were not changed by this candidate update.

## First full-journey attempt

The candidate Advance harness stopped at its Azure archive preflight, before any external search or model call. V1's current stored-history window begins **4 October 2026 08:15 UTC**, while the V2 point-summary watermark begins **22 October 2026 21:15 UTC**. Their end was the same, **21 November 2026 01:30 UTC**. The weekly V1 backfill had extended the stored range without extending V2; the candidate harness correctly refused to claim complete fast-index coverage. No Advance PDF, callback or customer charge resulted from this attempt.

## Bounded V2 repair

- Execution `caj-ai7uae-gdelt-ingest-rsxea7q` used the immutable candidate digest, stored ZIPs only, at most 100 intervals, and concurrency 2. It succeeded, processing 4 October 08:15 through 5 October 09:00 UTC. Its output reported `processed: 100` and `more: true`.
- A second bounded execution, `caj-ai7uae-gdelt-ingest-6h266ce`, started at 19:44:45 UTC for 5 October 09:15 through 9 October 13:00 UTC, capped at 400 intervals and concurrency 4. Its result must be checked before the next chunk.
- The remaining stored gap must be rebuilt from immutable ZIPs, verified against V1, and measured for V1/V2 subject parity before the candidate Advance run. Enable V2 dual-write on both daily and weekly GDELT jobs through the reviewed main-branch deployment path before customer activation; otherwise a future backfill can make V2 stale again.

## Still required

Run the actual Advance HTTP → worker → retained JSON/PDF → signed callback journey with real providers on the current candidate digest. Review the earlier problematic ten and an independent ten, attribution errors, Safe/Unsafe/Inconclusive outcomes, source completion, p50/p90/p95, provider reservations, and one real private-queue retry. Keep customer enablement off until these gates and provider production entitlement are satisfied.
