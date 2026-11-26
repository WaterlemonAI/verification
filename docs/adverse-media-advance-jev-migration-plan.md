# Adverse Media Advance: Jev classification migration map

Status: proposed full-pipeline design, revised 25 November 2026 from the supplied flow diagram. The [implemented API-only Jev contract](adverse-media-jev-screening-api.md) supersedes this draft's Jev labels and redundant-article handling. The API uses adverseness `adverse | non-adverse | inconclusive` and relationship `direct | indirect | inconclusive`; unrelated articles are tagged `redundant` and removed from its screened register. Full-pipeline migration remains future work. Scope is the gated **Adverse Media Advance** route on draft PR #157. “Jev” means TypeSafe AI's hosted System One model. Standard Adverse Media and Search+ retain their current behavior. Advance remains HOLD.

## Target boundary

```
API name + aliases + policy selection + mandatory geography
  -> Gemini country-language transliteration and search terms
  -> Brave general/publisher searches + paged GDELT/V2 archive search
  -> subject-name title/URL gate -> merged event register
  -> adverse-mention selector -> selected articles + exclusion ledger
  -> article extraction -> Jev bucket and relationship per article
  -> Jev same-incident review -> local incident IDs and article markers
  -> local evidence/identity/policy checks -> finalized decision JSON (held)
  -> Gemini summary from that JSON -> fixed-template PDF renderer
  -> release final JSON + PDF; on report failure release JSON + report error
```

The two Gemini calls have separate purposes. The **planning call** receives the request's name, aliases, countries, languages and selected policies; it produces bounded name variants and source-query terms before discovery. The **report call** receives the finalized, bounded decision JSON and writes only the PDF summary. Jev supplies an explicit media bucket and subject relationship for each selected article. Local gates verify those proposals, apply the policy/profile rules and prevent a weak or contradictory model answer from becoming a cleared finding. The PDF is rendered by the fixed template in code; Gemini supplies its summary text, not PDF bytes. The decision JSON is stored but withheld until PDF finalization succeeds or fails.

“All GDELT articles” means all matching postings returned from the pinned, paged V2 archive/source query, with counts reconciled against that snapshot. It does not mean every article on the internet. Interpret the diagram's name-in-title/URL filter as **name or approved alias/transliteration in title or URL path**, retaining which field matched. Requiring the name in both fields would discard ordinary relevant articles. A title/URL signal selects a candidate; the full register retains every returned posting and its selection or exclusion reason. Only selected adverse-mention candidates proceed to Jev.

The current V2 archive lookup uses names, aliases and transliterations to fetch all matching stored postings; Gemini's adverse search phrases currently feed Brave news/web/publisher queries. To meet the diagram literally, add Gemini-generated GDELT event phrases only as **additive** GDELT searches if that source/API is available and approved. Merge their results into the same register. Never make event-term queries a prerequisite for the exhaustive V2 name/alias scan, because that would omit articles whose title or URL lacks one of the planned event phrases.

## Current call sites and exact change

