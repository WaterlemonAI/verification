# Flo Option 1: developer implementation guide

For the multi-flow upgrade, Supplier Onboarding v1 implementation and remaining release gate, see [Flo import readiness](import-readiness/README.md).

For the isolated non-production deployment and controlled provider run, see [Flo staging](staging/README.md).

**Source of truth:** `WaterlemonAI/verification` production base, `origin/main` at `3f5fc64e4791a10c7b7dfe0440b0a18d15f085cf` (inspected 2026-11-09). Rebase and recheck this map if `main` moves. This guide records the baseline and the implementation in this worktree; Flo is not present in the pinned production commit. The local `supplier-portal/` prototype and the separate `WaterlemonAI/kyc` repository are not the deployment base.

### Implementation and rollout status

The worktree now contains a code-owned registry for `kys-v1` and `supplier-onboarding-v1`, per-flow admin publication and workspace configuration, flow-scoped idempotent link creation, version/hash-pinned cases, separate supplier bundles, and an explicit supplier-safe API projection. Supplier Onboarding v1 has the five-step journey, conditional server rules, extracted-input checks, stakeholder discovery, report and signed callback. Both flows share the encrypted Flo store and queues, buyer Case Manager and perpetual case retention. The served API contract is `api/flo-openapi.json` at `/flo/openapi.json`. The sections below preserve the original Option 1 design context; the import-readiness guide records the subsequent two-flow implementation.

The signed-in Flo buyer page can create a link for a published flow enabled in its workspace. An organization administrator selects `supplier-onboarding-v1`, enters a customer reference and supplier email, and receives the case ID and one-time supplier URL. This portal action uses the same Flo billing, idempotency and email attempt as `POST /flows/{flowId}/links`, with portal session and CSRF protection instead of a browser-held customer API key. An idempotency replay returns the existing case ID without the one-time URL.

`FLO_ENABLED` remains **false** by default. Before enabling it for live data, provision `infrastructure/api-flo-platform.bicep` in the existing private storage account; verify private networking and managed-identity Blob/Table/Queue access; create distinct Key Vault secrets for `flo-data-key-v1`, `flo-session-hash-key-v1`, `flo-callback-signing-key-v1` and `flo-gemini-api-key`; configure the Flo DNS records and certificate; verify ClamAV and the existing OCR/Ejari/provider adapters in the target environment; set the Flo module price and assign selected workspaces. The deployment workflow accepts `FLO_ENABLED` and `FLO_CERTIFICATE_RESOURCE_ID` but does not provision those prerequisites automatically.

The Ejari check runs when the existing Ejari platform is configured and the supplier provides a PDF. VAT, board-resolution and bank-letter authenticity checks remain `not_run` until documented adapters exist; a bank-letter extraction and IBAN match do not attest authenticity. Live provider, private-network, DNS/TLS, email and callback delivery gates still require a staged environment run. The repository tests use synthetic evidence and stubbed providers.

## Outcome and shortest route

Deliver reviewed, code-owned onboarding flows inside the existing KYCProbe API Container App. A platform administrator publishes a reviewed flow version and enables it for a named customer workspace. The customer uses its server-side KYCProbe API key to create a unique supplier link. The supplier completes the hosted journey at `https://flo.ai7uae.com`; KYCProbe runs document extraction, verification, screening, cross-document checks and Gemini review; the customer's **Flo Case Manager** receives the complete case, reports and decision history. Status and complete structured results are returned through authenticated customer APIs and a configured, signed callback. A submitted supplier sees the configured success page; an uncompleted or invalid journey follows the configured failure route only when applicable. A buyer's later **Accept** action changes the case status to `accepted` and emits a separate decision event.

Use the current Node 22 server, workspace identity, customer API-key gate, module entitlements, admin and portal shells, Azure managed identity, private Blob/Table/Queue patterns, OCR jobs, verification adapters, SMTP mailer and `pdf-lib`. Do **not** create a second API service, a generic drag-and-drop flow builder, or an arbitrary HTML/JavaScript upload mechanism for the first release. The platform admin's “create Flow” action publishes a reviewed template with an immutable version and unique ID; it does not execute customer-supplied HTML. This is the shortest way to deliver the diagram's lifecycle without exposing credentials or creating a shared-origin script injection path.

