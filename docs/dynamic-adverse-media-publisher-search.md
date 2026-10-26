# Request-time adverse-media publisher search

Owner direction, 26 October 2026: search dynamically for the given entity name and aliases across the approved media list. Do not crawl publishers or build an article index. Consolidate approved-publisher matches with the standard evidence set. The fully loaded ceiling remains below USD 0.15 for each screening request.

## Current local implementation

- The approved source file has 50 ranked placements in each of 30 economies plus an owner-curated specialist outlet, yielding 1,500 unique approved domains. The source file is copied into the API image; no publisher manifests, crawler jobs, queues, tables, or dedicated news storage are needed.
- A request with `search_plus: true` reserves up to six calls inside the existing twelve-call ceiling for explicit site-restricted publisher batches. The selector first round-robins high-value publishers from the requested countries, excludes sports/music/culture-only outlets, and then fills unused capacity with a GDP-country-diversified global ranking. The remaining calls continue broader multilingual current-news, open-web, association, archive, and official-record coverage.
- Each publisher batch searches the primary name, supplied aliases (including alternate-script spellings supplied by the caller), and a compact multilingual adverse-term set. Domain batches are packed below the provider's 400-character query boundary. No publisher website is fetched. Model-generated transliterations are not used before source retrieval.
- `coverage.search_plus.publishers_screened` contains only publishers assigned to successfully completed site-restricted index queries. `publishers_not_completed` contains publishers whose batch failed after controlled retries. Batch counts and the selection strategy are also returned. Approved publishers represented in retained results appear in `matched_publishers`.
- The engine still validates every result URL against the catalog, rejects lookalike domains and homepages, and consolidates targeted publisher results with other relevant evidence. The existing direct official-record lookup remains separate.
- The existing deterministic entity and adverse-term check runs on titles and provider snippets. Bounded model review may reject high-confidence mismatches. The API returns candidate URLs with source metadata for human review. The feature does not fetch article pages or claim to verify the full article text.
- Search-provider results are not a guarantee that every article from a listed publisher was indexed. A no-result response is limited to the publishers named in `publishers_screened`, the broader sources, and the queries actually completed. The full 1,500-domain catalog is not claimed as screened on every request.

## Cost gate

The per-request paid-call guard reserves up to USD 0.14 before each paid search or model call, including retries and the PDF report narrative call. The queued deep-research path shares the same guard between screening and report writing. If the reservation would exceed USD 0.14, the call is blocked; screening coverage may become partial and report writing falls back to a deterministic narrative. This is a conservative admission bound based on the rate constants in the code, not an observed invoice.

USD 0.01 remains provisionally available for API compute, reporting, and other infrastructure within the owner's **USD 0.15 total per-screening ceiling**. This fully loaded ceiling is a rollout gate: measure these costs and screening volume before increasing query volume. The earlier publisher-crawl estimate is withdrawn because this design has no publisher crawl.

## Validation before activation

1. Test representative subject and alias searches locally using mocked providers, then bounded real provider searches with approved test names. Check country prioritisation, publisher-batch packing, domain precision, adverse relevance, missed known stories, multilingual results, and provider behavior when a domain is absent from its index.
2. Confirm actual provider rates and compare reserved upper bounds with invoices. Allocate measured infrastructure and report-storage cost per screening; keep the total below USD 0.15.
3. Review the draft PR and deploy through the protected API workflow from `main`. Activate the feature flag only after the quality and cost gates pass.