| Stage | Current source | Change for Advance |
| --- | --- | --- |
| Input and search planning | `lib/adverse-media-advance-request.mjs` requires `countries` (empty array means global). `lib/deep-research-queue.mjs` calls Gemini through `createAdvanceQueryPlan()` in `lib/adverse-media-advance-plan.mjs`. | **Keep Gemini here.** Make country-to-language choice, transliteration and query terms explicit and versioned; validate output as same-subject variants and bounded terms. Preserve caller aliases and the global `[]` option. A failed planner marks affected language/source coverage incomplete; it cannot yield Safe. |
| Brave and GDELT discovery | `lib/adverse-media.mjs` uses planned event terms in Brave searches; `lib/gdelt-archive-review.mjs` pages V2 postings by name/alias/transliteration. | Keep exhaustive V2 name lookup. Apply the validated plan to Brave general/publisher searches; add GDELT event-term queries only as a separately counted, additive source if supported. Page and reconcile every returned branch and retain failures. Record which name or variant matched title or URL path. |
| Initial Search+ classification | The Advance branch in `lib/deep-research-queue.mjs` already supplies a `not_needed` classifier for the initial `screenAdverseMedia()` pass. | Keep this bypass. Do not route Advance through `createGeminiAdverseClassifier()` or the shared `classifyWithAi()` path. Leave legacy and Search+ callers alone. |
| Archive scan and event register | `server.mjs` constructs a Gemini archive reviewer, but Advance passes `deferSelected: true` to `processArchiveReviewPage()`. `normalizeAdvanceEvidence()` merges Brave and archive metadata. | Keep deferred archive decisions and avoid constructing a Gemini reviewer for Advance. Store all returned metadata decisions, canonical URL overlaps, matched name/field, matched adverse terms, selected candidates and exclusions. Send only the selected adverse-mention set onward. |
| Article review | `assessAdvanceScreening()` in `lib/adverse-media-advance-classifier.mjs` extracts selected articles, then calls `tagBatchIsolatingBlockedInput()` and Gemini's batch schema. | Replace Gemini tagging with **one Jev review per selected canonical article**, checkpointed by input/model version. Jev returns bucket and relationship plus separate role, adverseness and event judgments. Keep extraction, all-candidate accounting, early stop, budget pause and the 20-entry PDF cap. |
| Policy evaluation | `buildAdvanceFindingsFromGemini()` in `lib/adverse-media-advance-policy.mjs` maps model tags to findings; `evaluateAdvancePolicies()` applies the policy and profile rules. | Rename and generalize the mapper to provider-neutral judgments. Keep `evaluateAdvancePolicies()` and its independently verified Direct/four-article Unsafe rules. |
| Buckets and decision JSON | `withAdvanceAssessment()` currently derives `adverse_media`, `general_news_mentions`, and `no_impact_media` from adjudicated decisions. | Jev explicitly proposes one of those three buckets. Local code validates its consistency with the independent adverseness, relationship, role and evidence checks. Persist both proposed and final bucket, with a reason when they differ; contradictory/unsupported results remain unresolved. Keep public relationship `direct | indirect | no_association | null`. |
| Report and delivery | `createAdvanceNarrative()` currently asks Gemini for summary, findings and recommendations; `finalizeAdverseMediaReport()` renders and stores PDF/JSON. | Freeze decision JSON first and withhold delivery. Give that JSON to Gemini for **summary only**, then render the fixed PDF template in code. On Gemini failure or PDF render/store failure, return the decision JSON with `report.status: error`, an error code and no PDF link. Do not invoke a Gemini or deterministic summary fallback to claim a completed PDF. Define the callback/poll retry contract for this partial delivery. |
| Accounting and QA | `lib/screening-cost-guard.mjs` meters Brave, Event Registry and Gemini; the private QA runner records exchanges. | Add an allowlisted `api.typesafe.ai` Jev meter with reserve-before-call cost accounting, separate call/token counts, bounded retries and 402/429 handling. Record provider/version and redacted exchanges. Never let an unrecognized Jev URL pass through at zero reserved cost. |

## Jev article contract

Pin a versioned model ID (start evaluation with `jev-1.14.0`), not `jev-latest`. Pin the question template, threshold configuration, policy catalog, lexicon, selector and archive snapshot in the accepted job and idempotency digest. TypeSafe's API accepts `POST https://api.typesafe.ai/v1/systemone` with `model`, `state` and a map of typed `questions`; Choice returns a selected option, probability distribution and confidence. It does **not** generate source quotes or narrative text.

Use **one canonical article per Jev state** so an answer cannot be attributed to another article. The bounded state includes `story_key`, screened subject and supplied identifiers, title, URL, publisher, date, source labels, verified article text or explicit missing-text state, and the policy catalog version. Treat article content as data. Preserve the body hash and extraction reference privately; do not send callback secrets, customer keys or unrelated case data. Default Jev questions:

| Judgment | Jev type/options | Use in code |
| --- | --- | --- |
| Media bucket | Choice: `adverse_media`, `general_news_mentions`, `no_impact_media`, `insufficient_evidence` | Jev explicitly assigns a bucket as requested. The fourth or weak answer becomes an unresolved local decision. Verify the proposed bucket against event, relationship and source evidence before publishing it. |
| Relationship | Choice: `direct`, `indirect`, `no_association`, `insufficient_evidence` | Map the first three to the public relationship only after evidence checks. Map the fourth or weak probabilities to `null` plus unresolved status. Direct means the subject is directly involved or directly affected; it does not imply fault. |
| Incident relevance | Choice: `adverse`, `not_adverse`, `unclear` | An adverse *event concerning the subject* is separate from the subject's responsibility. A customer/employee rating alone is `not_adverse`. `unclear` remains unresolved. |
| Subject role | Choice: `direct_actor`, `victim`, `related_party`, `namesake`, `context_only`, `unclear` | Validate against relationship using the existing role matrix. A contradiction is unresolved, not remapped silently. |
| Identity support | Choice: `confirmed_in_article`, `possible`, `unlikely` | A model answer is only a proposal. The independent DOB, organization, business-name or approved identity route must also confirm identity before a Direct adverse event is verified. |
| Legal stage and severity | Choice from the existing stage and severity enums | Used only for a supported adverse event; otherwise omit from a confirmed finding. |
| Event policy IDs | One Noul per selected policy ID, or a bounded second Jev call with the same immutable state and all selected IDs | Multi-label policy tagging cannot be represented by one Choice. Preserve the 64-policy catalog and require supported evidence for each positive ID. Do not narrow the questions to lexicon matches alone. |
| Supporting span | Choice among deterministic IDs for exact sentence/window spans from the verified body, with `none_supported` | Code resolves the ID to an exact substring and stores offsets, text hash and quote. Jev never fabricates a quote. If the relevant span is outside the bounded candidate list, retry with another window or mark unresolved. |

