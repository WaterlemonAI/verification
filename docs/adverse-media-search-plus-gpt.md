# Adverse Media (Search+) parallel API

## Contract

`POST /service/adverse_media_search_plus` is a separate customer module, `adverse-media-search-plus`. It accepts the existing adverse-media JSON fields and requires an active AI7 API key and explicit workspace entitlement. A wildcard entitlement does not admit this module. Its price follows that workspace's existing `adverse-media` rate tiers in the same currency, while Search+ keeps a separate hit count. An absent Adverse Media rate blocks Search+. A later rate change to Adverse Media also changes the Search+ rate; a separate Search+ rate entry is ignored. The route forces `search_plus: true` even if omitted or false. It runs synchronously; `deep_research`, `callback_url`, and `callback_access_key` are rejected. The response uses the existing customer-safe adverse-media structure and has a separate PDF URL under `/service/adverse_media_search_plus/reports/{reportId}.pdf`.

The existing `POST /service/adverse_media` route, its optional Search+ mode, Gemini classifier, billing module, report path, and deep-research behavior are unchanged. Customers can compare the two APIs without replacing the current route. Search+ remains bounded publisher-site index search, not a direct crawl or exhaustive publisher coverage claim.

## GPT processing and review boundary

The new route sends retrieved source titles and excerpts plus the screened subject to the existing `ai7uae-gpt-5-mini` Azure OpenAI deployment through the API runtime's managed identity. It uses the refined `adverse_media_party_facts` instructions and strict JSON schema. A deterministic adjudicator verifies source IDs, verbatim supporting quotes, party identity, and subject-specific legal stages. Unsupported facts are withheld for review; source failures keep the screening partial. If GPT classification is unavailable, the route returns 503 rather than a model-free screening. The route does not call Gemini for classification or report narrative. Its PDF narrative uses the deterministic report writer.

The parallel route always reports `status: partial`, `summary.decision_eligible: false`, `summary.human_review_required: true`, and `coverage.reason_codes` containing `search_plus_review_required`. A human must review the source and classification before any consequential decision. Its Case Manager outcome is `review_required` with reason `SEARCH_PLUS_SCREENING_REVIEW_REQUIRED` and cannot auto-pass. Customer-facing JSON, PDF, and OpenAPI text must use product-neutral wording rather than disclose the model provider. The route uses the same USD 0.14 upper bound for paid search and GPT provider calls, with a USD 0.01 reserve under the USD 0.15 total variable-cost target. Provider costs are reserved before each paid call. GPT pricing constants must be reviewed against the current Azure agreement before enablement.

## Release gate

The Bicep parameter `enableAdverseMediaSearchPlusGpt` defaults to `false`. The protected API deployment workflow reads the environment variable `ADVERSE_MEDIA_SEARCH_PLUS_GPT_ENABLED`; only the literal `true` enables the route and catalog entry. No branch or PR deployment should set that variable as a side effect. Before enabling for customers, approve the data-processing location and affected customer terms: the currently configured GPT-5 mini deployment is **Global Standard**, so prompts and responses may be processed outside the UAE. Configure an explicit Search+ entitlement for each intended workspace and verify its existing Adverse Media rate; other workspaces remain blocked. Complete a larger blinded comparison with the existing API, prompt-injection and source-attribution checks, realistic latency/cost measurements, authenticated entitlement and PDF tests, and an operator rollback check. The prior small synthetic and public-source evaluations are development evidence, not a production quality gate.

Rollback is to set `ADVERSE_MEDIA_SEARCH_PLUS_GPT_ENABLED` to `false` through the protected workflow and confirm the route and catalog entry are disabled. This does not change the existing adverse-media route or previously created report URLs.

## First entitlement scope

The owner selected an internal test workspace first. The existing AI7LAB UAE test workspace is the candidate named in prior platform evidence; verify its current workspace identity and Adverse Media rate before changing its policy. Enable the Search+ entitlement only for that verified workspace, use synthetic requests for the initial authenticated API and PDF check, and leave all other workspace policies unchanged. Record the exact billing ledger entry and confirm the Search+ charge matches the current Adverse Media tier for that workspace. Customer entitlement follows only after the larger blinded quality and privacy-path review.

## Example

```http
POST /service/adverse_media_search_plus
Authorization: Bearer <AI7 API key>
Content-Type: application/json

{"entity_type":"business","name":"Synthetic Example Ltd","countries":["AE"],"languages":["en"],"max_results":25}
```
