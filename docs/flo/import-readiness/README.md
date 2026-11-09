# Flo import readiness: prerequisite for Supplier Onboarding v1

**Audit target:** the implemented Flo Option 1 code in this worktree, based on `origin/main` commit `3f5fc64e4791a10c7b7dfe0440b0a18d15f085cf`, inspected 2026-11-09. **Source workflow:** the untracked local prototype at `/Users/zainabkhan/Documents/ChatGPT/verification/supplier-portal/`. Recheck this map after either source changes. This is an implementation handoff, not a claim that the new flow is deployed.

## Implementation status in this worktree

Gate A and the tracked Gate B code are implemented: a static two-flow registry, per-flow publication and workspace configuration, version/hash-pinned cases and bundle routing, flow-scoped idempotency, supplier-safe application projection, Supplier Onboarding v1 server rules, five-step bundle, extracted-input preview checks, subject discovery, reports and signed callback data. The Flo buyer module now also lists enabled flows and creates a metered, one-time Supplier Onboarding v1 link through the signed-in organization administrator's portal session; no customer API key enters the browser. The original `kys-v1` route and legacy storage lookups remain supported. The tables below record the original audit and implementation plan; their “current implementation” findings describe the pre-upgrade code.

Synthetic verification passed: the prior full run reported 372 repository tests and Bicep builds for the API, Flo storage and DNS. After adding buyer-portal link creation, 25 focused Flo tests and both supplier bundles and buyer UI at desktop/mobile widths passed. The full repository suite was not rerun for that addition. `FLO_ENABLED` remains false by default, and `supplier-onboarding-v1` is unpublished and disabled for every workspace by default. The staged provider/storage/browser/callback run with controlled documents, target-environment secrets, DNS/TLS and explicit workspace enablement is still required before live use. VAT verification, board-resolution authenticity and bank-letter authenticity remain explicitly `not_run` where no documented provider contract is configured; extraction or a model narrative does not turn those into a pass.

## Decision

**Yes: upgrade Flo before importing a distinct flow.** The present implementation can run its fixed `kys-v1` template in tests, but it cannot register, version, assign, render, validate or process a second template independently. Replacing `kys-v1` in place is a shorter one-off edit, but it would not meet the requirement to move future flows into Flo. The shortest reusable approach is a **code-owned template registry** in the existing API service, with one published definition and version per flow. Keep `kys-v1` as the compatibility template; add `supplier-onboarding-v1` as the first new template. Do not accept uploaded HTML/JavaScript as executable flow content: it would create a shared-origin script and key-exposure risk. Reviewed HTML/JS assets can ship in the API image and call only the protected Flo browser API; customer and provider credentials stay server-side.

Flo is still off by default and has not been deployed. The local workflow source is untracked in another worktree, so CI cannot build from it until its vetted logic and synthetic fixtures are ported into tracked production files.

## Evidence from the current implementation

| Area | What exists | Why it blocks another flow or real-data import |
|---|---|---|
| Definition and validation | `lib/flows/contract.mjs` exports one `FLOW_ID = 'kys-v1'`, a fixed draft allowlist and fixed submission gaps; `definition.mjs` exports one definition. | A supplier-specific field or document is rejected, and a second flow cannot have its own requirements. |
| Publication, assignment and case version | `store.mjs` stores one template at `platform/kys-v1`, one workspace config and a hard-coded case flow ID/version. It stores a version string, but not a frozen definition/configuration reference for the published rules. | New templates can collide or drift; the same workspace cannot independently enable/configure two flows. |
| Idempotency | Both memory and Azure stores hash `workspaceId:idempotencyKey`. | The same customer request ID used for two different flows can conflict. Scope idempotency by workspace **and flow ID** while preserving replay within one flow. |
| Routes and frontend | `routes.mjs` recognizes only `/flows/kys-v1/links` and `/admin/api/flows/kys-v1`; `server.mjs` bills that fixed path and serves one `flow-site` bundle. | A customer cannot request a link for another flow; the supplier link cannot resolve to the correct journey. |
| Supplier data exposure | `publicCase()` in `routes.mjs` removes a few secrets, then returns almost the whole case. Supplier `GET /flo/api/application` uses it. | After processing, the supplier can receive raw AML/adverse results, internal checks, audit events and other buyer-only fields. This is a **P0 access boundary fix** before real data is used. |
| Processing | `processor.mjs` uses fixed OCR/check mappings and checks user-entered licence/IBAN data after submit. Preview only extracts documents and triangulates. | The prototype's extracted-value checks, full pre-submit review and additional document types cannot run under the current dispatcher. |
| Buyer output | `callback.mjs` sends structured checks and report references, but omits `gemini_review`; report code produces a basic report. | The requested complete application summary and bank-grade Supplier Onboarding report would be incomplete. |