### Production baseline and gaps

| Existing production component | Reuse | Gap for Flo |
|---|---|---|
| `server.mjs` | API-key gate, portal/admin sessions, host routing, provider execution | No Flow routes, Flo host, link/session handling or Flo case operations |
| `lib/forms.mjs`, Forms queue and report | JSON check mappings, qualification rules, job patterns | No uploaded files, repeated stakeholders, supplier session or immutable end-to-end KYS snapshot; do not expand Forms into Flo |
| Document OCR store/worker | Existing OCR contracts and async processing | Flow must submit/poll jobs internally and retain its own source copy and final result beyond OCR source expiry |
| `lib/case-manager-*` and `/cases` | Security and storage design reference | Existing Case Manager is opt-in, has 1–45 day TTL, a 30-day OCR cap and a 45-day search window; **do not store Flo cases in it** |
| Admin module assignment and customer usage | Entitlement, pricing, workspace identity | Flo template/configuration, explicit customer enablement and one Flo billing rule |
| Private Case Manager Azure account | Private network and managed-identity data-plane pattern | Separate Flo Table, Blob container and Queue names; independent Flo feature gate and key |
| `api.ai7uae.com`, `app.kycprobe.com` | Existing customer API and buyer portal hosts | DNS, TLS and strict host routing for `flo.ai7uae.com` |

## Product contract

1. **Platform setup.** Admin publishes `kys-v1` at an immutable template version, sets its availability and assigns it to a customer workspace. Customer-specific branding, completion URLs and callback destination are saved as validated workspace settings. A workspace must have both explicit Flo assignment and an enabled Flow configuration. The existing legacy `allowed_modules: ["*"]` must **not** silently enable Flo for every old workspace.
2. **Create link.** `POST /flows/kys-v1/links` accepts the customer's Bearer key, an idempotency key, customer reference, supplier email, optional prefill, branding asset reference and allowlisted redirect/callback configuration references. Return `application_id`, opaque supplier URL, status URL and expiry. One idempotency key creates one application. Create the Flo case **at this point**, before the supplier opens the link.
3. **Supplier journey.** On the Flo host, redeem the link for a short-lived, host-only `Secure; HttpOnly; SameSite=Lax` session. Rotate the one-time link secret, use CSRF protection for writes, and prevent access to other application IDs. Gather mandatory fields and documents first, then show extracted/verified values for correction/confirmation. Save drafts and each document independently so retries do not require a giant multipart request. An expired link/session blocks further supplier writes but does **not** delete its case.
4. **Processing.** Enqueue only `{workspace_id, application_id, job_type, attempt}`. Workers load sensitive data from private storage, use internal provider functions rather than calling the public API with a hidden customer key, and checkpoint each extraction/check. Run company and stakeholder AML/adverse-media checks separately. Preserve raw provider responses, HTTP status, timestamps, input hashes, coverage and reason codes. A failed/unavailable check becomes `could_not_complete`/`not_run`, never `passed`.
5. **Gemini.** Give Gemini bounded, labelled evidence and a fixed JSON schema for document extraction gaps, entity triangulation, mismatches and narrative. Treat all document/provider text as untrusted data. The deterministic review engine validates dates, licence/IBAN match rules, required documents and check completeness independently. Gemini cannot change an API failure or mismatch into a pass or make the final acceptance decision. Store request schema/version, model ID, sanitized output, validation errors and evidence references in the case.
6. **Report and case.** Generate “Business Onboarding & Due Diligence Report” for every submitted application, including partial/failed ones. It includes business identity, company type and activities, TL status, organisation chart, shareholders/UBOs, signing authorities, document inventory, source-to-source triangulation, API/Gemini check matrix, risk profile, IBAN status and complete adverse-media responses per entity and stakeholder in a clearly marked, fully paginated appendix. Define the HTML structure first, then render HTML and PDF from one typed report model; `pdf-lib` draws the PDF without needing a browser binary in the API container. Use deterministic fields and escaped content; Gemini supplies only labelled narrative/issue JSON. Keep HTML, PDF and full JSON behind workspace-authenticated Flo case endpoints, with hashes and versioned snapshots.
7. **Buyer decision.** Supplier submission and report generation set `pending_review` or `needs_correction`; only an authorised buyer action can set `accepted` or `rejected`. Record actor, time, previous/new status, rationale and report version in an append-only audit trail. Do not equate a Gemini recommendation with acceptance.
8. **Callback and redirects.** Configure callback destination and success/failure origins in the customer workspace, not in supplier input. Deliver signed, idempotent events for submitted/review-ready/accepted/rejected/failed states with stable event IDs, application ID, status and complete structured application/check/results JSON. Include authenticated document/report references rather than embedding binary files. Save delivery attempts and replay safely. Redirects are browser UX; callbacks are the system-of-record notification. A callback failure never changes the case decision.

