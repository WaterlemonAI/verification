# Implementation file map: customer workspace navigation

This is the developer handoff for the [UI and navigation plan](README.md). It is based on production `main` at `bef5557377d505ccbc6339276cf62432e853dfc7`. **Release 1 requires 16 existing files and one new browser smoke file.** No new HTML page, API data endpoint, database migration, infrastructure file, or theme asset is required. Keep the current palette, type, logo, and component style.

## Release 1: required files

### Navigation, routes, and permissions

| Existing file | Required edit | Completion check |
| --- | --- | --- |
| `api-site/portal-auth.js` | Replace the flat sidebar template with ordered Flo, Verification API, OCR, Forms groups, then API Case Manager, Account Settings, Usage & Billing, API Keys. Use native buttons for group toggles and links for destinations. Build OCR children from `/document-extraction-catalog.json` and Forms children from the signed-in `/forms.json`; filter against `allowed_modules` and `available_modules`. Use the Flo status and case settings responses for their respective links. Match route families, including `/forms/{id}` and `/document-extraction/{id}`; update the header and active child. Handle loading, catalog failure, 0 eligible forms, long lists, and `*` entitlement. Synchronize mobile `aria-expanded`, Escape, overlay dismissal, focus return, and background focus blocking. Keep all fetched names text-escaped. | Exact menu order, no unavailable links, deep links highlight correctly, and a 320 px mobile drawer works by keyboard. |
| `api-site/api.css` | Style the four accordion group buttons, child indentation, expanded/active/focus states, bounded submenu scrolling, long labels, sidebar scrolling, and drawer safe areas with existing design tokens. Style the three route-selected account views and narrow usage tables. Add `prefers-reduced-motion`; avoid changing global colors or typography. | No horizontal page overflow at 320 px or 200% zoom; visible focus and active states. |
| `server.mjs` | Add `/usage` and `/api-keys` to `protectedPortalPath()` and serve both from the existing `api-site/account.html`. Keep `/account` and all existing URLs. Change the signed-in `/forms.json` cache header to `private, no-store`. Apply `allowed_modules.includes('*') || allowed_modules.includes('flo')` consistently to the Flo entitlement callback, Flo charge gate, `/flo`, and `/flo-workflows` page gates. Retain the current server authorization rules for all other routes. | Unauthenticated account routes redirect to login; Flo wildcard workspaces can use the menu, pages, and link API; a disallowed workspace cannot. |
| `api-site/portal-login.js` | Extend the same-origin `next` allowlist to `/usage`, `/api-keys`, `/flo`, `/flo-workflows`, `/ejari-verification`, and valid OCR/Form detail route families. Keep the open-redirect protection. Send a login that returns a one-time initial API key to `/api-keys` so the reveal is on its own page; ordinary login honors a valid `next`. | Sign-in returns to each new or existing protected deep link; external `next` URLs remain rejected. |

### Account, usage, and API keys

| Existing file | Required edit | Completion check |
| --- | --- | --- |
| `api-site/account.html` | Reuse this one document for `/account`, `/usage`, and `/api-keys`. Wrap existing sections in route-specific containers hidden until initialized. Put workspace/team, API Case Manager retention, and health on Account Settings; balance/postpay state, spend, current rate card, and transaction table on Usage & Billing; key management, one-time reveal, and API automation examples on API Keys. Add a skip link and stable main target. Set route-appropriate title, heading, and introduction without duplicating the forms or key reveal. | Each route shows only its own section and heading; old `/account` URL still works. |
| `api-site/account.js` | Select one view from `location.pathname`, reveal it after auth, and initialize only the view's data and event handlers. Keep team and retention writes admin-only; keep key create/rotate/revoke authorization and one-time secret behavior. On Usage, use `/portal/api/usage` and, if useful, `/portal/api/keys` metadata to label key IDs without revealing secrets. Render `account.rates` and state clearly; say the transaction list contains the latest 100 entries. Redirect failed sessions back to the requested route, not always `/account`. | Visiting Usage cannot expose `ai7_new_api_key`; first-time key reveal works only on API Keys; no null-element errors or unnecessary health/team requests. |

### Flo and Forms page context

| Existing file | Required edit | Completion check |
| --- | --- | --- |
| `api-site/flo.html` | Give the create-link section a stable `id="new-application"`, add skip-to-main, and align the page heading with **Flo / Applications and reports**. Keep existing case review, report, and decision markup. | Flo submenu's Create onboarding link reaches the form after direct load and refresh. |
| `api-site/flo.js` | Show a readable flow name in the create-link selector and flow filter, with ID and pinned version as secondary text; do not treat the name as a unique key. Preserve existing case IDs and API payloads. | Two flows with the same display name remain distinguishable and submit the correct `flow_id`. |
| `api-site/flo-workflows.html` | Add a skip link and stable main target; make title and introductory text match the Flo submenu. Do not rearrange the editor or change builder save logic in Release 1. | Keyboard users can skip directly to Workflows content; existing builder smoke still passes. |
| `api-site/forms.html` | Replace stale AI7 UAE/AETHERIX page and footer labels with KYCProbe workspace copy, add skip-to-main, and keep the Forms API orchestration explanation distinct from Flo applicant onboarding. Do not change Form submission payloads. | Forms directory and detail have consistent product naming and working skip links. |
| `api-site/forms.js` | Reuse the workspace-filtered `/forms.json` for the directory; distinguish an empty entitled catalog from a failed fetch, provide retry, and keep form detail name/context synchronized with the sidebar. Continue escaping form names through `textContent`; leave the API key test console behavior intact. | Failure never looks like “no forms”; form detail header and active menu child use the same form name. |