The focused Flo tests currently pass (16/16); the local prototype tests pass (44/44). These show the existing contracts work in isolation. They do not establish multi-flow support or staged provider success. The full 364-test result was reported by the implementer and was not rerun for this audit.

## Gate A — platform work required before **any** second flow is imported

Use one shared Flo case store, queue, host and API deployment. Treat a template as a reviewed, immutable code package: `{flow_id, version, definition, validateDraft, submissionGaps, allowedDocumentTypes, process, supplierBundle}`. The registry must select the exact published version saved on the case. An old version stays executable/readable for its perpetual cases until an explicit migration is built. Reject an unknown or disabled flow before charging or creating a case.

### Existing files to update

| File | Required change |
|---|---|
| `lib/flows/contract.mjs` | Keep common status, URL, link and configuration validation; move KYS-specific draft and gap rules into a KYS template adapter. Validate the requested flow ID/version and prevent a template from claiming arbitrary browser asset paths. |
| `lib/flows/definition.mjs` | Preserve `kys-v1` as a versioned code-owned definition; export it through the new registry rather than as the single global flow. |
| `lib/flows/store.mjs` | Add `flowId`/published `version` to template and workspace-config keys, link creation and case creation. Scope idempotency by `(workspaceId, flowId, idempotencyKey)`. Freeze the version, definition hash and effective workspace config on each case. Keep old cases and evidence readable; do not add a TTL. Migrate the existing `kys-v1` template/config keys or provide an explicit backward-compatible lookup. |
| `lib/flows/routes.mjs` | Route `/admin/api/flows/:flowId`, per-flow workspace settings and `/flows/:flowId/links` through the registry. Dispatch draft validation, document allowlist, submission gaps and preview by the case's saved template version. Separate supplier, customer API and buyer projections. Supplier JSON must expose only their draft, uploaded-document metadata, safe extracted/verified display fields, actionable errors and status. Raw screening responses, internal events, audit/callback state and buyer decisions stay out of supplier JSON. Preserve workspace and host checks. |
| `lib/flows/processor.mjs` | Dispatch preview/process by saved flow ID and version; keep the existing KYS pipeline as its adapter. Record an explicit unsupported-version failure, never silently run the latest rules against an old case. |
| `server.mjs` | Resolve the requested flow for billing/entitlement and serve the matching code-owned supplier bundle on `flo.ai7uae.com`. Do not widen the Flo host to customer/admin APIs. Bill one newly created case; a replay must remain refunded. |
| `flow-site/index.html`, `flow-site/app.js`, `flow-site/styles.css` | Keep these as the `kys-v1` bundle or move them under a versioned bundle directory, then make assets resolve by saved flow/version. No runtime HTML upload or user-provided script execution. |
| `admin-site/index.html`, `admin-site/admin.js` | List published templates and enable/configure a selected template for a selected workspace, rather than a single global KYS toggle. Only platform admins publish code-shipped versions. |
| `api-site/flo.html`, `api-site/flo.js` | Show flow identity/version and allow a buyer to filter cases by flow; keep the current workspace-scoped case and decision access. |
| `api/flo-openapi.json` | Document `:flowId`, per-flow enablement/configuration, version semantics, idempotency scope, supplier-safe response and customer/buyer result response. |
| `test/flo-contract.test.mjs`, `test/flo-store.test.mjs`, `test/flo-routes.test.mjs`, `test/flo-processor.test.mjs`, `test/flo-end-to-end.test.mjs`, `scripts/smoke-flo-ui.mjs` | Extend the existing cases to exercise two enabled flow IDs and both supplier bundles without weakening current KYS behavior. |

### New platform files to create

| File | Purpose |
|---|---|
| `lib/flows/registry.mjs` | Static allowlist of reviewed flow IDs and immutable versions, with lookup by exact `(flow_id, version)` and the asset bundle path. Seed it with `kys-v1`. |
| `lib/flows/templates/kys-v1.mjs` | Adapter wrapping the present KYS validation, document list and processing so the existing flow remains compatible. |
| `lib/flows/projections.mjs` | Explicit allowlist serializers for supplier, customer API and buyer views. Default-deny newly added case properties. |
| `test/flo-registry.test.mjs` | Unknown/disabled/versioned template behavior; old-version resolution after a new version is published. |
| `test/flo-projections.test.mjs` | Synthetic raw AML/adverse, audit and secret fields are absent from supplier JSON and present only where authorized. |
| `test/flo-multi-flow.test.mjs` | Two flows in one workspace: independent assignment/configuration, same idempotency key without collision, correct bundle, version pin, correct processor, callback and report identity. |