### Flo Case Manager and retention

- Flo Case Manager is **on by default whenever Flo is explicitly enabled for a workspace**. It has its own UI, routes, storage schema and access checks. No customer opt-in, 1–45 day TTL, or generic `/cases` policy applies.
- There is **no automatic expiry or purge of Flo cases** in this release. Store `expires_at: null` for cases (or omit it); do not use a distant sentinel date. Retain drafts, submitted fields, original uploaded documents, final extraction/API/Gemini responses, report versions, callbacks and decision/audit events. Never rely on existing OCR's 30-day source store, temporary signed URLs or public PDF capability URLs as the retained record.
- Link, supplier session, temporary job and callback-retry tokens can expire. Their expiry must not make a retained case unreadable. Search may default to recent cases in the UI, but must permit older history without a 45-day API limit.
- Use separate `FloCases` metadata Table, private `flo-evidence` Blob container and `flo-jobs`/`flo-callbacks` Queues in the existing private UAE North storage account if its private network and managed-identity path is active. Names, IDs and statuses only belong in Table/Queue; documents and full responses belong in encrypted Blob objects. Use a dedicated versioned Flo data key in Key Vault. Do not reuse the generic Case Manager encryption key or its expiry index.
- Perpetual retention is the current product setting, not a reason to remove access controls, audit logging, backups/key-rotation planning or future explicit deletion capability. Do not add an Azure lifecycle deletion rule for Flo. A later retention-policy migration requires a separate design and approval.

### Minimum API contract (finalise JSON schemas before coding)

| Caller / host | Route | Purpose |
|---|---|---|
| Platform admin / `app.kycprobe.com` | `GET/PUT /admin/api/flows/kys-v1` | Publish/disable immutable template version and inspect metadata; no HTML upload |
| Platform admin / `app.kycprobe.com` | `GET/PUT /admin/api/customers/{workspaceId}/flo` | Explicitly enable customer and configure branding, allowed redirect origins and callback |
| Customer server / `api.ai7uae.com` | `POST /flows/kys-v1/links` | Create link and durable case; Bearer key + idempotency key |
| Customer server / `api.ai7uae.com` | `GET /flows/applications/{id}` and `/report` | Status, full JSON and authenticated report retrieval; workspace scoped |
| Supplier browser / `flo.ai7uae.com` | `GET /f/{token}`; `POST /flo/api/session`, `/draft`, `/documents`, `/submit` | Redeem link, save form/upload, submit under supplier session; no API key in browser |
| Signed-in buyer / `app.kycprobe.com` | `GET /portal/api/flo/cases`, `GET /portal/api/flo/cases/{id}`, document/report URLs | Flo case list, evidence and report; workspace scoped |
| Signed-in buyer / `app.kycprobe.com` | `POST /portal/api/flo/cases/{id}/decision` | Accept/reject with CSRF and role check; idempotent transition |