An illustrative first Jev request for **one** article is:

```json
{
  "model": "jev-1.14.0",
  "state": {
    "story_key": "s-example",
    "subject": { "name": "Example Company", "entity_type": "business" },
    "article": { "title": "Example Company reports a data breach", "verified_body": "..." }
  },
  "questions": {
    "media_bucket": {
      "type": "choice",
      "instructions": "Which media bucket best describes this article for the screened subject?",
      "criteria": {
        "adverse_media": "A supported adverse incident concerns the subject directly or indirectly, including as an affected party.",
        "general_news_mentions": "The subject appears in ordinary news, or the evidence is too uncertain for clearance.",
        "no_impact_media": "The subject is only incidentally mentioned or the incident is unrelated to the subject.",
        "insufficient_evidence": "The available article text cannot support a bucket decision."
      }
    },
    "relationship": {
      "type": "choice",
      "instructions": "How does the reported article concern the screened subject? Direct involvement includes being the affected party and does not imply fault.",
      "criteria": {
        "direct": "The subject is directly involved or directly affected.",
        "indirect": "The connection is through a related person or entity, former affiliation, or possible namesake.",
        "no_association": "The subject is only incidental to the reported event.",
        "insufficient_evidence": "The article does not support a reliable relationship decision."
      }
    },
    "incident": {
      "type": "choice",
      "instructions": "Does the article document an adverse incident concerning this subject?",
      "criteria": {
        "adverse": "A specific adverse incident directly or indirectly concerns the subject, including as an affected party.",
        "not_adverse": "No supported adverse incident concerns the subject; a negative rating alone is not enough.",
        "unclear": "The article text cannot support either conclusion."
      }
    }
  }
}
```

The adapter reads `answers.media_bucket.choice`, `answers.relationship.choice`, their probability distributions and `answers.incident.choice`; it never treats a selected option as verified evidence by itself. The production template adds the other questions above and is versioned as one contract.

The Jev adapter must validate the response model ID, every required answer, option key, probability range/distribution and article/checkpoint binding. A transport failure, malformed answer, 402, exhausted 429 retry, missing body, unsupported span, low-confidence answer or conflicting judgments yields an explicit unresolved candidate. There is no Gemini fallback for classification. Preserve successful Jev answers across queue retries; claims and results are keyed by owner, screening, canonical URL, article body hash, model ID, question-template version, policy hash and budget revision. Never pay twice for a saved successful result.

**Thresholds:** define separate, versioned cutoffs for accepting an adverse relationship, a non-adverse clearance and each policy tag. Begin shadow evaluation with conservative trial values (for example, 0.90 top-option probability and 0.20 top-to-runner-up margin for relationship; 0.95 for non-adverse clearance). These numbers are *not* release thresholds. Fix them from labeled holdout performance before any customer use. The independent evidence and identity gates remain mandatory regardless of Jev probability. Do not convert Jev's `confidence` into a factual verification claim.

### Jev output reconciliation

| Jev proposal plus verified article state | Public relationship | Final bucket | Profile effect |
| --- | --- | --- | --- |
| Supported adverse event, Direct, independently confirmed identity and exact source span | `direct` | `adverse_media` | Unsafe after one distinct article, including a victim without a culpability claim. |
| Supported adverse event, Indirect, exact span and identity appropriate to the relationship | `indirect` | `adverse_media` | Count toward the four-distinct-article Unsafe rule; one to three Indirect articles alone do not satisfy it. |
| Verified benign article directly about the subject | `direct` | `general_news_mentions` | Does not establish Unsafe. |
| Verified incidental/unrelated mention | `no_association` | `no_impact_media` | May be cleared only with sufficient article evidence; a search snippet alone cannot clear it. |
| Missing body, uncertain identity, weak Jev answer, unsupported span, provider error or contradictory labels | `null` unless a relationship independently clears its own gate | `general_news_mentions` as an explicitly unresolved display placement; never count it as cleared general news | Cannot establish Safe; counts as unresolved. |

