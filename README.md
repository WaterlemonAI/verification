# AI7 UAE Vendor Verification and API

Public landing page and Azure deployment configuration for `ai7uae.com`.

The site is deployed as a static Nginx container in a dedicated UAE North resource group. Its Container Apps environment, registry, logging workspace, managed identities, and DNS zone are isolated from all KYCProbe and other project infrastructure. It contains no customer data and has no access to KYC application services or databases.

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

The provider-neutral API portal and wrapper are served from `api.ai7uae.com`. Current endpoints are:

```text
POST /service/uae_tlv
POST /service/iban_verification
POST /service/entity_search
POST /service/adverse_media
POST /service/merchant_screening
GET  /service/adverse_media/reports/{reportId}.pdf
```

The services authenticate each AI7 customer with one Bearer API key. Provider-backed wrappers relay their upstream JSON body and HTTP status without exposing upstream hostnames, credentials, or identifying headers. The native adverse-media service searches current and archived global news plus open-web indexes in up to five languages, deduplicates evidence, classifies adverse-event categories and legal stage, and can enrich the highest-priority candidates with a bounded AI review. For multi-part individual names it can resolve explicit aliases and associated organizations from neutral evidence before running one bounded association search. It enforces a 12-query/$0.15 internal cost guardrail. The adverse-media public contract exposes only customer-ready evidence and provider-neutral coverage fields; internal model output, transliterations, query/cost telemetry, component scores, and high-confidence rejected mismatches remain private. Low-confidence AI output cannot suppress evidence, and incomplete runs return an inconclusive outcome with safe reason codes. Every synchronous screening automatically creates a private PDF audit report. The only report-specific request field is the optional `customer_logo_url`; the response contains the permanent report ID, transaction ID, integrity hash, and absolute authenticated download URL. Deep-research callbacks contain the same report metadata and always post the final result after the engine's controlled retries. A callback can therefore contain either a completed, decision-eligible result or a partial, explicitly inconclusive result that requires manual review. The portal includes copyable cURL, JavaScript, and Python examples, an OpenAPI document, live JSON response consoles, and direct PDF download. The comprehensive entity-search page also exposes a searchable response-field reference generated from every path in its official schema and response variants.

Client keys are stored only as SHA-256 hashes. Upstream configuration and hashes are loaded from Azure Key Vault through the API app's dedicated managed identity. No provider secrets are committed to this repository or sent to the browser.

### Merchant website screening foundation

`POST /service/merchant_screening` accepts a public HTTPS `website_url`, a two-letter `country_code`, and optional declared merchant name/MCC fields. It reuses the API's Bearer-key authentication and returns an evidence-backed, bounded website assessment covering merchant identity, linked social profiles, addresses and contacts, JSON-LD products, candidate product MCC mappings, policy discovery, data-retention language, outgoing destinations, negotiated TLS, and security headers. The crawler observes `robots.txt`, remains on the submitted origin, limits pages and bytes, pins validated public DNS results, and rejects private, reserved, metadata, credential-bearing, non-HTTPS, and non-standard-port destinations on every redirect.

The foundation reports `not_configured` coverage for rendered screenshots by default, and always does so for the latest 20 X mentions and destination-reputation confirmation until approved providers are connected. Local development can enable the guarded Chromium renderer described below. Candidate MCCs and prohibited-destination keyword matches are review signals rather than payment-network classifications or automatic decline decisions. Public partnership and sponsorship references are retained as source-scoped website claims; independent partnership verification and company-registry enrichment are outside this API's requirements. A partial response has `summary.decision_eligible: false` and must be manually reviewed.

The end-to-end worker, provider, evidence-storage, privacy, and production-gate design is in [`docs/merchant-screening-design.md`](docs/merchant-screening-design.md).

Local example:

```bash
curl http://127.0.0.1:8080/service/merchant_screening \
  -H 'Authorization: Bearer YOUR_LOCAL_AI7_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"website_url":"https://merchant.example","country_code":"AE","max_pages":12}'
```

For local screenshot testing, install dependencies and set `MERCHANT_SCREENSHOT_MODE=local`. The local provider uses the system Chrome path on macOS by default; set `MERCHANT_SCREENSHOT_BROWSER_PATH` on other systems. It captures the homepage, one contact/support page, and at most two product pages at desktop and mobile viewports, writes private temporary PNGs under the operating-system temp directory, and returns authenticated local-only `download_path` values. It is hard-disabled when `NODE_ENV=production`.

```bash
MERCHANT_SCREENSHOT_MODE=local npm start
```

The full merchant-screening ceiling is `$0.05` per request. Screenshots are allocated at most `$0.02`, leaving `$0.03` for all other optional providers. The local Chromium provider has no external per-render supplier fee. Set `MERCHANT_SCREENSHOT_ESTIMATED_COST_PER_CAPTURE_USD` to exercise the pre-render budget gate; captures beyond the screenshot allocation are skipped. The future queued Azure worker must use measured Container Apps compute and storage rates before it can be enabled.

### API Engine administration

The protected console at `/admin` lets an operator:

- register a provider-neutral public route and private upstream endpoint;
- store or rotate a write-only upstream master authentication key;
- configure Bearer, custom-header, or unauthenticated upstream access;
- constrain accepted content types and document expected status codes;
- enable or disable an integration;
- issue a one-time customer API key that works across every configured integration; and
- revoke a customer key without changing other customers or upstream credentials.

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

### Planned owned news index

The implementation handoff for the isolated, compliance-oriented 1,000-publisher news index is in [`docs/owned-news-index-build-handoff.md`](docs/owned-news-index-build-handoff.md). It defines the source registry, crawl and licensing controls, Azure resource boundaries, storage contracts, API integration, rollout gates, tests, and definition of done. It is a build specification only; its presence does not mean those resources or coverage are deployed.

The API Engine manages these records inside the dedicated Key Vault:

- `ai7-admin-key-hashes`: comma-separated SHA-256 hashes of authorized admin keys; bootstrapped outside the app.
- `api-engine-integrations`: the private integration registry.
- `client-<id>`: one customer record per key, containing only the hash plus non-secret lifecycle tags.
- `integration-<id>-master-key`: one write-only upstream master key per integration.

`adverse-media` and `adverse-media-ai` are runtime-managed integrations. Their private credentials are stored separately as `integration-adverse-media-master-key` and `integration-adverse-media-ai-master-key`; either can be set or rotated from the protected administration console. The AI credential is optional and deterministic screening remains available without it.

Do not commit or place plaintext credentials in GitHub variables. Bootstrap the admin hash in the dedicated API vault, then manage integrations and customer credentials through the protected console.
