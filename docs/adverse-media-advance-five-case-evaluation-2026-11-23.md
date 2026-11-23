# Advance five-case evaluation — 23 November 2026

This is an isolated live-provider evaluation of the first five subjects in the earlier seven-case global set: Salman Khan, Ai7lab, Signzy, eMudhra and Sonu Sood. It is not a customer release or an allegation that any subject committed misconduct. The customer Advance route remains off. The case inputs used English, all 64 policies, global search, 15 displayed results and no supplied identity identifiers. The baseline was source `f9ca5da42d94ea2cfb9a631a152bcf0e462a0529`; the corrected candidate was source `87b7ef6b4e66580a50e6e8b8d287d4402af6040a`, image `sha256:9e725342c1cecc998c8c3bbd7cb82839d1bc4919790a217b18a2fd749facb53c` (ACR run `dg6n`). Earlier source timing and provider results can differ, so counts are observational comparisons, not a fixed-content A/B test.

## Index and execution gates

The V1 archive had advanced to `2026-11-23T01:30:00Z` while V2 stopped at `20261122013000`. A digest-pinned V2-only image from source `54162f872ddda20c16207aeceb6e5cf6d18578b8`, `sha256:93066b52a491a87e2c06b03bb9ae178822c7e285a00aded804d30d3490fbad03` (ACR run `dg6m`), replayed the 96 missing stored intervals. The one-interval pilot execution `caj-ai7uae-gdelt-ingest-s9uamxl` and remaining-95 execution `caj-ai7uae-gdelt-ingest-e6egyi9` both succeeded. V2 now ends at `20261123013000` with 5,726 committed intervals and exactly covers V1. A controlled 50-subject parity run found zero V1/V2 count mismatches; V2 point-summary latency was p50 32 ms and p95 75 ms for that cohort.

The daily ingest and weekly backfill job templates now read back with the V2 digest and `GDELT_V2_DUAL_WRITE=true`. Their existing commands and schedules remain in place. This proves configuration, not the outcome of their next scheduled executions. The V2 and Advance source PRs remain draft; the operational configuration needs reconciliation with the reviewed release workflow before promotion.

## Five-case outcome

| Subject | Earlier baseline | Corrected live candidate | Candidate register and review | Provider reserve | Report/callback |
| --- | --- | --- | --- | ---: | --- |
| Salman Khan | Inconclusive; 2,546 archive postings, 200 scanned | **Budget blocked**, no final profile | 62 article-resolver calls and 7 Gemini calls; 26 candidates still pending when the per-screening provider ceiling stopped work | $0.249355 | No final PDF or callback |
| Ai7lab | Safe; zero register items | **Safe**; zero register items | Zero selected candidates; archive 0/0 | $0.055421 | 5-page PDF; signed callback verified |
| Signzy | Inconclusive; 19 register items | **Inconclusive**; 26 register items | 15 selected; 7 reviewed, 3 unresolved and 5 unassessed. Two verified Direct adverse incident articles | $0.107116 | 10 selected for 8-page PDF; signed callback verified |
| eMudhra | Inconclusive; 50 register items | **Inconclusive**; 65 register items | 24 selected; 19 reviewed, 1 unresolved and 4 unassessed. Three verified Direct adverse incident articles | $0.161751 | 8 selected for 8-page PDF; signed callback verified |
| Sonu Sood | Inconclusive; 113/113 archive postings scanned | **Inconclusive**; 154 register items, 113/113 archive postings scanned | 21 selected; 10 unresolved and 11 unassessed, with no verified final relationship | $0.130819 | 20 selected, one omitted; signed callback verified |

These are media classifications and evidence statuses, not legal findings or assertions of culpability. The verified Signzy incident is classified as a directly affected **victim**, not a perpetrator. The eMudhra items concern reported security incidents and business effects; the review does not infer criminal misconduct.

| Subject | Register items, baseline → V5 | Provider reserve, baseline → V5 | Duration, baseline → V5 | PDF pages, baseline → V5 |
| --- | ---: | ---: | ---: | ---: |
| Salman Khan | 240 → no final register | $0.241194 → $0.249355 | 111.7 s → 407.9 s | 21 → none |
| Ai7lab | 0 → 0 | $0.055421 → $0.055421 | 14.2 s → 14.8 s | 4 → 5 |
| Signzy | 19 → 26 | $0.086827 → $0.107116 | 26.0 s → 80.2 s | 11 → 8 |
| eMudhra | 50 → 65 | $0.135928 → $0.161751 | 39.6 s → 111.2 s | 21 → 8 |
| Sonu Sood | 142 → 154 | $0.236939 → $0.130819 | 104.5 s → 108.5 s | 18 → 13 |