Jev's proposed bucket must match the supported article state in this table. For example, `adverse_media + no_association`, or `no_impact_media + verified Direct adverse`, is a conflict requiring unresolved review. The existing three buckets are display groupings; the register retains `jev_bucket`, `final_bucket`, `adverse_assessment`, relationship, role, `review_status`, reason code, policy tags, exact source span, model/question versions and probabilities separately. A bucket alone never drives `evaluateAdvancePolicies()`.

Keep the existing public `ai7_edd_review_status` and `ai7_edd_assessment` names as product-level contract fields for this migration; they describe AI7 EDD review, not the vendor. Update their OpenAPI descriptions and include the existing `blocked` review status in its enum. Record `classification_provider`, Jev model ID and question version in the private register and QA provenance. Any public field rename needs a separate API version and client migration.

## Hold JSON, then create the PDF

1. Complete Jev article review and local policy evaluation. Reconcile returned Brave results, archive postings, metadata exclusions, selected/reviewed/pending counts and early-stop counts. Rank and select at most 20 report entries **after** all required adjudication or an authorized four-article/verified-Direct budget stop.
2. Persist an immutable `advance_decision_v8` JSON snapshot **without returning it yet**. It contains the profile and reason, coverage, policy results, final bucket counts, Jev's proposed labels and final article decisions, selected evidence IDs with verified facts/spans, unresolved and omitted counts, Jev model/template versions and a paged evidence-export reference. Compute and store its SHA-256. Keep the full register in owner-scoped pages. Gemini and the renderer cannot mutate this snapshot.
3. Build Gemini's report input solely from a bounded projection of that finalized JSON. Provide selected verified facts and exact quotes with stable evidence IDs; describe unresolved leads only as pending. Ask Gemini for **one executive-summary string** under a strict schema, checkpointed against the decision hash. Key findings and next steps come from decision JSON templates, not Gemini.
4. Validate the summary against the JSON's selected IDs, profile and counts; reject unsupported event, identity or culpability claims and provider/account details. If Gemini fails, returns invalid text or exceeds its budget, set `report.status: error` with a stable `REPORT_SUMMARY_FAILED` code. Keep the finalized decision JSON. Do not produce a success PDF from placeholder prose.
5. If the summary succeeds, render the fixed PDF template in code and persist it. If rendering or storage fails, set `report.status: error` with `REPORT_RENDER_FAILED` or `REPORT_STORAGE_FAILED`; retain the decision JSON and omit a PDF URL. A retry may resume report creation from the stored JSON and saved summary without rerunning Jev. Only after report success does the final result contain a PDF link and hash.
6. Define poll and signed-callback states explicitly: `completed` with JSON + PDF, or `report_error` with JSON + `report` error object and no PDF. Deliver exactly one terminal outcome per report revision; owner-scoped retrieval and case capture use the same decision hash. Budget-blocked article review stays a separate nonterminal state unless an independently verified Unsafe early-stop rule permits finalization. Keep any callback retry idempotent.

## File-level implementation sequence

