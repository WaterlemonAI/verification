# AI7 UAE Vendor Verification and API

Public landing page and Azure deployment configuration for `kycprobe.com`, the signed-in portal and administration console at `app.kycprobe.com`, and the unchanged API at `api.ai7uae.com`.

The site is deployed as a static Nginx container in a dedicated UAE North resource group. The portal and API share the existing dedicated API Container App; host-only browser sessions work on the app hostname, while published API endpoints, report links, and callbacks retain `api.ai7uae.com`. The platform is isolated from other project infrastructure.

For the domain migration, GoDaddy remains authoritative for `kycprobe.com`. Preserve its mail records. Point the apex A record to the dedicated Container Apps environment IP, and point `www` and `app` CNAME records directly to the generated web and API app hostnames. Add the three `asuid` TXT validation records, bind free managed certificates for each hostname, then set the corresponding GitHub environment certificate resource ID variables before rerunning both deployment workflows. The old `ai7uae.com` landing hostname remains available during the cutover; `api.ai7uae.com` remains unchanged for API clients.

## Azure resources

- Resource group: `rg-ai7uae-web-uaen-001`
- Container Apps environment: `cae-ai7uae-web-uaen-001`
- Container app: `ca-ai7uae-web`
- Container registry: `acrai7uaeuaen001`
- Log Analytics workspace: `log-ai7uae-web-uaen-001`
- DNS zone: `ai7uae.com`

`infrastructure/platform.bicep` defines the dedicated platform. `infrastructure/main.bicep` deploys the digest-pinned site image, and `infrastructure/dns.bicep` preserves the domain's web and mail records.

The GitHub deployment identity receives the custom role in `infrastructure/ai7uae-deployer-role.json`. Its assignable scope is restricted to this project's resource group.

## Verification API

### Bank statement analysis

The [Bank Statement Analysis module](bank-statement-analysis/README.md) is available in the customer portal and under **Analysis** in the admin console. Its authenticated asynchronous API uses encrypted private Azure Blob/Table/Queue storage, a dedicated scale-to-zero Python worker, and managed-identity access to the paid Azure Document Intelligence S0 tier in UAE North. Managed Layout extraction is bounded to 100 pages and a USD 1.00 ceiling per request at the UAE North retail rate of USD 10 per 1,000 prebuilt pages. A private ClamAV sidecar scans every decrypted upload over localhost before normalization or extraction; a detection, unavailable scanner, or protocol error fails closed. The [engineering handoff](docs/bank-statement-analysis/README.md) and module README document the remaining decision-support limitations.

The provider-neutral API portal and wrapper are served from `api.ai7uae.com`. Current endpoints are:

```text
POST /service/uae_tlv
POST /service/iban_verification
POST /service/entity_search
POST /service/adverse_media
POST /service/merchant_screening
POST /service/bank_statement_analysis
GET  /service/bank_statement_analysis/{analysisId}
GET  /service/bank_statement_analysis/{analysisId}/result
POST /forms/{formId}/submissions
GET  /service/adverse_media/reports/{reportId}.pdf
GET  /service/merchant_screening/reports/{reportId}.pdf
GET  /service/forms/reports/{reportId}.pdf
```

The services authenticate each AI7 customer with one Bearer API key. Provider-backed wrappers relay their upstream JSON body and HTTP status without exposing upstream hostnames, credentials, or identifying headers. The native adverse-media service searches current and archived global news plus open-web indexes in up to five languages, deduplicates evidence, classifies adverse-event categories and legal stage, and can enrich the highest-priority candidates with a bounded AI review. For multi-part individual names it can resolve explicit aliases and associated organizations from neutral evidence before running one bounded association search. It enforces a 12-query/$0.15 internal cost guardrail. Customers can set `high_risk_threshold_percent` and `review_threshold_percent`; retained scores at or above the first are High Risk, scores from the second up to the first require Review, and lower scores are Safe. The legacy decimal `risk_threshold` remains supported as a review-boundary alias. The adverse-media public contract exposes only customer-ready evidence and provider-neutral coverage fields; internal model output, transliterations, query/cost telemetry, component scores, and high-confidence rejected mismatches remain private. Low-confidence AI output cannot suppress evidence, and incomplete runs return an inconclusive outcome with safe reason codes. Every synchronous screening automatically creates a PDF audit report. The only report-specific request field is the optional `customer_logo_url`; the response contains the permanent report ID, transaction ID, integrity hash, and an absolute public capability URL. Anyone with that unguessable URL can download the report without an API key, while the underlying Azure container remains private and non-listable. Deep-research callbacks contain the same report metadata and always post the final result after the engine's controlled retries. A callback can therefore contain either a completed, decision-eligible result or a partial, explicitly inconclusive result that requires manual review. The portal includes copyable cURL, JavaScript, and Python examples, an OpenAPI document, live JSON response consoles, and direct PDF download. The comprehensive entity-search page also exposes a searchable response-field reference generated from every path in its official schema and response variants.

