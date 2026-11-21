# Adverse media V2 candidate QA — 20 November 2026 UTC

## Release decision

**No-go.** The internal candidate completed archive rebuild and point-lookup parity, but the first real-provider cohort exposed a cost-ordering failure. The additional ten subjects were not run because the user's condition was to proceed only if the first ten were satisfactory. The production API, portal, scheduled GDELT job, and customer billing were not changed.

## Archive gates

- V1 and V2 cover the same contiguous 2,706 fifteen-minute intervals, from 22 October 2026 21:15 UTC through 20 November 2026 01:30 UTC. Every interval's derived V2 count was independently verified against V1.
- Fifty controlled subject lookups had zero V1/V2 mention-count mismatches. V2 point-lookup latency: p50 22 ms, p90 62 ms, p95 72 ms, p99 84 ms. These are lookup measurements, not end-to-end screening latency.

## First ten undated checks

The first run used the candidate harness's conservative 20-posting cap. All ten calls completed through the internal HTTP service and worker, delivered callbacks, and produced a matching JSON response and PDF. Eight returned `archive_review_posting_budget` before reviewing any archived article; eight profiles were Unsafe and two Inconclusive. The Unsafe labels are **unadjudicated model outputs**, not independently confirmed risk decisions. Reserved provider cost totaled USD 0.748. End-to-end p50 was 22.486 s, p90 26.966 s, and p95 27.882 s. The first two subjects had no indexed GDELT postings; the remaining eight had 25–311 postings each, nearly all unique article URLs. Simple URL deduplication would not clear the budget limit.

The original callback receiver had expired and returned HTTP 404. Its first attempt finalized a screening and PDF but could not deliver the callback. A fresh controlled receiver was POST-tested with HTTP 200 before the ten-case rerun. The failed attempt is excluded from the ten-case latency and cost figures above.

## Runtime-default posting cap trial

The QA harness was then made explicitly configurable up to the runtime default of 200 postings. Its USD 0.14 per-screening provider ceiling remained unchanged. The candidate image was `sha256:c96f56d5604ae8e0341243a4654b178e70773fab4946310d1b6c5b571f498dc5`, built from source commit `c00fee6`.

The first two subjects again completed. The third had 196 postings and 195 unique URLs. Archive review scanned all 196 postings but ended with 184 unresolved articles after 23 Event Registry extraction calls and 14 Gemini calls. It reserved USD 0.13906. Brave calls were **zero**: archive review exhausted the shared cost ceiling before current-news, open-web, and Search+ searches. Coverage was incomplete, although the callback and PDF were delivered. This attempt took 406.498 s. The batch stopped at that subject. A QA-only pagination defect also labeled the artifact check `incomplete` after reading just the first 100 evidence items; the harness now pages all evidence. This does not change the underlying incomplete source coverage.

## Other findings and next gate

- Some Unsafe results need a subject-role audit against article text. In the retained response, a third-party football investigation and a legal representation story were labeled as direct adverse conduct of the screened business. Treat these classifications as unvalidated until reviewed.
- Reserve enough cost for the mandatory Brave and Gemini source checks before article extraction, or skip unaffordable archive review up front and state the resulting Inconclusive limitation. A shared ceiling that can be consumed by optional article review cannot produce complete source coverage reliably.
- A 200-posting cap does not guarantee a Safe decision at the current price ceiling. Demonstrate that representative high-volume subjects can clear all relevant article evidence within a priced budget, or define a separate paid deep-review product with an explicit time and cost allowance.
- Rerun the first ten on the corrected candidate and review article roles, source coverage, callback, PDF, cost, and latency. Only then run the additional ten. The in-process QA queue does not prove Azure Queue durability; that remains a separate release gate.

The full response JSON, ten PDFs, and the three-case production-cap trial are retained in a private local QA folder, outside the repository. The candidate app has no public ingress and was deactivated after artifact export.
