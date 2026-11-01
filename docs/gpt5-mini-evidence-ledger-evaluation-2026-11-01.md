# GPT-5 mini source-fact and research-ledger evaluation — 1 November 2026

## Decision

The revised design **passes the current synthetic pre-integration gate**, but **does not authorize replacing Gemini**. A direct classifier repeatedly transferred legal stages between parties. The new candidate asks GPT for source facts and verbatim evidence quotes, then derives the screened subject's bucket, role, and legal stage in code. A separate research ledger records one observation per source and links records only through event references verified by the application. Both candidates are unconnected to the live application.

## Scope and method

Work started on `codex/azure-openai-setup` at `88b613361389b4ce3457c3f0f9b4d5186864b4f5`. Live calls used the existing `ai7uae-gpt-5-mini` Global Standard deployment via the managed identity of UAE North API revision `ca-ai7uae-api--0000092`. The active Azure subscription was checked before testing. No resource or configuration was changed. No Gemini route, production API, customer data, real document, search provider, or real source was used. Temporary evaluation files were removed from the container after testing.

The [party-fact instructions](../lib/ai7uae-gpt-guidelines.mjs) require one to three facts per result ID, with an acted-against party, relationship to the screened subject, event kind, reported stage, and a short verbatim quote. The [adjudicator](../lib/ai7uae-gpt-party-facts.mjs) checks source IDs, quotes, party names, stage cues for direct subject actions, and known contradictions. It keeps a namesake, director, broker, or victim's legal stage off the screened subject. An item with no supported fact is withheld for review. The [runner](../scripts/evaluate-gpt5-mini-party-facts.mjs) permits **one bounded low-reasoning retry** of at most three withheld items, then stops.

The [research-ledger instructions](../lib/ai7uae-gpt-guidelines.mjs) request one independent observation per source, rather than a free-form cross-source conflict narrative. The [ledger validator](../lib/ai7uae-gpt-source-ledger.mjs) verifies IDs and quotes, flags inconsistent action kinds and headlines, and links records only by the caller's `verifiedEventRefs` map. Model output cannot supply an event link. A correction is recorded as a review reason; a corrected label is not evidence that the model itself was right.

## Measured adverse-media results

The five entirely fictional cases contain 43 items: [original company](../test/fixtures/gpt5-mini-synthetic-case.json), [second company](../test/fixtures/gpt5-mini-adverse-holdout.json), [individual](../test/fixtures/gpt5-mini-party-facts-individual.json), [later company](../test/fixtures/gpt5-mini-party-facts-fresh-holdout.json), and [Arabic company](../test/fixtures/gpt5-mini-party-facts-arabic.json). Expected buckets, roles, and screened-subject stages are test judgments.

| Replay | Exact bucket, role, and stage | Calls | Input / output tokens | Sequential time |
| --- | ---: | ---: | ---: | ---: |
| Earlier four-case combined run | 36/36 | 7 | 10,769 / 4,542 | 36.6 s |
| Arabic case after quote-validator refinement | 7/7 | 2 | 2,942 / 1,243 | 9.9 s |
| Final five-case combined repeat | **43/43** | **8** | **12,416 / 4,985** | **45.3 s** |

The final repeat needed low-reasoning retries for the second company, the mixed personal-allegation case, and the Arabic broker item. Other items were resolved on the first call. Review flags remained on normalized broker context, one mixed allegation's extra unsupported quote, and an uncertain other-party source stage. The final classifications had no withheld items, but those flagged items **still require a human review path**. In an earlier fresh company run, the victim item was withheld and its retry hit a 2,048-output-token cap; a source-backed victim rule later resolved it without assigning the victim an adverse legal stage. The Arabic case initially withheld a namesake's incorrectly stated source stage; the current rule keeps that unrelated stage off the screened company and flags it.

The individual and two later company fixtures were initially set aside from the first prompt. Their failures were then inspected during refinement. The final 43/43 score is therefore **not a blind accuracy estimate**. It shows the candidate pipeline handles these synthetic patterns with a bounded review-and-retry path; it does not prove population performance.

The five-case replay uses `node scripts/evaluate-gpt5-mini-party-facts.mjs --bounded-retry test/fixtures/gpt5-mini-synthetic-case.json test/fixtures/gpt5-mini-adverse-holdout.json test/fixtures/gpt5-mini-party-facts-individual.json test/fixtures/gpt5-mini-party-facts-fresh-holdout.json test/fixtures/gpt5-mini-party-facts-arabic.json` in the authorized API container. Token counts and scores may vary on a new run.

## Measured research results

The [separate-notices case](../test/fixtures/gpt5-mini-research-ledger.json) has five observations and one verified broker-event pair. The [later research case](../test/fixtures/gpt5-mini-research-fresh-holdout.json) has six observations and one verified director-event pair. In the final runs, the first scored **5/5** in 2.75 seconds (1,231 input and 274 output tokens); the second scored **6/6** in 3.01 seconds (1,267 input and 318 output tokens), with one namesake-headline correction flagged for review. Both ledgers linked only their verified pairs and kept the separate company enforcement notice apart.

Before the ledger design, free-form research repeatedly asserted that two notices described the same enforcement matter without evidence of a common event. The new schema cannot express that unsupported cross-event conclusion. It does not verify source authenticity or find missing records; it only structures the supplied excerpts. The action-kind and headline checks are deliberately narrow. They can route uncertain items to review, and are not a general fact checker.

The research replays use `node scripts/evaluate-gpt5-mini-research-ledger.mjs test/fixtures/gpt5-mini-research-ledger.json` and the same command with `test/fixtures/gpt5-mini-research-fresh-holdout.json`.

## Remaining release gates

1. Build a GPT adapter that supplies these instructions on **every** request, validates the full existing adverse-media contract (including categories, confidence, and summaries), and applies subject-stage guards after the legacy headline-stage rule. The current candidate modules are not wired into that pipeline.
2. Compare GPT and Gemini on **identical authorized evidence**, with source retrieval held constant, a larger blinded corpus, Arabic-language expert review, repeatability checks, and a predeclared false-attribution and missed-adverse threshold. Synthetic labels here are too few to support a production error rate.
3. Exercise the authenticated API, queue, report rendering, tenant and case authorization, billing, fallback/review handling, and privacy path. Global Standard may process prompts and responses outside the UAE; only fictional data was sent here.
4. Keep consequential decisions with an authorized human reviewer. A retry that fails, times out, exhausts tokens, or returns an unsupported quote must remain review-required rather than becoming a clearance.

Local checks: `node --test` for the GPT guideline, adverse guard, party-fact, and source-ledger tests; dry runs of both new replay scripts; and `git diff --check`. No live configuration mutation or deployment was performed. Azure response tokens and elapsed times are request telemetry, not an invoice or verified dollar cost. Arabic legal cue matching is a limited lexical check, informed by [UAE Capital Market Authority legislation](https://legislation.uaecma.gov.ae/ar/%D8%A7%D9%84%D9%85%D8%A7%D8%AF%D8%A9-75-%D8%A7%D9%84%D8%AA%D8%B5%D8%A7%D9%84%D8%AD-%D9%81%D9%8A-%D8%A7%D9%84%D8%AC%D8%B1%D8%A7%D8%A6%D9%85-%D9%88%D8%A7%D9%84%D9%85%D8%AE%D8%A7%D9%84%D9%81%D8%A7%D8%AA) and [UAE legislation](https://www.uaelegislation.gov.ae/ar/legislations/1609); it is not a legal-stage determination outside the supplied evidence.
