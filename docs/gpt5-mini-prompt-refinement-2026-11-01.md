# GPT-5 mini EDD and research prompt refinement — 1 November 2026

## Decision

**Do not switch Gemini yet.** More specific GPT instructions improved some synthetic outputs, but did not reliably keep legal stages tied to the screened subject or keep separate source events separate. A candidate deterministic guard can neutralize legal stages on non-direct results and flag inconsistent bucket/role pairs for review. It is not connected to the production application.

## Scope and authority

Work started from `codex/azure-openai-setup` at `20bec366a4a4de37371604d6db4204ad6dde1f7b`. The live test used the existing `ai7uae-gpt-5-mini` Global Standard deployment through the managed identity of API revision `ca-ai7uae-api--0000092` in UAE North. Only fictional evidence from the [original case](../test/fixtures/gpt5-mini-synthetic-case.json) and a new [holdout case](../test/fixtures/gpt5-mini-adverse-holdout.json) was sent. No customer data, Gemini call, source search, customer API call, Azure configuration change, or production routing change occurred. The temporary replay files in the API container were removed after testing.

The [refined workflow instructions](../lib/ai7uae-gpt-guidelines.mjs) now specify exact-party attribution, neutral legal stages for actions against other parties, role rules for routine news and unsupported claims, source-level conflict handling, and exclusion of the subject's own name from new aliases. The [candidate GPT guard](../lib/ai7uae-gpt-adverse-guard.mjs) changes a non-direct or non-adverse result's legal stage to `media_mention` and records a review reason. It also flags `adverse_media` with a non-direct role and ordinary news with `direct_actor`. It does **not** decide whether an adverse allegation is true or infer a corrected role.

## Adverse-media classification replay

Scores are exact matches against test judgments in the fixtures. All calls returned the required number of items. `B/R/S` means media bucket / subject role / subject legal stage. The current production Gemini classifier prompt was supplied to GPT as the baseline; these are **not Gemini output scores**.

The new case was initially held out from the first prompt design, then inspected while refining later prompts. It is therefore no longer a blind validation set for the final candidate.

| Prompt and effort | Original seven | Holdout nine | Observation |
| --- | --- | --- | --- |
| Existing production classifier prompt, minimal | 7/7 B, 6/7 R, 5/7 S | 9/9 B, 7/9 R, 6/9 S | Director and namesake legal actions were assigned to the screened company. |
| First concise subject-attribution prompt, minimal | 7/7 B, 4/7 R, 7/7 S | 8/9 B, 7/9 R, 9/9 S | Stages improved, but role and one bucket score regressed. |
| Revised role prompt, minimal | 6/7 B, 5/7 R, 6/7 S | 9/9 B, 9/9 R, 7/9 S | Legal-stage errors returned on both cases. |
| Revised role prompt, medium reasoning | 7/7 B, 7/7 R, 7/7 S | 9/9 B, 7/9 R, 6/9 S | One perfect original-case call did not generalize to the holdout. |
| Revised role prompt, minimal, repeated holdout | — | 9/9 B, 8/9 R, 8/9 raw S; 9/9 guarded S | Guard neutralized the director charge and flagged it. The later guard revision also flags the ordinary-news `direct_actor` inconsistency. |

The medium-effort original call took 16.0 seconds and reported 2,495 output tokens; its holdout call took 19.4 seconds and 3,023 output tokens. The corresponding minimal-effort calls took 7.5–8.9 seconds and reported 928–1,207 output tokens. Output-token accounting can include internal reasoning tokens; the larger total is not evidence of better quality. One-at-a-time classification did not solve the core issue: the isolated director-charge item still returned `charged` as the company's legal stage. The isolated namesake item was correct.

The guard is a safety gate, not an accuracy score for the model. It handles the explicit invariant that a non-direct or non-adverse item cannot carry the screened subject's legal stage. It cannot verify whether a `direct_actor` designation is truly supported, and the existing [`resolveLegalStage`](../lib/adverse-media.mjs) still prioritizes a charged headline. A future GPT adapter must apply its validated result after that legacy headline rule or change the rule in a separately reviewed migration. Neither integration exists yet.

## Research, association, and narrative

The first expanded source-reconciliation instruction returned `incomplete` after 52.3 seconds at the 8,192-output-token cap. A shorter instruction and 3,072-token cap completed in 2.3–3.1 seconds with 232–303 output tokens and cited R1, R3, and R7. It correctly separated the company's penalty from the director's and brokers' penalties and required human review. **It repeatedly asserted that R1 and R7 were conflicting accounts of the same enforcement matter**, although the supplied excerpts do not establish a shared notice or event. The response also acknowledged that the linkage was unknown. The instruction explicitly told the model not to merge separate notices, so prompt text alone did not resolve this source-linkage error. A structured event identifier or deterministic conflict validator is needed before automated research summaries can rely on that conclusion.

The refined association instruction returned only the explicitly founded organization, without repeating the screened person's own name as an alias. The audit narrative separated the company penalty, director penalty, and routine layoffs, and noted incomplete coverage and human review. These are single-case observations. The injected article was blocked by Azure `content_filter` in the refined research runs; one wording cannot establish general injection resistance.

## Cost, privacy, and next gate

The original and holdout fixtures are fictional. Azure response token counts and elapsed times above are request telemetry, not an invoice or a validated Global Standard price. The failed 8,192-token research output is a concrete reason to cap outputs and monitor incomplete responses. Global Standard may process prompts and responses outside the UAE; no customer data was sent in this exercise.

Keep the refined association and audit instructions as candidates. For classification, require a GPT-specific adapter with the guard, strict schema validation, source attribution checks, and manual review when bucket and role disagree. For research, provide explicit event references where available and validate claims that connect multiple sources; treat unverified linkages as unknown. Then compare both providers on the **same** redacted or synthetic evidence across a larger blinded corpus, including genuine document scans through the approved privacy path. Do not enable automated clearance or replace Gemini on these runs.

Local verification: `node --test test/ai7uae-gpt-guidelines.test.mjs test/ai7uae-gpt-adverse-guard.test.mjs` (7 passed); both replay runners with `--dry-run`; `node --test test/adverse-media-association.test.mjs` (1 passed after `npm ci` installed locked dependencies); `git diff --check`. The live calls used the [main replay runner](../scripts/evaluate-gpt5-mini-synthetic.mjs) and [adjacent-task runner](../scripts/evaluate-gpt5-mini-synthetic-adjacent.mjs) from the container's temporary directory. [Microsoft's Responses reference](https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/responses) documents reasoning effort and output usage; the [structured-output guide](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/structured-outputs) documents the JSON schema response format used here.
