# Merchant website screening API — implementation and production design

Status: production API foundation implemented. A separate internal-only Chromium worker provides bounded rendered captures; licensed X and destination-reputation providers remain future coverage gates.

## API contract

`POST /service/merchant_screening` uses the existing AI7 Bearer API key. The minimum request is:

```json
{
  "website_url": "https://merchant.example",
  "country_code": "AE"
}
```

Optional inputs are `declared_merchant_name`, `declared_mcc`, `max_pages` (1–20, default 12), `high_risk_threshold_percent` (default 60), `review_threshold_percent` (default 25), `get_pdf` (default false), and `customer_logo_url` (public HTTPS PNG/JPEG, used only when a PDF is requested). A response separates:

- observed merchant data and evidence;
- risk findings and candidate MCC mappings;
- confidence and source coverage; and
- missing provider coverage that prevents an automated decision.

When `get_pdf` is true, the response also contains a permanent, unguessable public capability URL and integrity metadata. The PDF contains a service description, a customer-safe processing log, actual rendered screenshot images and their hashes, all result sections, and machine-readable request/response attachments.

`status: "partial"` and `summary.decision_eligible: false` are intentional when a required enrichment provider is unavailable. A missing result must never be interpreted as a negative match.

Top-level status is a coverage state, not a risk band. Its expected values are `completed` and `partial`. Risk bands are `high_risk`, `review`, and `safe`: scores at or above the customer High Risk threshold are High Risk; scores from the Review threshold up to that boundary require Review; lower scores are Safe. A critical finding overrides the numeric boundary and remains High Risk. Incomplete coverage always requires human review regardless of the numeric band.

## Locally implemented foundation

- Bounded HTTPS-only, same-origin crawl with page and byte limits.
- `robots.txt` discovery and enforcement.
- DNS resolution before each request, public-address validation, DNS pinning, redirect revalidation, standard HTTPS port enforcement, and request timeouts.
- Page hashes and stable evidence IDs.
- Organization, address, contact, founder, leadership, social-profile, product, price, and brand extraction from JSON-LD, with limited HTML/Open Graph fallbacks.
- Public partnership and sponsorship claim extraction, retained as source-scoped merchant website claims. Independent verification is outside the API requirements.
- Privacy, terms, returns, shipping, and customer-support policy discovery.
- Data-storage and retention-language presence checks.
- Anchor, script, iframe, and form destination inventory.
- First-party, social, payment, analytics/advertising, and external destination classification.
- Prohibited-category keyword signals. These are review signals, not reputation verdicts.
- Negotiated TLS protocol/cipher and recommended HTTP response-header checks.
- RDAP domain creation date and calculated age when public RDAP data is available.
- Product-level candidate MCC and risk mapping, explicitly labelled low-confidence and human-review-only.
- AE and generic policy baselines. These check evidence presence; they do not make legal-compliance claims.

The API is synchronous. Request/response data is not persisted unless the customer explicitly requests a PDF; requested reports are permanently retained in the existing private, non-listable report store and exposed only through their UUID capability URL. The complete API has a hard USD 0.05 cost ceiling per screening. Screenshots receive at most USD 0.02 of that budget, preserving USD 0.03 for other optional provider calls.

## Provider coverage still required

The production API currently reports the last four areas as `not_configured` or `heuristic_only`; rendered screenshots are supplied by the isolated worker:

1. **Rendered website screenshots** — implemented in a separate Chromium/Playwright Container App. It captures the landing page at desktop and mobile sizes, then a bounded contact/product sample up to four images total. The worker returns image bytes only to the API for immediate PDF embedding and deletes its temporary batch. The customer response retains final URL, timestamp, viewport, DOM hash, and image hash without exposing raw bytes.
2. **Latest 20 X mentions** — use an approved X API or licensed social-data provider. Save only fields permitted by its current licence and retention terms. Make recency, pagination, deleted-post handling, and rate-limit coverage explicit.
3. **Destination reputation and prohibited-site confirmation** — connect at least one malware/phishing/reputation feed and a separately governed prohibited-business taxonomy. Keyword matching alone must not cause an automatic decline.
4. **MCC reference governance** — replace the starter mapping with an acquirer-approved, versioned card-network/MCC reference plus country and scheme overrides. Preserve the mapping version with each decision.
5. **Policy legal rules** — have counsel approve versioned country packs defining mandatory disclosures, regulator/free-zone applicability, acceptable policy wording, and escalation rules.