Implement versioned response schemas in `api/openapi.json` (or a separately served `api/flo-openapi.json` if the combined document becomes unwieldy). Use opaque UUIDs for public application IDs, random high-entropy link tokens stored only as hashes, and explicit response statuses: `link_issued`, `in_progress`, `submitted`, `processing`, `needs_correction`, `pending_review`, `accepted`, `rejected`, `failed`, `link_expired`. Define which transitions are allowed. Return 202 while processing; a 2xx transport never implies a clean business result.

### Canonical case and evidence model

Before wiring adapters, agree one canonical object shape and keep the raw responses beside it:

| Record | Minimum fields |
|---|---|
| Application | `application_id`, `workspace_id`, `flow_id`, `template_version`, `customer_reference`, `status`, `created_at`, `submitted_at`, supplier session and link state |
| Document | `document_id`, type, claimant, encrypted Blob reference, SHA-256, MIME, scan result, upload time, extraction state, source version |
| Fact | field path, value, document/API source ID, source page or response path, extraction method, observed time, confidence/quality flag, confirmation or correction history |
| Subject | stable ID, entity/person type, name/aliases, declared role, ownership percentage, relationship to parent entity and source references |
| Check | subject ID, service ID and version, request fingerprint, start/end times, HTTP status, transport, coverage, eligibility, business result, reason codes, raw response reference |
| Comparison | left/right fact IDs, rule version, normalized values, score where applicable, outcome, reason and reviewer override history |
| Report/decision/event | versioned PDF and JSON references/hashes, Gemini schema/model version, risk signals, actor, status transition, callback delivery ID and timestamp |

Build an explicit cross-map: licence/formation name and number against MOA/AOA, tax and bank documents; shareholder names and percentages across corporate documents and ID documents; signatory authority across MOA/AOA/POA/board resolution; registered and operating addresses against Ejari/utility evidence; bank account owner/name/IBAN against the bank letter and IBAN API; and each screened subject against its own AML/adverse-media response. Record `match`, `mismatch`, `partial`, `unavailable` or `not_applicable`, never a silent blank. The agreed **70% tenant-name threshold applies to the Ejari-versus-trade-licence name comparison only**; do not apply it globally to legal names or ownership. Entity triangulation requires positive source links, not Gemini prose alone.

## File-by-file change map

Paths below are relative to this production repository. “Required” means the file is part of the smallest complete **code-owned KYS Flow** implementation. Do not copy the untracked prototype into the container.

### Existing files to update

| File | Required change |
|---|---|
| `server.mjs` | Mount Flo admin/customer/supplier/buyer routes; add explicit host dispatch before static fallback; add Flo module to catalog and customer API admission; inject existing JSON check executor and OCR dependencies into Flo worker; keep supplier routes isolated from portal/admin/service routes on the Flo host. |
| `lib/platform-mail.mjs` | Add supplier link and confirmation templates; allow only the configured Flo origin for supplier action URLs. Existing `safeActionUrl` permits only `app.kycprobe.com`. |
| `admin-site/index.html` | Add Flo template/assignment and customer configuration panels. |
| `admin-site/admin.js` | Load/publish `kys-v1`, assign to a workspace, save validated branding/redirect/callback settings; display enabled state. Existing customer module pricing UI can remain the assignment mechanism. |
| `admin-site/admin.css` | Style the added Flo panels using existing admin conventions. |
| `api-site/portal-auth.js` | Protect `/flo`, add Flo navigation/context, show it only for explicitly enabled customer workspaces; do not gate it on generic Case Manager settings. |
| `api/openapi.json` | Publish customer link/status/result/report and buyer operations with auth, idempotency and callback schemas. |
| `Dockerfile.api` | Copy `flow-site/` into the existing API image. No new Node dependency is required for the first release. |
| `infrastructure/api.bicep` | Add Flo feature gate, storage URLs/table/container/queue names, dedicated Key Vault data/signing secrets, `FLO_PUBLIC_BASE_URL`, Flo certificate/custom domain, and a fail-closed ClamAV path for supplier uploads. Do not tie Flo availability to `CASE_MANAGER_ENABLED`. |
| `infrastructure/api-dns.bicep` | Add `flo` CNAME and `asuid.flo` TXT records in `ai7uae.com`. |
| `.github/workflows/api-pr-checks.yml` | Include `flow-site/**`, Flo Bicep and documentation path; syntax-check browser JS and build the Flo Bicep; run Flo tests/smoke. |
| `.github/workflows/deploy-api.yml` | Include Flo paths in triggers; validate Flo Bicep and pass Flo gate, storage and certificate parameters in both what-if and deploy commands. Keep private-storage provisioning a separate reviewed step. |
| `.env.example` | Document non-secret Flo host, flags and storage names; use placeholders for secrets. |
| `README.md` | Link to this guide and identify Flo as a separate module/Case Manager. |