1. **Contracts and versioning:** update `lib/adverse-media-advance-request.mjs`, `lib/adverse-media-advance-policy.mjs`, `api/openapi.json`; add a provider-neutral `lib/adverse-media-advance-judgments.mjs` and Jev adapter `lib/adverse-media-advance-jev.mjs`. Define the private Jev result, public register fields, `advance_decision_v8`, immutable checkpoint keys and compatibility for V7 jobs. Do not reinterpret old V6/V7 artifacts as Jev results.
2. **Keep and harden Gemini search planning:** update `lib/adverse-media-advance-plan.mjs`, `lib/deep-research-queue.mjs` and `lib/adverse-media.mjs` to implement the diagram's country-language transliteration, GDELT/Brave query terms and clear coverage on planner failure. Pin the plan version and checkpoint its result. Keep legacy and Search+ paths separate.
3. **Article judgments:** replace `tagBatchIsolatingBlockedInput()` and Gemini tag conversion in `lib/adverse-media-advance-classifier.mjs`. Jev must propose media bucket **and** relationship per canonical article, with distinct adverseness, role and policy answers. Keep extraction, candidate register, one-batch-per-lease behavior, early-stop and budget-pause logic. Generalize `buildAdvanceFindingsFromGemini()` in `lib/adverse-media-advance-policy.mjs` to consume validated Jev judgments plus exact spans. Update `lib/adverse-media-advance-evidence.mjs` to carry matched-name/field, bucket proposal, final bucket and span provenance.
4. **Cost, credentials and observability:** add a separately named Jev secret in the existing private store/Key Vault; update `lib/screening-cost-guard.mjs`, `lib/adverse-media-report-store.mjs`, `server.mjs` and the QA runner. Use a hostname/path allowlist, provider-specific call/token counters, conservative pre-call reservation, retries with `Retry-After`, and durable budget status. Reserve PDF-summary Gemini cost after Jev work. Never log credentials or raw article bodies in ordinary logs.
5. **Finalize or report error:** update `lib/adverse-media-advance-narrative.mjs`, `lib/adverse-media-report-pdf.mjs`, `lib/adverse-media-json-store.mjs`, report finalization in `server.mjs`, and `lib/deep-research-queue.mjs` for the frozen JSON and two terminal delivery outcomes. Keep Gemini only in the Advance search planner and PDF-summary stage.
6. **Tests and migration:** update `test/adverse-media-advance-classifier.test.mjs`, `test/adverse-media-advance-policy.test.mjs`, `test/adverse-media-advance-pipeline.test.mjs`, `test/adverse-media-advance-api.test.mjs`, `test/adverse-media-advance-request.test.mjs`, `test/adverse-media-advance-event-register.test.mjs`, `test/adverse-media-report.test.mjs` and cost-guard tests. Add Jev bucket/relationship conflicts, exact-span, planner-language, decision-snapshot replay, Gemini-summary failure and PDF-render/storage failure tests. Gate the new path behind an Advance-only classifier version/flag; V7 in-flight jobs retain their pinned implementation or are explicitly migrated by an operator.

## Verification and release gates

- **Provider preflight:** confirm TypeSafe contractual/data-processing approval for the actual screened data and configured region. TypeSafe currently says Jev processing occurs in the United States and standard retention has no published fixed period; verify zero-data-retention settings and permitted transfer before sending private article/subject data. Confirm credentials, account model access, rate limits, and actual price. No live Jev screening before this gate.
- **Labeled corpus:** build reviewed labels for Direct actor, Direct victim, Indirect employee/former affiliate, namesake, incidental ad, benign direct news, negative review, sanctions/fraud/cyber incidents, unsupported quote and missing body. Include Signzy, the seven-subject V6 traces, multilingual cases and independent holdouts. Compare Jev with the prior Gemini proposals on the same extracted bodies, while treating prior model output as a baseline rather than ground truth. Set thresholds against adverse recall, false Direct/Unsafe rate, Safe false-clearance rate and unresolved rate.
- **Failure and scale:** test >50 Brave candidates, >1,000 archive postings, all 64 policy IDs, large but bounded bodies, Jev 402/429/5xx/malformed answers, exact-span misses, Gemini planner and summary failures, PDF render/store failures, crash after provider response, budget revision, version upgrade and queue replay. Prove no zero-cost Jev calls and no repeated paid call after checkpoint. Measure p50/p90/p95/p99 and cost, including extraction, search planning and Gemini summary.
- **End to end:** run focused tests then `npm test`; run isolated digest-pinned live cases with retained private requests, redacted Jev exchanges, decisions, costs, successful JSON/PDF pairs, JSON + report-error outcomes and verified signed callbacks. Reconcile JSON/PDF/case/callback hashes and owner-scoped evidence paging. Complete the original 10 earlier + 10 independent cohort, V2 posting reconciliation, rollback drill and all prior release gates before customer enablement. Keep Advance HOLD if Jev improves classification cost but quote, identity, archive or coverage gates remain unresolved.

## External API and data notes

TypeSafe documents `POST /v1/systemone`, `Choice`/`Noul` question formats, versioned `jev-1.14.0`, default 64k request/32k question context, input-token pricing, and a moving `jev-latest` alias. Use the pinned model ID and normal context limit; do not enable experimental long-context behavior to force whole articles through. See [Introduction](https://docs.typesafe.ai/introduction), [Choice](https://docs.typesafe.ai/primitives/choice), [Noul](https://docs.typesafe.ai/primitives/noul), [Models](https://docs.typesafe.ai/models), and [data handling](https://help.typesafe.ai/articles/5974925716). Recheck the vendor's current contract and console settings at implementation time.
