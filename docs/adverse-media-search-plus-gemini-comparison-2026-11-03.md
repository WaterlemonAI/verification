# Search+ Gemini party-fact comparison — 3 November 2026

## Candidate change

In this branch, the dedicated Search+ API uses the existing `adverse-media-ai` Gemini credential and the fixed `gemini-3.5-flash-lite` model. The public route, entitlement, search queries, report path, and response contract remain the same. The previous Azure GPT call is removed from this route. The legacy `ADVERSE_MEDIA_SEARCH_PLUS_GPT_ENABLED` switch remains accepted for deployment compatibility; `ADVERSE_MEDIA_SEARCH_PLUS_ENABLED` is the model-neutral switch.

Gemini receives the same party-fact task instructions and strict source-fact schema used by the GPT candidate. The deterministic adjudicator checks result IDs, verbatim quotes, party identity, and subject-specific legal stages. It retries at most three withheld items once. Missing or unsupported facts remain incomplete. The reported `confidence` is a processing flag (0.9 accepted, 0.7 review-flagged), not a calibrated probability. No model weights were trained or fine-tuned. Prompt, schema, and post-model validation are the adaptation.

## Same-evidence replay

Five fictional cases contain 43 labelled items, including direct regulatory action, related-party action, namesakes, victims, unsupported allegations, routine news, and Arabic evidence. Source retrieval was held constant by replaying the supplied fixture snippets. The direct-label rows score the existing Gemini prompt on simplified fixture candidates with a neutral initial legal stage; they are not end-to-end API runs. Exact means the bucket, subject role, and subject legal stage all matched the fixture judgment.

| Path | Exact bucket | Exact role | Exact stage | All three exact | Withheld | Calls / sequential elapsed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Existing direct-label prompt, Gemini 3.5 Flash Lite | 41/43 | 33/43 | 27/43 | 19/43 | 0 | 5 / 21.0 s |
| Direct-label Gemini 3.5 Flash | 42/43 | 39/43 | 28/43 | 24/43 | 0 | 5 / 26.9 s |
| Party-fact Gemini 3.5 Flash Lite, first run | — | — | — | **43/43** | 0 | 5 / 11.9 s |
| Party-fact Gemini 3.5 Flash Lite, repeat | — | — | — | **41/43** | 0 | 6 / 16.2 s |
| Party-fact Gemini 3.5 Flash | — | — | — | **40/43** | 1 | 8 / 23.0 s |
| Party-fact GPT-5 mini, historical final repeat | — | — | — | **43/43** | 0 | 8 / 45.3 s |

The historical GPT number came from [the prior GPT replay](gpt5-mini-evidence-ledger-evaluation-2026-11-01.md); it was not a simultaneous call and does not establish a latency or accuracy winner. The two Gemini Lite party-fact runs differed on a witness mention and a subsidiary fine. Both errors exchanged non-adverse buckets; neither became a direct adverse finding in this small replay. Gemini Flash withheld an unclear allegation and mislabelled two other non-adverse roles. The direct-label paths repeatedly carried a related party's or namesake's legal stage onto the screened subject, so replacing GPT with the existing direct-label prompt would be a regression.

One live call through the new application adapter and screening cost guard classified all 10 items in the fictional Cobalt Palm case, using two Gemini calls. The guard reserved USD 0.025255 as an upper bound for those calls; it is not an invoiced cost. The guard's Gemini 3.5 Flash Lite rates match [Google's published Standard API pricing](https://ai.google.dev/gemini-api/docs/pricing) checked on 3 November 2026. The authenticated API and PDF tests use mocked providers and pass.

## Release limit

These fixtures were used during earlier prompt and validator development. Their labels are test judgments, and 43 items cannot estimate real-world miss or false-attribution rates. The candidate is therefore code-ready for an internal comparison, not a validated production replacement. Before customer enablement, compare both routes on the same newly held-out, authorized evidence with a fixed retrieval snapshot, review Arabic cases with a qualified reviewer, repeat runs, and set acceptance thresholds for missed direct adverse findings and false direct attribution. Confirm the data-processing location and recheck Gemini pricing for the selected project at deployment. Production routing and workspace entitlements were not changed in this work.

Reproduce the two Gemini paths with `scripts/compare-search-plus-gemini.mjs` and `scripts/evaluate-gemini-party-facts.mjs`, supplying `GEMINI_API_KEY` in the process environment. The scripts never print the key.