### Tests and CI

| Existing file | Required edit | Completion check |
| --- | --- | --- |
| `test/portal-auth.test.mjs` | Cover auth and protected serving of `/account`, `/usage`, `/api-keys`; retain `/account` compatibility. Add a production-server Flo wildcard case for menu/page authorization and ensure disallowed workspaces remain rejected. | Page routes return the expected HTML only with a session; no cross-workspace permission regression. |
| `test/forms.test.mjs` | Check that a signed-in, workspace-filtered `/forms.json` response is private/no-store and contains only eligible forms; leave the public schema contract unchanged. | No shared-cacheable personalized catalog. |
| `test/flo-portal-link.test.mjs` | Exercise Flo link creation for a workspace entitled through `*` as well as explicit `flo`, and a denied workspace; keep idempotency and charged-call assertions. Use the same entitlement predicate as production rather than a constant-true stub for this case. | Menu/page/link entitlement rules agree. |
| `scripts/smoke-login-otp-ui.mjs` | Add a new-route `next` journey and a first-time key journey that lands on `/api-keys`; verify one-time display, then reload and confirm the secret is absent. Keep the existing admin sign-in check. | No redirect loss or repeat key reveal. |
| `.github/workflows/api-pr-checks.yml` | Invoke the new browser smoke script after the existing Chromium install and alongside current Flo, Case Manager, and login smoke checks. Keep existing test and Bicep gates. | Pull requests run the navigation smoke automatically. |

| New file | Purpose | Required coverage |
| --- | --- | --- |
| `scripts/smoke-portal-navigation-ui.mjs` | Playwright desktop/mobile contract for the customer menu and split views. Start an in-process test server or use the existing smoke-server pattern; use controlled fixture workspaces, never live chargeable checks. | Exact order, entitlement filtering, Forms/OCR children, long and empty catalogs, wildcard Flo, active deep links, keyboard accordion, Escape/overlay/focus return, 320/390/1440 px layouts, and the three account routes. |

The existing `api-site/document-extraction-catalog.json` is the OCR source of truth; **read it, do not edit it** for this navigation change. The current static file response uses `no-cache`, so changing every service page solely to bump a `portal-auth.js` or `api.css` query string is unnecessary. Run the existing Flo and Case Manager browser smokes; change their fixtures only if the new catalog requests need mocking.

## Implementation order

1. Add server routes, `/forms.json` cache policy, and the four Flo wildcard checks. Write the route/permission tests first because the menu must never advertise a route the server rejects.
2. Build the sidebar from one navigation model in `portal-auth.js`. Load all needed session, entitlement, Flo, case, Form, and OCR data before exposing final links; render a clear retry/fallback for a failed catalog. Add the CSS and keyboard behavior.
3. Split the account document by route and update login redirects. Preserve the initial-key one-time reveal in browser session storage only until `/api-keys` consumes it.
4. Align Flo and Forms headings, anchors, and names. Keep workflow editor state and all API request contracts unchanged.
5. Add contract and browser checks; run `npm test`, JS syntax checks, the existing browser smokes, and the new navigation smoke at desktop and mobile sizes. Review network requests for chargeable calls and leaked credentials.
6. Release through the existing API deployment workflow, check Flo-enabled, API-only, member, and wildcard workspaces, then compare route access and menu visibility. Roll back with the previous API image if needed.

## Release 2: optional, separate page refinements

These changes are **not required** to ship the requested menu and three distinct account views. Treat them as separately reviewable follow-ons after Release 1 usage feedback.

| Work | Existing files to update | Exact instruction |
| --- | --- | --- |
| Flo editor organization | `api-site/flo-workflows.js`, `api-site/flo-workflows.css`, `api-site/flo-builder.css`, `scripts/smoke-flo-builder-ui.mjs` | Put Builder, Checks/Report, Preview/JSON, Settings, and Notifications in internal tabs/panels. Keep unsaved JSON and draft edits across tab switches or require explicit discard. Test delayed Save responses, keyboard tabs, and mobile layout. |
| Flo application deep links | `api-site/flo.js`, `api-site/flo.css`, `scripts/smoke-flo-ui.mjs` | Put selected application, status, and flow filter in URL state; restore on refresh and Back/Forward. Never include link tokens, secrets, or document data in a URL. |
| API/OCR page consistency | `api-site/index.html`, `api-site/iban.html`, `api-site/entity-search.html`, `api-site/adverse-media.html`, `api-site/merchant-screening.html`, `api-site/bank-statement-analysis.html`, `api-site/ejari-verification.html`, `api-site/document-extraction.html`, `api-site/document-extraction.js`, `api-site/api.css` | Align page headings, service status, input/result hierarchy, documentation anchors, skip links, and responsive spacing using existing styles. Keep service-specific request contracts and tester logic untouched unless a concrete usability issue requires it. |
| Usage pagination and export | `server.mjs`, `lib/customer-usage.mjs`, `api-site/account.js`, `api-site/api.css`, `test/customer-usage.test.mjs`, `test/portal-auth.test.mjs`, `scripts/smoke-portal-navigation-ui.mjs` | Add workspace-scoped cursor/date/module filters and CSV export after confirming ledger semantics. Keep the latest-100 view in Release 1; do not add invoice/payment UI without a real source. |
| Administrator terminology | `admin-site/index.html`, `admin-site/admin.js`, `admin-site/admin.css` | Align Flo, Forms, integration, and usage labels with the customer portal while preserving separate admin routes and permissions. |

Release 2 needs no new file by default. Add a test file only if a behavior cannot be meaningfully covered by the listed existing tests.