Client keys are stored only as SHA-256 hashes. Upstream configuration and hashes are loaded from Azure Key Vault through the API app's dedicated managed identity. No provider secrets are committed to this repository or sent to the browser.

### Merchant website screening foundation

`POST /service/merchant_screening` accepts a public HTTPS `website_url`, a two-letter `country_code`, and optional declared merchant name/MCC fields. It reuses the API's Bearer-key authentication and returns an evidence-backed, bounded website assessment covering merchant identity, linked social profiles, addresses and contacts, JSON-LD products, candidate product MCC mappings, policy discovery, data-retention language, outgoing destinations, negotiated TLS, and security headers. The crawler observes `robots.txt`, remains on the submitted origin, limits pages and bytes, pins validated public DNS results, and rejects private, reserved, metadata, credential-bearing, non-HTTPS, and non-standard-port destinations on every redirect.

Customers can set `high_risk_threshold_percent` (default 60) and `review_threshold_percent` (default 25). Scores at or above the first are `high_risk`, scores from the second up to the first are `review`, and lower scores are `safe`; a critical finding always remains High Risk. Top-level `status` is independent coverage state: `completed` means every required source completed, while `partial` means at least one required source was unavailable or incomplete. Thresholds never turn a partial result into a decision-eligible result.

Production uses a dedicated, internal-only Chromium worker for bounded rendered captures. The worker has its own managed identity with only ACR image-pull access; it cannot read API credentials, Key Vault secrets, report storage, or unrelated Azure resources. It captures the homepage in desktop and mobile viewports, then a bounded contact/product sample up to four images per screening. The public JSON contains image metadata and hashes, while the actual image bytes are available only inside an opt-in permanent PDF report. The latest 20 X mentions and destination-reputation confirmation remain `not_configured` until approved providers are connected. Candidate MCCs and prohibited-destination keyword matches are review signals rather than payment-network classifications or automatic decline decisions. Public partnership and sponsorship references are retained as source-scoped website claims; independent partnership verification and company-registry enrichment are outside this API's requirements. A partial response has `summary.decision_eligible: false` and must be manually reviewed.

Set `get_pdf: true` to create the permanent merchant-screening audit report. An optional public HTTPS `customer_logo_url` places the customer's PNG or JPEG on the cover. The PDF includes the service description, customer-safe processing log, executive outcome, coverage, actual rendered screenshots, merchant and domain evidence, policies, products and candidate MCCs, external destinations, findings, evidence hashes, and attached request/response JSON. The API response returns its UUID capability URL, SHA-256 digest, transaction ID, filename, and generation time. Anyone with that unguessable URL can download the report; the backing Azure container remains private and non-listable.

The end-to-end worker, provider, evidence-storage, privacy, and production-gate design is in [`docs/merchant-screening-design.md`](docs/merchant-screening-design.md).

Local example:

```bash
curl http://127.0.0.1:8080/service/merchant_screening \
  -H 'Authorization: Bearer YOUR_LOCAL_AI7_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"website_url":"https://merchant.example","country_code":"AE","max_pages":12}'
```

