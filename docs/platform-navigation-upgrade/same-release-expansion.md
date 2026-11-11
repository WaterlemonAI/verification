# PR #148: expanded customer experience release

**Base:** draft PR #148 at `4c439c4`. Add the work below to that PR before review and deployment. This combines the three review fixes with the eight follow-on user-experience improvements in **one release**, using separate commits and one final acceptance gate. The KYCProbe logo, typography, colours, and visual tone remain unchanged. Existing API contracts, published Flo templates, and `/` (Trade Licence) continue to work.

The runtime, test, and CI implementation scope touches **43 existing files and creates 5 files**. Most of the added surface is the seven verification tester HTML/JavaScript pairs needed for consistent outcome feedback; no backend provider adapter is changed.

## Decisions that keep the scope bounded

- Add `/home` as the normal post-login destination and make the sidebar brand link open it. Flo remains the first **menu** group. Existing deep links and `/` stay valid; the initial-key journey still opens `/api-keys` first.
- Search only the navigation catalog (API, OCR, Forms, Flo destinations), not case contents or supplier personal data. Search results respect the same workspace entitlements as the menu.
- Use existing `/portal/api/flo/cases` and `/portal/api/cases` for the home and case queues. Show a queue reason only when the list record supports it; show detailed missing-document, mismatch, and provider-failure reasons after the case is opened. Do not fetch every full case to build a home page.
- Standardise **display** states; do not reproduce provider decision logic in the browser. HTTP 200 means the request completed, not that verification passed. The API testers may say “Response received — review result” when no authoritative outcome is available. Forms can say “Queued; awaiting signed callback”; it has no live status endpoint and must not pretend to poll one.
- Add cursor/date/module filtering and a bounded CSV export for usage. Keep the existing unfiltered latest-100 response compatible. An export over the cap returns an explicit error so it is never silently truncated. Show all-time account totals separately from filtered rows.
- Key safety uses existing key metadata (label, owner, last four characters); it does not claim to know which external integrations use a key or add a new last-used field.

## Existing files to update

### Workspace shell, home, search, and review fixes

| File | Exact change |
| --- | --- |
| `api-site/portal-auth.js` | Keep Flo first in the menu. Set the brand link to `/home`. Add a labeled menu search input, filtering only the links already authorized for this workspace; include aliases such as “trade license/licence,” “bank,” and “passport,” a result count, clear action, and keyboard focus behavior. Wrap accordion toggle buttons in heading elements; retain `aria-expanded`, `aria-controls`, and active deep-link behavior. Render the authenticated sidebar shell as soon as session and entitlements resolve; fill Flo, Case Manager, Forms, and OCR catalog sections asynchronously without a layout jump or unauthorized link flash. Give failed Flo and Case Manager status calls a visible retry state instead of silently removing their destinations. |
| `api-site/api.css` | Reuse existing tokens to style home cards, sidebar search/results, action cues, check-state panels, progress feedback, account filters, CSV button, and responsive layouts. Add visible focus and reduced-motion rules; reserve sidebar/header space while data loads. No palette, font, or brand change. |
| `api-site/portal-login.js` | Accept `/home` as a safe same-origin `next` target and use it as the ordinary login destination. Preserve explicit valid `next` routes, including Flo/Form/OCR deep links. Keep `/api-keys` as the first destination when login issues a one-time key. Reject external redirects. |
| `server.mjs` | Protect and serve `/home` from the new home HTML. Change both Flo page gates to `(account.role || 'org_admin') === 'org_admin'`, matching existing portal/Flo API legacy-role semantics. Add backward-compatible filtered usage and workspace-scoped CSV routes described below. No new chargeable call is introduced. |

### Task-based home and case action cues

