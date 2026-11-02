# GPT-5 mini public-source spot check: AI7Lab and eMudhra

## Result

The candidate source-fact and research-ledger paths matched the manually set labels on **six adverse-media items** and **five research observations** in the final replay. One adverse-media item needed the existing bounded retry. The research ledger corrected a Hindi headline-scope error and retained a review flag. This is a narrow, source-bound spot check, not a complete adverse-media search, production screening, legal conclusion, or Gemini comparison.

## Sources and expected interpretation

The AI7Lab sample used three public pages: the [home page](https://www.ai7lab.net/), [announcements](https://www.ai7lab.net/announcements), and [contact page](https://www.ai7lab.net/contact). The selected excerpts describe products, a launch, and the site's legal-name footer. They were expected to remain ordinary mentions with no subject legal stage. The two-source AI7Lab research ledger had no event link. These pages are largely self-published and cannot establish adverse-media clearance.

The eMudhra sample used the company's [certificate-incident statement](https://emudhra.com/en/post/certificate-security-incident), the [Google Chrome Security account](https://blog.google/security/protecting-chrome-and-android-users-from-compromised-emudhra-intermediate-ca-certificates/), and a [Navbharat Times multi-company article](https://navbharattimes.indiatimes.com/metro/delhi/other-news/sbi-probes-alleged-dark-web-data-leak-as-hdfc-investigates-confidential-information-sharing-and-emudhra-fixes-security-flaws/articleshow/135107446.cms). The selected excerpts support a material certificate-key incident with `media_mention` as the subject's legal stage. They do not establish a customer-data breach or a formal charge against eMudhra. The Hindi article headline suggests a data-leak investigation across SBI, HDFC, and eMudhra, while its selected eMudhra excerpt describes weak digital keys. The ledger should flag that mismatch for review. The three eMudhra source IDs were linked through a human-verified reference for the same intermediate-CA incident; the model cannot create event links.

The exact short excerpts, source URLs, and expected labels are in the [AI7Lab party-fact](../test/fixtures/gpt5-mini-public-ai7lab.json), [eMudhra party-fact](../test/fixtures/gpt5-mini-public-emudhra.json), [AI7Lab research](../test/fixtures/gpt5-mini-public-ai7lab-research.json), and [eMudhra research](../test/fixtures/gpt5-mini-public-emudhra-research.json) fixtures. The selected snippets were checked against the linked public pages on 1 November 2026. The two companies' names and publicly displayed business details were the only real-world case data sent to the model.

## Live replay

The active Azure subscription and UAE North API revision `ca-ai7uae-api--0000092` were verified immediately before testing. The existing runtime managed identity invoked the deployed `ai7uae-gpt-5-mini` Global Standard model. The scripts ran inside a temporary directory in that API container. No customer screening API, Gemini route, database, search provider, cloud resource configuration, or customer record was changed.

| Final replay | Exact labels | Calls | Input / output tokens | Sequential time | Review |
| --- | ---: | ---: | ---: | ---: | --- |
| AI7Lab and eMudhra party facts | 6/6 | 3 | 4,025 / 886 | 8.1 s | E3 rejected on first pass for a stage absent from its quote; low-reasoning retry recovered it. |
| Two independent research ledgers | 5/5 | 2 | 2,224 / 306 | 4.5 s | Hindi E3 headline scope corrected and flagged. |

The first primary-source pass, before the Hindi article was added, scored 5/5 party facts and 4/4 research observations. The new Hindi item scored 1/1 in a single-item party-fact run, but the three-source research ledger initially scored 2/3 because GPT did not mark the headline dispute. A prompt-only refinement flagged the headline but made GPT call the documented weak-key incident an unsupported claim. The final validator uses narrow excerpt-based checks to correct both labels and records the correction for review. It does not silently treat a corrected model answer as independently verified.

The final party-fact run used `node scripts/evaluate-gpt5-mini-party-facts.mjs --bounded-retry test/fixtures/gpt5-mini-public-ai7lab.json test/fixtures/gpt5-mini-public-emudhra.json`. The ledgers used `node scripts/evaluate-gpt5-mini-research-ledger.mjs` with each research fixture. These are live model calls with deterministic local label checks; later model responses may vary. Token counts are Azure response telemetry, not a billed-cost estimate.

## Interpretation and remaining gates

This spot check shows correct attribution on the selected source excerpts, including a multilingual headline that needed a review-flagged correction. The test did not exercise source discovery, the full adverse-media API response contract, report rendering, tenant authorization, real customer evidence, repeatability at scale, or a head-to-head run against Gemini on identical retrieved evidence. The candidate remains disconnected from production. Gemini routing is unchanged. Global Standard processing may occur outside the UAE, so any later authorized real-case evaluation must pass the privacy gate first.

Local validation covered the GPT guideline, party-fact, source-ledger, and adverse guard tests, both replay-script dry runs, and the existing association regression. The headline check includes negative controls for a confirmed data leak and an anonymous key-defect rumor. Temporary files in the API container were removed after testing.