**No new service, database, npm dependency, Bicep resource or deployment workflow is needed for this gate** if the new code and assets stay under the already copied `lib/` and `flow-site/` directories. `Dockerfile.api` already copies both; `.github/workflows/deploy-api.yml` already watches both. Recheck this if the implementation changes packaging or adds storage types. The existing Key Vault, private storage, DNS/TLS and staged-provider rollout in `docs/flo/README.md` remain required before live enablement.

## Gate B — port the local workflow as `supplier-onboarding-v1`

After Gate A, port the **behavior**, not the prototype server. Source files: `supplier-portal/index.html`, `app.js`, `styles.css` for the five-step journey; `server.mjs` `required()` for conditional answers/documents; `review-engine.mjs` and `screening-summary.mjs` for deterministic comparisons and subject discovery; `gemini-manager.mjs` for bounded extraction/review schemas; `due-diligence-report.mjs` and `DUE_DILIGENCE_REPORT_SPEC.md` for report structure. The prototype's `kycprobe-client.mjs`, `evidence-store.mjs`, `webhook-delivery.mjs` and `report-service.mjs` are **references only**: use Flo's internal provider adapters, encrypted Azure store, signed callback and packaged PDF renderer. Do not port the local test webhook or its hard-coded macOS Chrome command. Do not check in real passports, bank letters, credentials or provider responses containing personal data.

### Existing files to update for this flow

| File | Supplier Onboarding v1 work |
|---|---|
| `lib/flows/processor.mjs` | Add a versioned supplier adapter hook (or keep only the registry dispatch here). OCR trade licence, incorporation, MOA, AOA, identity, premises and authority documents where a documented provider exists; distinguish extraction from authenticity. Derive TLV input from the extracted business name and licence number, passing only those two fields. Extract business name/bank/IBAN from the bank letter with Gemini, then call KYCProbe IBAN verification and triangulate account holder. Record missing, failed and undocumented checks explicitly. |
| `lib/flows/checks.mjs`, `lib/flows/triangulation.mjs` | Reuse shared provider and evidence primitives, with supplier-specific mapping in the new adapter. Screen entity plus every deduplicated, discovered or declared relevant stakeholder; retain each full adverse-media response. Match names, licence, ownership/authority, premises, VAT, bank and expiry across documents and APIs. A 70% Ejari tenant/business-name threshold is a review rule, not proof of premises or document authenticity. |
| `lib/flows/gemini.mjs` | Reuse model invocation and guardrails; accept the supplier template's fixed extraction/review schemas. Treat document/provider text as untrusted evidence, validate JSON/source IDs, and prevent Gemini from overriding deterministic mismatches or API failures. |
| `lib/flows/report-model.mjs`, `lib/flows/report-html.mjs`, `lib/flows/report-pdf.mjs` | Add the Supplier Onboarding report model and rendered sections: organisation structure/organogram, UBOs, signing authority, business activity/licence, entity and per-person AML/adverse, IBAN, risk profile, triangulation, required versus provided documents and failed/unavailable checks. Keep complete raw adverse-media JSON in the authorized appendix. Generate and retain versioned HTML/PDF/JSON automatically after every submission or material correction, including incomplete-check cases. |
| `lib/flows/callback.mjs` | Include the structured Gemini review, risk/report summary, coverage/reason codes and flow/version in the signed snapshot. Continue exposing evidence and report through authenticated workspace-scoped retrieval. If the contract literally requires binary documents inside callbacks, design a bounded, signed manifest/chunk delivery protocol and test retries before enabling it; avoid unbounded JSON/base64 payloads. |
| `api/flo-openapi.json`, `admin-site/*`, `api-site/flo.*`, `scripts/smoke-flo-ui.mjs` | Add the Supplier Onboarding template to published-template, link creation, buyer case and UI contracts; test the five-step supplier journey and buyer report. |

### New Supplier Onboarding v1 files to create