| File | Exact change |
| --- | --- |
| `api-site/flo.html` | Add a small “Requires attention” summary above the current list and a stable, accessible progress/action area in case detail. Keep all existing actions and reports. |
| `api-site/flo.js` | Derive queue action text from existing status, bucket, link delivery and restart fields (for example, resend link, await applicant, review submission, retry delivery). On selection, show exact document/check issues from the existing case detail response. Refresh a selected case while it is processing, with a bounded interval, stop on navigation or terminal state, and never make a chargeable call automatically. Preserve decision and callback actions. |
| `api-site/flo-review.js` | Present check result, coverage, source, checked time, and next action in a predictable order. Keep `not_run`, provider failure, mismatch, and review required distinct. Do not let a transport success appear as a verified match. |
| `api-site/flo.css` | Style attention badges, timeline/progress states, and narrow case detail layouts with the current Flo theme. |
| `api-site/cases.html` | Add skip-to-main and a visible attention/next-action area in the list and detail, while retaining current filters and retention explanation. |
| `api-site/cases.js` | Use existing outcome, request status, and reason codes to show why a saved API case needs action. Preserve pagination/filtering. Add direct service-documentation links where the service ID maps to an existing page; no automatic rerun. |
| `api-site/case-result-model.mjs` | Provide a bounded, human-readable presentation of reason codes and source/coverage/timestamps already present in a case result. Explicitly distinguish extracted data from verification. Preserve raw JSON access. |

### Consistent outcomes and asynchronous feedback

| File | Exact change |
| --- | --- |
| `api-site/forms.html`, `api-site/forms.js` | Load the shared display vocabulary; show submission receipt as queued, tell users the signed callback is the completion channel, and expose the submission ID with copy control. Keep the callback signing secret one-time and in page memory only; do not put it in navigation, URLs, storage, or telemetry. Distinguish network failure from accepted submission and show the correct idempotent retry instruction. |
| `api-site/document-extraction.html`, `api-site/document-extraction.js` | Show submitted, queued, processing, completed, expired, and failed states from the actual OCR response/status URL. Keep polling bounded and cancellable, with a visible “still processing” path and result URL. A completed extraction is labeled extraction, not verification. |
| `api-site/index.html`, `api-site/api.js` | Add the shared check-state panel to the Trade Licence tester; pass HTTP/provider result and time to it without changing request fields. |
| `api-site/iban.html`, `api-site/iban.js` | Same panel for IBAN; show component match details and never label a partial/unknown match as verified. |
| `api-site/entity-search.html`, `api-site/entity-search.js` | Same panel; distinguish candidates found, no candidates within completed coverage, and incomplete provider coverage. |
| `api-site/adverse-media.html`, `api-site/adverse-media.js` | Same panel; distinguish findings, no material findings within coverage, and incomplete/unavailable sources. |
| `api-site/merchant-screening.html`, `api-site/merchant-screening.js` | Same panel; show coverage and review requirements separately from transport status. |
| `api-site/bank-statement-analysis.html`, `api-site/bank-statement-analysis.js` | Same panel; separate completed analysis from decision eligibility and missing data. |
| `api-site/ejari-verification.html`, `api-site/ejari-verification.js` | Same panel; show queued/polling/final provider states and actionable failure text without hiding raw result. |

### Usage and key safety

| File | Exact change |
| --- | --- |
| `api-site/account.html` | Add date and module filters, filtered-result count, clear labels for all-time totals, a CSV export button, and a visible latest-100/default note. On API Keys, add an acknowledgment control for a newly revealed key and explain that rotation invalidates the prior value. |
| `api-site/account.js` | Fix the one-time-key loss: keep the value visible if the key-list request fails, and never redirect to login for a non-auth data error. Show a retry for list failures. Before rotation/revocation, confirm label, owner, last four characters and immediate effect. Load filtered usage with cursor/next-page support; export the current filters and show an explicit too-large/export error. Do not persist key values after acknowledgment. |
| `lib/customer-usage.mjs` | Add a separate cursor-based, workspace-scoped log listing method for both memory and Azure Table stores. Filter by UTC date range and module with bounded scans; return an opaque next cursor. Keep existing `logs(workspaceId, 100)` callers and billing totals unchanged. |

### Required existing verification files