For local screenshot testing, install dependencies and set `MERCHANT_SCREENSHOT_MODE=local`. The local provider uses the system Chrome path on macOS by default; set `MERCHANT_SCREENSHOT_BROWSER_PATH` on other systems. It captures the homepage, one contact/support page, and at most two product pages at desktop and mobile viewports, writes private temporary PNGs under the operating-system temp directory, and returns authenticated local-only `download_path` values. Direct in-process capture remains hard-disabled when `NODE_ENV=production`; production can enable it only inside the separately deployed isolated worker.

```bash
MERCHANT_SCREENSHOT_MODE=local npm start
```

The full merchant-screening ceiling is `$0.05` per request. Screenshots are allocated at most `$0.02`, leaving `$0.03` for all other optional providers. The local Chromium provider has no external per-render supplier fee. Set `MERCHANT_SCREENSHOT_ESTIMATED_COST_PER_CAPTURE_USD` to exercise the pre-render budget gate; captures beyond the screenshot allocation are skipped. The production worker is scale-to-zero and caps each run at four rendered captures. Its configured estimate is checked before launch and stays within the screenshot allocation; measured Container Apps usage should be reviewed against that estimate during normal cost monitoring.

### API Engine administration

The protected console at `/admin` lets an operator:

- register a provider-neutral public route and private upstream endpoint;
- store or rotate a write-only upstream master authentication key;
- configure Bearer, custom-header, or unauthenticated upstream access;
- constrain accepted content types and document expected status codes;
- enable or disable an integration;
- issue a one-time customer API key that works across every configured integration; and
- revoke a customer key without changing other customers or upstream credentials.

### Forms orchestration

The protected administration console includes a Forms builder for combining up to ten enabled AI7 APIs behind one customer-facing endpoint. Each versioned Form defines its public fields and a server-side JSON input template for each selected API. Templates use `{{field_key}}` placeholders; an exact placeholder preserves numbers and booleans, while embedded placeholders produce text. Supplier endpoints, master credentials, and private adapter settings are never exposed in the Form schema or browser.

Customers submit one authenticated JSON request to `POST /forms/{formId}/submissions` containing `data`, a public HTTPS `callback_url`, and an optional public HTTPS `customer_logo_url`. The API returns HTTP 202 with a submission ID and one-time HMAC signing secret. Processing is durable and asynchronous. The final `forms.submission.completed` callback includes a stable delivery ID, top-level `completed`, `partial`, or `failed` orchestration status, decision eligibility, processing log, every API's exact response nested under its own service record, and one permanent consolidated PDF capability URL. The callback is signed in `x-ai7-signature` as `sha256=<hex HMAC of the raw body>` and includes `x-ai7-delivery-id` for idempotent consumers. Delivery is retried with bounded exponential backoff without re-running completed checks.

Top-level orchestration status and each API's business result are independent. `completed` means every selected API transport returned HTTP 2xx; `partial` means at least one but not all API transports completed; and `failed` means none completed. Every service record separately reports `transport`, `coverage`, and `eligibility`, including customer-safe reason codes. A Form sets `summary.decision_eligible` to true only when every selected check affirmatively qualifies. An HTTP 200 containing a partial adverse-media or merchant-screening result therefore keeps the transport complete while making the consolidated decision ineligible. The callback and consolidated PDF carry the per-service and consolidated reasons. The PDF also records the submission ID, form version, timestamps, request network origin, Azure processing location, collected fields, processing log, and full response JSON. It is stored permanently in the existing private, non-listable AI7 report store and downloaded through an unguessable public capability URL.

Forms currently accept JSON-capable API inputs. Binary trade-licence document uploads remain available through the direct UAE trade-licence endpoint and are intentionally not copied into the queue-backed Forms contract.

The live UAE Vendor Due Diligence Form combines four APIs: UAE Trade Licence, Comprehensive Entity Search, Global Adverse Media Screening, and Merchant Website Screening. Its current public schema does not include IBAN Verification or Bank Statement Analysis. Forms can still be configured with other JSON-capable APIs through the protected builder; binary uploads remain direct-API operations.

The admin key stays in browser memory only. Issued customer keys are displayed once, while only SHA-256 hashes are retained. Public catalog responses omit upstream URLs, authentication configuration, Key Vault names, and supplier identity.

Run the contract tests locally with:

```bash
npm test
```

Run the API container with the values described in `.env.example`:

```bash
docker build -f Dockerfile.api -t ai7uae-api:local .
docker run --rm -p 8080:8080 --env-file .env ai7uae-api:local
```

API-specific Azure definitions are intentionally separate from the existing landing app:

- `infrastructure/api-platform.bicep` creates dedicated API runtime/deployment identities, workload federation, and Key Vault.
- `infrastructure/api.bicep` creates `ca-ai7uae-api` and gives the engine its managed-identity Key Vault connection.
- `infrastructure/merchant-screenshot-platform.bicep` creates the screenshot worker's dedicated ACR-pull-only identity; `infrastructure/api.bicep` creates the internal-only scale-to-zero worker without sharing the API identity.
- `infrastructure/api-reports-platform.bicep` creates the isolated private blob/table report store and grants only the API runtime identity blob/table data access. Shared-key and public blob access are disabled; versioning and 90-day soft-delete protect against accidental changes, and no lifecycle deletion rule is configured.
- `infrastructure/api-dns.bicep` adds only the `api` and `asuid.api` records to the existing AI7 UAE DNS zone.
- `.github/workflows/deploy-api.yml` builds and deploys a digest-pinned API image through the protected `ai7uae-api` GitHub environment.

### Local GDELT archive

The adverse-media service can use a dedicated, locally indexed GDELT Global Knowledge Graph archive instead of depending entirely on the shared hosted search API. The archive is isolated inside the AI7 UAE resource group:

- `infrastructure/api-gdelt-platform.bicep` creates a dedicated storage account, private raw-data container, entity-index table, ingestion identity, and least-privilege data-plane assignments.
- `infrastructure/api-gdelt-job.bicep` creates a single-replica scheduled Container Apps job.
- `scripts/gdelt-ingest.mjs` performs a bounded 72-hour initial backfill, then retrieves a 36-hour overlap on each daily run, archives original compressed files, indexes person and organization mentions, and advances a durable watermark only after successful processing.
- The API reads the local index with its existing managed identity. A local snapshot is treated as complete only when its retained coverage contains the requested date range and the watermark is no more than 48 hours old; otherwise the hosted archive remains a controlled fallback and the response is marked partial if that fallback fails.

The default schedule is `01:30 UTC` daily. All raw files and index entries remain private. GDELT-derived data must retain attribution to the [GDELT Project](https://www.gdeltproject.org/).

### Approved publisher search

The owner-approved [publisher catalog](top_50_media_publishers_30_largest_economies_2026.json) contains 1,500 unique domains across 30 economies, including curated specialist outlets. Set `search_plus: true` per request to reserve bounded search capacity for explicit site-restricted publisher batches, prioritising requested countries, curated sources, and high-value news/finance outlets, then consolidate those results with the normal evidence set. The response and PDF record every publisher included in a successfully completed batch and every publisher in an incomplete batch. Search+ does not crawl publisher websites or claim that an index contains every article. See the [current design and cost gate](docs/dynamic-adverse-media-publisher-search.md).

The adverse-event taxonomy separately identifies corporate misconduct, founder/leadership disputes, workforce restructuring, and financial distress. Layoffs, downsizing, founder departures, and restructurings are reviewable corporate events; their presence does not by itself label the company or its leadership as fraudulent.

The API Engine manages these records inside the dedicated Key Vault:

- `ai7-admin-key-hashes`: comma-separated SHA-256 hashes of authorized admin keys; bootstrapped outside the app.
- `api-engine-integrations`: the private integration registry.
- `form-<id>`: one versioned multi-API Form definition per secret, without supplier credentials.
- `client-<id>`: one customer record per key, containing only the hash plus non-secret lifecycle tags.
- `integration-<id>-master-key`: one write-only upstream master key per integration.

`adverse-media` and `adverse-media-ai` are runtime-managed integrations. Their private credentials are stored separately as `integration-adverse-media-master-key` and `integration-adverse-media-ai-master-key`; either can be set or rotated from the protected administration console. The AI credential is optional and deterministic screening remains available without it.

Do not commit or place plaintext credentials in GitHub variables. Bootstrap the admin hash in the dedicated API vault, then manage integrations and customer credentials through the protected console.