Authoritative company-registry enrichment and independent partnership verification are explicitly outside the merchant-screening completion requirements. The API may return names or partnership references observed on the merchant website, but their third-party verification status does not affect coverage or decision eligibility.

### Concrete connector requirements

#### Latest 20 X mentions

- Approved X developer account, Project/App, and app-only Bearer token stored in Key Vault.
- Recent Search query combining the merchant name, confirmed X handle, and merchant domain; exclude posts authored by the merchant only if the customer requests third-party mentions exclusively.
- Request up to 20 newest posts with post ID, text, author ID, creation time, language, conversation ID, public metrics, entities/URLs, and expanded author identity.
- Return the exact query window and query terms, distinguish zero results from provider failure, deduplicate reposts where configured, and cap the public response at 20.
- Track X rate-limit response headers, retry only retryable failures with jitter, and return `partial`/`unavailable` on exhaustion rather than an empty successful list.
- Apply X developer terms for display, deletion/compliance events, caching, and retention. Avoid persisting post text unless the approved use and licence allow it; storing post IDs plus short-lived response data is preferred.

#### Destination reputation

- Commercially licensed URL-threat lookup for malware, phishing/social engineering, and unwanted-software coverage. Google Safe Browsing is documented for non-commercial use; a commercial service such as Google Web Risk or an equivalent licensed provider is required for this revenue-generating API.
- Separately governed business-category/prohibited-activity taxonomy. Malware feeds do not determine whether a legitimate gambling, adult, weapons, or other restricted-business destination violates an acquirer's policy.
- Canonicalize and check every unique external URL, its redirect destination, and the registrable domain. Preserve provider, category/threat type, lookup time, cache expiry, and source-page evidence.
- Cache results only for the provider-specified lifetime. A no-match response means `not_listed`, not `safe`; a provider failure must result in incomplete coverage and manual review.
- Combine signals only through versioned rules: malware/phishing verdict, business category, prohibited-policy match, confidence, and final review reason must remain separately visible.

#### Rendered screenshots

- Dedicated Chromium/Playwright image and a separate internal-only Container App; the public API container does not contain or run a browser.
- Process one render request per worker replica. Capture the landing page at desktop and mobile sizes, then a bounded contact/product sample, with strict page/time/pixel/byte limits.
- Fresh non-persistent browser context per page, service workers blocked, downloads disabled, no saved credentials/cookies, and deterministic animation/font settling before capture.
- Apply private/reserved/metadata IP blocking to every browser request and redirect, including scripts, images, frames, WebSockets, and DNS changes. Enforce the restriction at both the Playwright request layer and the worker network boundary.
- Delete temporary PNG bytes after the API response. If `get_pdf` is true, embed those exact bytes into the permanently retained report; otherwise retain only response metadata. Record source URL, final URL, HTTP status, viewport, capture time, image SHA-256, and rendered DOM hash.
- Do not expose screenshot bytes or worker addresses in the public JSON. The permanent PDF is available through the report's unguessable capability URL and the underlying container remains private and non-listable.
- Enforce the render-cost estimate before launching a browser. The screenshot subtotal must remain at or below USD 0.02 and the complete screening subtotal must remain at or below USD 0.05; skip excess captures and report the coverage gap instead of overspending.

## Recommended Azure runtime

The design reuses the existing API app, Container Apps environment, report storage, and report metadata conventions. The screenshot worker is deliberately separated from the API identity and secrets:

```text
api.ai7uae.com
    |
    +-- existing API container: validate, authenticate, create job, read result
            |
            +-- internal-only screenshot Container App: render temporary evidence
            |       +-- ACR-pull-only identity; no Key Vault or storage access
            |
            +-- future provider adapters: X and destination reputation
            +-- existing private Blob/Table report store: requested PDFs only
            +-- existing Log Analytics: operational telemetry without page bodies
```

The browser worker should not share the API container. It needs a non-root user, read-only filesystem, dropped Linux capabilities, strict CPU/memory/time limits, disabled downloads, no cloud metadata access, public-internet-only egress, and fresh browser context per page. Provider adapters should receive scoped secrets independently so a website-rendering compromise cannot reach social, registry, or storage credentials.

Azure Container Apps does not expose the unprivileged user namespace required by Chromium's inner Linux sandbox. The worker therefore launches Chromium with that browser-level sandbox disabled and treats the Container App as the isolation boundary. Compensating controls are mandatory: an unprivileged container user, internal-only ingress, a dedicated identity with only ACR pull, no application or storage secrets, fresh browser contexts, disabled downloads/service workers, per-request public-address checks, strict capture limits, and immediate temporary-file deletion. A future runtime that supports Chromium's sandbox plus network-level public-egress enforcement should replace this fallback.

For the current scale, Azure Queue + Blob + Table is the least disruptive fit because those dependencies and operational patterns already exist. Reassess PostgreSQL/Cosmos DB and Azure AI Search only when query, relationship, or analyst-search requirements exceed that model.

## Evidence and storage policy

Before persistence is enabled, approve a country/customer-specific retention matrix. Each record should carry `tenant_id`, `screening_id`, evidence class, source URL, collection time, content hash, policy-pack version, MCC-map version, provider licence, retention class, and purge date.

Suggested classes for legal and commercial review—not production defaults:

- job telemetry and transient rendered files: hours to days;
- raw public HTML and screenshots: shortest defensible investigation window;
- derived findings and decision evidence: the acquirer/regulatory audit period;
- social-provider content: no longer than the provider licence allows;
- secrets: Key Vault only, never screening records or logs.

Apply tenant isolation, encryption with managed keys unless a customer-managed key is required, private endpoints, soft delete/versioning where appropriate, immutable audit hashes, data-subject correction workflows, and purge verification. Logs should contain identifiers and timings, not raw page bodies, social content, credentials, or full request/response payloads.

## Decision model

Keep three independent concepts:

- **Risk** — severity of supported findings.
- **Confidence** — strength and consistency of evidence.
- **Coverage** — which required sources completed successfully.

Automation is eligible only when the selected policy pack's mandatory coverage is complete. Critical signals should produce enhanced due diligence, not an irreversible decline, until destination reputation, entity resolution, and product/MCC evidence are corroborated.

## Production gates

1. Unit and contract tests pass, including SSRF ranges, redirect chains, DNS rebinding controls, robots rules, size/time limits, malformed HTML/JSON-LD, and provider failure behavior.
2. Isolated browser and provider workers pass a security review and cannot reach Azure metadata, private RFC ranges, the API control plane, or unrelated secrets.
3. Acquirer/compliance owners approve the prohibited-business taxonomy, MCC map, thresholds, and country policy-pack versions.
4. Legal/privacy owners approve source terms, social-data handling, retention, deletion, and cross-border processing.
5. Load tests prove queue back-pressure, per-domain rate limiting, idempotency, retries, and cost limits.
6. Observability covers completion, partial coverage, provider latency/rate limits, crawl blocks, decision eligibility, and purge failures without logging sensitive content.
7. A shadow-mode evaluation measures false positives/negatives against a labelled merchant set before any automated decisioning.
8. Only after these gates: deploy to a non-production Azure environment, run controlled test merchants, obtain sign-off, and separately authorize production rollout.