The earlier run used a different review schema and a 200-posting Salman archive cap; V5 required a complete 2,546-posting snapshot before provider work. This explains much of the Salman time and cost difference. The V5 Sonu Sood PDF page count was read from the candidate's generated PDF; its large binary is being copied to the local evidence package separately.

The five corrected runs made 196 provider calls in aggregate and reserved $0.704462. The four completed runs used 10 Brave calls each, 2–5 Gemini calls each and 0–25 article-resolver calls; Salman used 10 Brave, 7 Gemini and 62 resolver calls before its guard stopped work. The corresponding end-to-end durations were Ai7lab 14.8 s, Signzy 80.2 s, eMudhra 111.2 s, Sonu Sood 108.5 s and Salman 407.9 s to the budget block. Reservations are guard accounting, not a billing statement.

## Causal contribution to classification failures

1. **V4 schema contradiction was the primary Signzy loss.** A private V4 pilot selected 15 of 26 Signzy URLs. Gemini proposed two adverse Direct victim incidents. The previously missed cybersecurity-scare article had a 230-character quote that was an exact contiguous span of the verified article body. The model schema and validator allowed only 180 characters, so the paid, grounded proposal was discarded. Ten other tags paired benign `context_only` with `direct`; three paired `unclear` with `no_association`; the rigid role-to-relationship mapping discarded those as well. Only one of 15 was reviewed. This is a server contract failure, not Gemini inventing a fourth relationship.
2. **The V5 correction recovered both Signzy security articles.** The quote limit is now 600 characters, still requires an exact source span, and the validator accepts `context_only`/`direct` for benign news directly about the subject while retaining `context_only`/`no_association` for an incidental advertisement. A generic headline can establish a short business name only when a verified body repeatedly names that business near the beginning and the exact adverse quote names it and the incident; an explicit conflicting upstream identity match still blocks that path. The saved V4 Signzy model exchange replayed locally as a confirmed Direct adverse victim finding. The fresh V5 provider run independently confirmed both articles and placed both in the PDF.
3. **Missing article bodies remain a source-evidence limit.** Signzy has five selected excerpt-only items, eMudhra four and Sonu Sood seven. Gemini received these candidates and produced proposals, but a search excerpt cannot certify an article-body quote. Those 16 candidates correctly remain unassessed; they cannot become Safe or confirmed adverse from excerpts alone.
4. **Independent subject identity is the dominant Sonu Sood limit.** Nine selected, verified-body Sonu Sood articles had structurally valid model tags and grounded quotes but failed the direct-identity gate. The input supplied only a name; the individual gate currently requires a date of birth or associated organization in the article. One further benign tag failed its non-adverse evidence check. This is an intentional false-positive safeguard that makes name-only individual runs non-decisive. It should be evaluated with controlled identity inputs and namesake cases before broadening.
5. **Remaining model-schema contradictions are visible.** Four verified-body Sonu Sood tags were internally inconsistent (`context_only` with `indirect`, or `unclear` with `no_association`, including one adverse `context_only` tag) and were discarded. Two Signzy excerpt-only tags also had incompatible namesake/no-association pairs. V5 prevents these from becoming unsupported final relationships, but the register currently groups schema rejection under `article_evidence_unverified`, obscuring which part failed.
6. **The cost ceiling blocks complete review for broad individual subjects.** Salman Khan exhausted the approved $0.25 provider reserve before classification finished, with 26 candidates pending. The job did not emit a final Safe result, PDF or callback. Completing this input requires either a separately approved provider budget or a narrower candidate policy that passes recall tests; dropping pending articles or silently raising the ceiling would invalidate the completeness gate.

`unassessed` is a **review status**, not a fourth Subject Relationship value. A successfully verified candidate has only `direct`, `indirect` or `no_association`; an unsupported or incomplete candidate has a null public relationship and an explicit unresolved reason. This matches the event-register contract and avoids presenting a model guess as a source-backed finding.

## Remaining release decisions

- Keep customer Advance disabled. Four of five cases produced verified callbacks, but Salman is budget blocked and Sonu Sood has no verified selected relationship.
- Add per-candidate diagnostics for model schema mismatch, quote anchoring, article extraction failure and independent identity reason. Current `article_evidence_unverified` combines distinct causes.
- Run controlled individual identity and namesake cases, a bounded missing-body resolver check, the required 10 + 10 release cohort, real durable queue/callback transport, and the next scheduled V2 job readback before considering promotion.
- Keep the $0.25 Advance provider ceiling until the owner approves a reviewed cost or candidate-policy change. The V2 repair and QA did not enable customer access, change RBAC, or alter that ceiling.

The local untracked evidence package is under `output/adverse-advance-qa-2026-11-23/five-global-v5/`: `comparison.json`, the parity result, per-case response/register/provider exchanges/cost/PDF where available. The V4 Signzy diagnostic is under sibling `five-global-v4/`. These files contain provider and case data and are intentionally excluded from the PR.
