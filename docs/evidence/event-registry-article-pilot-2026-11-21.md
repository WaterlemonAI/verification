# Event Registry article extraction gate

**Scope:** read-only GDELT raw ZIP sampling and isolated provider calls, 20–21 November 2026. No API deployment or customer screening was run. Provider credentials and article bodies are not retained in this document.

## Cohort and result

The pilot sampled 100 actual archived article URLs across 31 distinct 15-minute GKG intervals from 23 October through 19 November 2026 and 91 publisher hosts. Eleven URLs had Arabic-script titles from two publishers; four of those were podcast pages rather than news articles. Forty URLs were selected by adverse-looking title terms; these are sampling signals, not adjudicated findings.

| Measure after bounded retries | Event Registry | Diffbot |
| --- | ---: | ---: |
| Body of at least 300 characters | 91/100 | 84/100 |
| Body and title similarity at least 0.6 | 87/100 | 79/100 |
| Provisional source-consistent article match after canonical review | 82/100 | 74/100 |
| Arabic news articles from Okaz with body | 7/7 | 1/7 |
| Call latency p50 / p95 / p99 | 2.5 / 12.4 / 30.7 seconds | 3.7 / 7.2 / 11.2 seconds |

Event Registry returned bodies for 21 cross-publisher canonical URLs with plausible syndication attribution and matching titles. One further cross-publisher result led to a homepage and was rejected. Four body-bearing results had no canonical URL to confirm, four failed the title threshold and nine had short/empty bodies. Combining both providers produced 88 provisional source-consistent article matches. The word **provisional** matters: the pilot did not establish the screened subject's identity or the article's adversity.

The production adapter is deliberately stricter than this manual pilot count: a cross-publisher canonical must also share a stable article identifier or slug. Therefore 82/100 is a pilot observation, not a claimed automated clearance rate.

The trial archive covered only about four weeks. It cannot prove extraction quality for year-old archived URLs, a broader Arabic publisher set, or a full adverse-media screening. Event Registry trial usage did not change on its usage endpoint during the pilot even though calls succeeded; reconcile metering against its dashboard or provider invoice before production costing. Diffbot's account showed 121 free credits across pilot and diagnostic calls. No paid plan was activated.

On 21 November the new Node adapter made one direct Event Registry extraction call for an archived Okaz URL. It returned a 2,455-character Arabic body, matching publisher canonical host and the documented response fields. This verifies the adapter's live extraction contract, not the Gemini decision, queue, report or callback.

## Release use

Use Event Registry as the primary URL-to-text source. Keep source URL and article title checks, reject homepage and uncertain canonical redirects, and leave an unavailable body or unsupported Gemini finding unresolved. The worker calls only Event Registry's fixed HTTPS endpoint; it never opens arbitrary archived URLs from inside the API network. Production use requires a paid-plan credential, permitted internal processing and linked-excerpt reporting rights, and a controlled end-to-end case through the queue, ledger, PDF and signed callback.

Official references: [extraction endpoint](https://eventregistry.org/documentation?tab=extractArticleInfo), [usage rights](https://help.newsapi.ai/what-am-i-allowed-to-do-with-the-data-from-newsapi-ai/), [article display limits](https://help.newsapi.ai/can-i-show-full-articles-in-my-app-or-website/), [token pricing](https://newsapi.ai/plans).