**Conditional existing-file edits:** Touch `lib/customer-usage.mjs` only if the agreed billing rule cannot be expressed as one `flo` module charge per new application through the existing module catalog/admission path. Touch `lib/case-manager-crypto.mjs` only if extracting a generic, injected-key envelope helper is demonstrably smaller than a dedicated Flo crypto module; never change the generic Case Manager's key or TTL semantics. Touch `api-site/api.css` only if the new buyer page cannot use its own `flo.css`. Touch `lib/forms.mjs`, `lib/forms-queue.mjs`, `lib/forms-submission-store.mjs`, generic `lib/case-manager-*`, `api-site/cases.*` and `api-site/account.*` **only when a concrete dependency requires it**; Flo must not inherit their schema or retention. No `package.json`/lockfile change is expected if the existing Azure SDK, `sharp` and `pdf-lib` suffice.

### New files to create

| File | Responsibility |
|---|---|
| `lib/flows/definition.mjs` | Versioned, fixed `kys-v1` stages, mandatory/conditional documents, field and check catalog. |
| `lib/flows/contract.mjs` | Link/config/submission validation, status transitions, schema versions, allowlisted callback/redirect origins. |
| `lib/flows/store.mjs` | Workspace-scoped Table indexes and encrypted Blob objects for case, documents, results, report versions, events and configuration; idempotent create/update. |
| `lib/flows/crypto.mjs` | Versioned AES-GCM envelope for Flo JSON and binary evidence using the dedicated Key Vault key; hash and integrity helpers. |
| `lib/flows/session.mjs` | One-time link redemption, hashed tokens, supplier cookie, CSRF, expiry and replay defence. |
| `lib/flows/routes.mjs` | Admin/customer/supplier/buyer route handlers, role and workspace authorization, file limits and safe downloads. |
| `lib/flows/queue.mjs` | ID-only job and callback queue messages; bounded retry/dead-letter handling. |
| `lib/flows/processor.mjs` | Checkpointed orchestration, OCR-job submission/polling, entity and stakeholder fan-out, Gemini review, report and callback scheduling. |
| `lib/flows/checks.mjs` | Input mapping and deterministic normalization for TLV, IBAN, Ejari, entity search/AML, adverse media, merchant/website and available OCR; explicit unavailable results. |
| `lib/flows/gemini.mjs` | Structured extraction/review prompt, schema validation, source-reference limits and prompt-injection resistance. |
| `lib/flows/report-model.mjs` | Typed report sections, organogram graph, check matrix, document inventory and complete adverse-media appendix from stored evidence. |
| `lib/flows/report-html.mjs` | Escaped, printable HTML structure for the buyer's in-system report view; no model-authored HTML. |
| `lib/flows/report-pdf.mjs` | Paginated `pdf-lib` PDF renderer from the same model, including every adverse-media response. |
| `lib/flows/callback.mjs` | Configured HTTPS destination validation, signed complete JSON event, stable IDs, delivery/retry ledger. |
| `flow-site/index.html`, `flow-site/app.js`, `flow-site/styles.css` | Hosted supplier journey for mandatory input/upload, extracted/verified review, corrections, errors and completion. |
| `api-site/flo.html`, `api-site/flo.js`, `api-site/flo.css` | Flo Case Manager list/detail/decision/report UI on `app.kycprobe.com`; customer link creation uses the server-side API key route. |
| `infrastructure/api-flo-platform.bicep` | Create Flo child Table/container/queues in the existing private storage account; verify required private path and identity access, without modifying the generic Case Manager's data. |
| `test/flo-contract.test.mjs`, `test/flo-store.test.mjs`, `test/flo-routes.test.mjs`, `test/flo-processor.test.mjs`, `test/flo-report.test.mjs`, `test/flo-callback.test.mjs`, `test/flo-gemini.test.mjs`, `test/flo-end-to-end.test.mjs` | Focused contract, isolation, retention, recovery, prompt-injection, PDF, callback and synthetic lifecycle tests. |
| `scripts/smoke-flo-ui.mjs` | Desktop/mobile supplier and buyer smoke journey with synthetic documents and stubbed providers. |
| `docs/flo/README.md` | This source-pinned engineering handoff; update it when route/schema/storage choices change. |

