# Request-time adverse-media publisher search

Owner direction, 26 October 2026: search dynamically for the given entity name and aliases across the approved media list. Do not crawl publishers or build an article index. Consolidate approved-publisher matches with the standard evidence set. The fully loaded ceiling remains below USD 0.15 for each screening request.

## Current local implementation

- The approved source file has 50 placements in each of 30 economies. One domain appears in two economies, yielding 1,499 unique approved domains. The source file is copied into the API image; no publisher manifests, crawler jobs, queues, tables, or dedicated news storage are needed.
- A request with `search_plus: true` uses the existing multilingual current-news, open-web, and archive searches for the subject, supplied aliases, generated transliterations, and narrowly evidenced associations. It classifies provider hits by the original result URL's HTTPS publisher hostname, rejects lookalike domains and homepages, and consolidates catalog matches with other relevant evidence. The existing direct official-record lookup remains separate.
- The existing deterministic entity and adverse-term check runs on titles and provider snippets. Bounded model review may reject high-confidence mismatches. The API returns candidate URLs with source metadata for human review. The feature does not fetch article pages or claim to verify the full article text.
- Search-provider results are not a guarantee that each of the 1,499 publishers was individually queried or that every article was found. The customer coverage limitation says this explicitly. A no-result response is limited to the providers and queries actually used.
- The feature flag is off by default until local validation, reviewed deployment, and measured cost and quality checks are complete. No production deployment or provider-backed live screening has been performed from this branch.

## Cost gate

The per-request paid-call guard reserves up to USD 0.14 before each paid search or model call, including retries and the PDF report narrative call. The queued deep-research path shares the same guard between screening and report writing. If the reservation would exceed USD 0.14, the call is blocked; screening coverage may become partial and report writing falls back to a deterministic narrative. This is a conservative admission bound based on the rate constants in the code, not an observed invoice.

USD 0.01 remains provisionally available for API compute, reporting, and other infrastructure within the owner's **USD 0.15 total per-screening ceiling**. This fully loaded ceiling is a rollout gate: measure these costs and screening volume before increasing query volume. The earlier publisher-crawl estimate is withdrawn because this design has no publisher crawl.

## Validation before activation

1. Test representative subject and alias searches locally using mocked providers, then bounded real provider searches with approved test names. Check domain precision, adverse relevance, missed known stories, multilingual results, and provider behavior when a domain is absent from its index.
2. Confirm actual provider rates and compare reserved upper bounds with invoices. Allocate measured infrastructure and report-storage cost per screening; keep the total below USD 0.15.
3. Review the draft PR and deploy through the protected API workflow from `main`. Activate the feature flag only after the quality and cost gates pass.