| File | Purpose |
|---|---|
| `lib/flows/templates/supplier-onboarding-v1/definition.mjs` | Stable flow ID/version, five stages, fields, conditional document list and check catalogue. Preserve legal-entity versus natural-person branches. |
| `lib/flows/templates/supplier-onboarding-v1/rules.mjs` | Server-side field, document and conditional declaration validation ported from prototype `required()`; never rely on browser `required` alone. |
| `lib/flows/templates/supplier-onboarding-v1/subjects.mjs` | Deduplicated entity/person subject discovery with roles and source references from draft, TL, MOA/AOA, BR/POA and identity; no silent subject truncation. |
| `lib/flows/templates/supplier-onboarding-v1/review.mjs` | Deterministic cross-source rules, expiry checks, API coverage and supplier-correctable issue mapping. |
| `lib/flows/templates/supplier-onboarding-v1/report.mjs` | Supplier-specific typed report model and bounded Gemini narrative fields, consumed by the shared renderers. |
| `flow-site/supplier-onboarding-v1/index.html`, `flow-site/supplier-onboarding-v1/app.js`, `flow-site/supplier-onboarding-v1/styles.css` | Reviewed, code-shipped five-step customer-facing journey. Keep mandatory entry before extracted/verified display and correction modal; call Flo browser APIs only. |
| `test/flo-supplier-onboarding-contract.test.mjs`, `test/flo-supplier-onboarding-end-to-end.test.mjs`, `test/flo-supplier-onboarding-report.test.mjs` | Synthetic conditional form, upload/scan, provider coverage, Gemini mismatch, subject screening, PDF/JSON and callback tests. Port useful prototype test cases without real personal data. |

The prototype includes: business documents and type; representative, authority, UBOs and premises; VAT, corporate tax and bank letter; supply, payments, capacity and declaration; then extracted/verified review and correction. The current Flo form captures only basic business fields, declared stakeholders and a narrower document set. This is a **template-parity task**, not a reason to copy the prototype's entire HTTP server or storage layer.

## Shortest implementation sequence

1. **Fix the supplier projection first.** Add `projections.mjs`; update the supplier route; test that raw adverse/AML records and audit/callback state never leave the supplier endpoint. This protects existing `kys-v1` too.
2. **Create the static registry and KYS adapter.** Make route, store, billing and worker selection flow-aware. Keep current `kys-v1` requests working, migrate or fall back to its existing store keys, and pin case versions. Verify two flows can share a workspace without idempotency or configuration collision.
3. **Add the Supplier Onboarding v1 definition and server rules.** Port the local conditional form and document matrix into tracked, synthetic-fixture-tested code. Register the flow disabled by default.
4. **Ship its reviewed frontend bundle.** Serve it by the case's saved flow/version on the Flo host. Run the complete five-step journey through the browser, including mobile layout, corrections and link expiry.
5. **Port checks, subject discovery and Gemini schemas.** Map OCR fields to TLV/IBAN inputs, run entity and all stakeholder AML/adverse checks, retain raw responses and missing-check coverage. Make the pre-submit review show only supplier-safe findings; preserve buyer-only detail in the case.
6. **Extend report and callback.** Generate the bank-grade report automatically, verify HTML/PDF/JSON parity, include complete per-subject adverse responses in the authorized appendix and complete structured results in the signed callback.
7. **Stage and enable deliberately.** Run full tests, two-flow UI smoke, Bicep build and a staged end-to-end run with controlled documents and live provider success/failure paths. Provision the Flo resources, secrets and DNS/TLS described in the main guide, then enable the new template for a selected workspace. Do not interpret an unrun VAT, BR or bank-letter authenticity API as a pass.

## Acceptance gate before registering the new template

- Both `kys-v1` and `supplier-onboarding-v1` can be published, assigned and configured independently in one workspace; every link and case pins the correct version and bundle.
- A supplier session cannot retrieve full screening results, raw provider responses, buyer audit/decision data or secrets; customer/buyer access remains workspace scoped.
- One `(workspace, flow, idempotency key)` creates and bills one case; replay does not bill again; the same key on a different flow is independent.
- The supplier template's conditional fields/documents are enforced by the server; extraction and verification map to the actual source fields and exact documented provider input contracts.
- The report and callback state each completed, failed, pending and unavailable check, including full authorized adverse-media responses per entity/person; Gemini output has validated source references and cannot make the acceptance decision.
- The flow remains disabled until its own staged provider, storage, browser, report and callback run passes. Existing perpetual Flo case retention and `kys-v1` behavior remain intact.