If production OCR submission logic cannot be called safely from `lib/flows/processor.mjs`, extract only the shared job-enqueue function into a new `lib/document-ocr-service.mjs` and change its call site in `server.mjs`. Do not create an internal HTTP call authenticated with a hidden customer API key. Likewise, inject the existing JSON check executor into the Flo worker before extracting it into a new shared module; refactor only when tests show the direct injection is inadequate.

## Security and data rules

1. **Origin isolation:** `flo.ai7uae.com` serves only the supplier app and `/flo/api/*`; reject `/admin`, `/portal`, `/service`, `/flows` and arbitrary static paths there. The buyer portal stays at `app.kycprobe.com`; customer server APIs stay at `api.ai7uae.com`. Do not merely add Flo to the generic `API_HOSTS` set and inherit its static fallback.
2. **Credentials:** customer and provider API keys live server-side/Key Vault only. Supplier HTML, JavaScript, URLs, logs, callbacks and report content never contain credentials. Use different secrets for Flo data encryption, link/session signing and callback signing. Rotate by version, retaining old decrypt keys for perpetual records.
3. **Uploads:** accept a narrow PDF/PNG/JPEG MIME and signature allowlist, enforce per-file and per-case limits, scan with the existing ClamAV helper and fail closed if scanning is unavailable. Store encrypted original bytes in Flo before requesting OCR. Render document text as escaped text only; never evaluate embedded HTML, JavaScript or PDF actions.
4. **External URLs:** use configured HTTPS redirect/callback destinations only; prohibit credentials, fragments and private/resolved-local IPs; re-resolve/validate on delivery to prevent DNS rebinding. Save configuration history in the case. A supplier cannot override destinations. A webhook.site URL is a test fixture, not a production default.
5. **AI boundary:** fixed developer instructions and response schema; document text is quoted as evidence, not instructions. Strip or reject model output outside schema, fabricated source IDs, URLs, HTML and unsupported claims. Every report statement must trace to a stored document field or API result. Deterministic hard-fail/missing-check gates outrank Gemini narrative.
6. **Access and audit:** enforce workspace scope before every case/document/report read. In the first release, require `org_admin` for full Flo case/evidence/report access and accept/reject; customer API keys can create links and read only their owning workspace's API results. Record decisions and sensitive downloads without logging names or document text. Add request IDs and sanitized operational errors.
7. **Callbacks:** HMAC-sign the exact body and timestamp, support replay protection and idempotent event handling, send full JSON only to a pre-registered workspace destination, and offer authenticated document/report download. Store callback secrets encrypted; do not place them in queue messages.

## Implementation sequence