| File | Add or extend these checks |
| --- | --- |
| `test/portal-auth.test.mjs` | `/home` session gate, `/` compatibility, normal versus initial-key login destination, legacy admin Flo access, member denial, filtered usage and export authorization. |
| `test/customer-usage.test.mjs` | Memory/Azure-compatible cursor order, date/module filters, workspace isolation, refunds, export limits, and deterministic CSV columns. |
| `test/case-result-model.test.mjs` | `not_run`, failed transport, partial coverage, OCR extraction, and unknown provider outcome retain honest wording. |
| `test/forms.test.mjs` | Queued receipt and signed-callback wording remain accurate; no fake status endpoint or secret persistence. |
| `test/flo-portal-link.test.mjs` | Explicit and wildcard Flo access plus the legacy admin page/API alignment. |
| `scripts/smoke-portal-navigation-ui.mjs` | Home landing, brand navigation, menu search/aliases, filtered destinations, status fetch failures and retry, accordion headings, keyboard focus, mobile layout, and no layout jump after catalogs arrive. |
| `scripts/smoke-login-otp-ui.mjs` | Normal login reaches `/home`; initial-key journey reaches `/api-keys`; a failed key-list request does not lose the displayed one-time value. |
| `scripts/smoke-case-manager-ui.mjs` | Action cues agree with real outcome/reason data; no “verified” label for extracted or incomplete checks. |
| `scripts/smoke-flo-ui.mjs` | Flo queue reason, detail evidence, processing refresh, and terminal-state stop using controlled fixtures. |
| `scripts/smoke-ejari-ui.mjs` | Polling and final-state labels match the actual response path. |
| `.github/workflows/api-pr-checks.yml` | Run the new service-state browser smoke alongside the existing customer, Flo, case, login and Ejari smokes. No new dependency or infrastructure build step. |

## New files to create

| New file | Purpose and constraints |
| --- | --- |
| `api-site/home.html` | Signed-in task-based workspace home: primary Flo/API actions, recent Flo and API cases when enabled, and clear empty/unavailable states. Use shared `api.css`, `portal-auth.js`, and existing KYCProbe assets. Flo remains the first menu group. |
| `api-site/home.js` | Read only existing session/entitlement/status/case endpoints; load optional recent activity after the home shell paints; suppress inaccessible actions for members and unavailable modules; show retry without redirecting an authenticated user to login for provider errors. |
| `api-site/status-view.js` | Shared browser-side presentation vocabulary for transport, verification/extraction, coverage, and progress. It must use text nodes, allowlisted statuses and conservative unknown-state fallback. It must never infer a business pass from HTTP 2xx or overwrite raw provider results. Load before dependent classic scripts; module pages may import it for its side effect. |
| `lib/usage-export.mjs` | Deterministic CSV formatting with proper quoting and spreadsheet-formula injection protection. Include transaction, module, cost, refund and state fields; no secrets or document data. The server streams or bounds rows, rejects an over-limit export rather than truncating it. |
| `scripts/smoke-service-status-ui.mjs` | Browser fixtures for all seven verification testers, OCR, and Forms. Assert honest status/provenance wording, queued versus final state, keyboard announcements, and no secret leakage. |

No new database table, Key Vault secret, storage account, queue, public API price, or infrastructure file is required. The new home uses existing read-only endpoints. Usage pagination/export uses existing usage rows and RowKey order; it must not perform an unbounded table scan. Keep report PDFs, Flo workflow definitions, callback signatures, and supplier journeys outside this UI release.

## Build order inside the same PR

1. **Repair the three review findings.** Key-list failure preserves the new key; legacy admin role fallback matches Flo API; failed Flo/Case status calls show Retry. Add targeted browser/server cases.
2. **Add home and search.** Home is the default only for ordinary login. Keep Flo first in the sidebar and `/` as the Trade Licence route. Check member, API-only, Flo-enabled and empty workspaces.
3. **Add queue actions and display vocabulary.** Start with API and Flo cases, then wire the seven API testers, OCR and Forms. Use real source fields; unknown and incomplete remain review states.
4. **Add usage filters/export and key safeguards.** Preserve the old latest-100 response. Use a fixed UTC range and row cap for export; return a clear error if the selection exceeds the cap.
5. **Finish access, responsive, performance and regression gates.** Run `npm test`, JS syntax, all existing smokes, the new service smoke, and hosted CI. Test 1440, 390 and 320 px, keyboard and 200% zoom. Check that initial rendering stays stable as catalogs resolve and that no automatic chargeable verification call is made. Review one real workspace with Flo and API Case Manager enabled before merging.

Only after all five steps pass should the expanded PR move from draft to reviewed merge and the existing production deployment workflow run.