1. **Freeze contracts and fixture policy.** Define `kys-v1` required/conditional fields and documents, each check's exact input mapping, the Flo billing event, status transitions, JSON schemas and report sections. Use synthetic documents for repository tests. Treat unavailable VAT/board-resolution/bank-letter authenticity endpoints as `not_run` until documented; Gemini extraction and an IBAN API match are not proof that a bank letter is authentic. The TLV verification call must use only business name and licence number.
2. **Provision isolated Flo storage and key.** Implement/store-test the Flo case at link creation; encrypted documents and result snapshots; old-case listing; no expiry/purge. Bicep should add child resources to the existing private account, with an independent gate. Verify private endpoint access, RBAC and key rotation path before using real data.
3. **Implement admin assignment and link API.** Seed/publish the fixed template, explicitly assign a customer, validate per-workspace destinations/branding, meter one new application, enforce idempotency and issue a single-purpose link. Return the same case on a replay; do not rebill or duplicate it.
4. **Implement hosted supplier journey.** Add Flo DNS/TLS/host dispatcher and static app. Add secure link redemption, drafts, per-document upload/scan and confirmation. Complete mandatory information first; display extracted and verified fields afterwards with evidence and correction controls.
5. **Implement worker and checks.** Reuse existing provider execution where safe; checkpoint each document/check and repeat stakeholders separately. Run TLV with only business name/licence number; compare Ejari tenant/business/address with the configured name-match threshold; extract bank-letter business/bank/IBAN with Gemini, verify IBAN via KYCProbe, and keep the original bank letter. Preserve full adverse-media response for each screened subject. Never infer a successful API call from HTTP 200 alone.
6. **Implement review and report.** Add deterministic triangulation and Gemini structured review. Build the HTML structure and PDF from the same stored typed model with organogram, source/evidence citations, complete screening appendix and unavailable-check section. Generate a new version after a material correction; keep previous versions and their hashes. Test HTML/PDF section and value parity.
7. **Implement buyer Case Manager and callback.** Make Flo history visible by default to enabled workspaces, wire case detail/evidence/report/decision actions and signed events. Ensure callback retries do not duplicate acceptance or report generation.
8. **Release.** Run `npm ci`, `npm test`, syntax checks, Flo UI smoke and Bicep build. Run a full synthetic end-to-end scenario through the hosted UI, including upload, check failure, Gemini mismatch, report, buyer acceptance and callback retry. Validate app/api/flo host isolation and that a case remains readable after link expiry and after the generic Case Manager's 45-day window. Deploy storage and certificate prerequisites before enabling Flo in the protected API deployment; use an explicit runtime gate for rollout and rollback, while leaving stored cases intact.

## Acceptance gates

- An explicitly enabled customer creates one link/case with a server-side key; a wildcard-only legacy workspace cannot.
- Supplier browser contains no customer/provider key. Expired/replayed link cannot create another case or access another workspace.
- Mandatory uploads are scanned, encrypted and retained in Flo; the entire journey works with multiple stakeholders and independent adverse-media/AML results.
- Every check has `completed`, `partial`, `failed` or `not_run` transport/coverage status plus its raw result; missing document/provider outages are visible in JSON, UI and PDF.
- Gemini rejects document-borne instructions and unsupported references; deterministic mismatches/expiry cannot be overridden by model prose.
- Case is durable from link issuance; report is automatic after submission; buyer acceptance is a separate, auditable action.
- Full structured callback is signed, retryable and workspace configured; full documents and PDF are accessible only through authenticated, workspace-scoped URLs.
- Flo cases and evidence remain readable without automatic TTL, even if generic Case Manager is disabled; generic Case Manager behavior and tests are unchanged.
- `flo.ai7uae.com` has valid DNS/TLS and cannot serve customer/admin APIs; `app.kycprobe.com` cannot redeem supplier links.

## Explicitly out of this first release

Arbitrary uploaded Flow HTML/JS, a generic flow builder, a second API deployment, migration/backfill of old prototype cases, invented provider endpoints, automatic buyer acceptance, and a customer-controlled Flo retention toggle. Those can be separately designed after `kys-v1` runs end to end on the production base.
