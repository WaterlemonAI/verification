# KYCProbe workspace UI and navigation upgrade plan

**Baseline:** production `main` at `bef5557377d505ccbc6339276cf62432e853dfc7` (11 November 2026). This plan covers the signed-in **customer workspace** on `app.kycprobe.com`. The platform administrator at `/admin` and supplier journeys on `flo.ai7uae.com` remain separate products; their navigation is not copied into the customer workspace.

**Expanded PR #148 scope:** [Same-release experience expansion](same-release-expansion.md) is the current handoff for adding the home page, navigation search, case actions, result/progress clarity, usage export, key safety, accessibility and performance work to the first release. It pulls forward the usage and API/OCR presentation items below. Flo editor reorganisation, Flo deep-link state and administrator terminology remain later refinements.

**Design constraint:** keep the current KYCProbe logo, Manrope/DM Mono typography, navy/blue/gold palette, surfaces, and component tone. Change information architecture, behavior, density, and wording. Do not change API billing, case retention, workflow schemas, access policy, or existing URLs during the navigation release.

## 1. Target information architecture

The sidebar order is fixed. The first four items are expandable groups; the final four are direct links. Only entitled and available destinations appear. Group headers are buttons; pages are links.

| Order | Sidebar item | Children or destination | Existing source / target |
| --- | --- | --- | --- |
| 1 | **Flo** | Applications and reports; Create onboarding link; Workflows | `/flo`, `/flo#new-application`, `/flo-workflows` |
| 2 | **Verification API** | UAE Trade Licence, IBAN Verification, Entity Search, Adverse Media, Merchant Screening, Bank Statement Analysis, Dubai Ejari Verification | Existing seven routes; `/` remains the trade licence page |
| 3 | **OCR** | All entitled OCR services, using the document extraction catalog | Existing `/document-extraction/{id}` routes |
| 4 | **Forms** | All Forms; every entitled, enabled form by its name | `/forms`, `/forms/{id}` from `/forms.json` |
| 5 | **API Case Manager** | Direct link; explain that it stores API results, separately from Flo applications | `/cases` |
| 6 | **Account Settings** | Workspace identity and team, API Case Manager retention policy, service health | `/account` |
| 7 | **Usage & Billing** | Balance or postpay status, spend, rates, transaction history | New `/usage` view backed by existing `/portal/api/usage` |
| 8 | **API Keys** | Create, copy once, rotate and revoke keys; API automation examples | New `/api-keys` view backed by existing `/portal/api/keys` |

The sign-out control and workspace identity stay at the bottom of the sidebar. Remove the current numeric prefixes: they repeat across groups and stop expressing useful ordering when entitlements hide items. Keep `Flo Case Manager` as a page heading if desired, but use **Applications** in the Flo submenu and **API Case Manager** for `/cases` so the two histories are unmistakable. Do not add a standalone Flo Reports link until a cross-case report index exists; reports are reached from an application.

Keep `/account`, `/forms`, `/flo`, and every API route working. New `/usage` and `/api-keys` URLs can render the existing account document with route-selected sections, avoiding a second account implementation. A successful first-time login that reveals a new API key should land on `/api-keys`; ordinary login preserves the requested `next` URL and otherwise keeps the current `/` destination for compatibility. Do not silently redirect `/` to Flo.

### Group behavior

- The group containing the current page opens automatically. `aria-current="page"` identifies the child link, including `/forms/{id}` and `/document-extraction/{id}`. The top header shows the same group and page name.
- Users may open another group with Enter, Space, mouse, or touch. Only one group is open at a time on the narrow sidebar; avoid a menu taller than the viewport. A second click closes it. Store manual expansion for the current browser session only; a deep link still opens its own group.
- The Forms submenu is generated from the workspace-filtered `/forms.json` response. Include **All Forms** and every eligible form; if the list is long, use a bounded scroll area and a local filter, not a truncated list. Show a clear empty state when the Forms module is entitled but no form is enabled.
- OCR children come from `document-extraction-catalog.json` and are filtered through `allowed_modules` and `available_modules`. Keep the catalog order and human-friendly short labels; retain the full service name as accessible text or title where shortened.
- Flo appears only when Flo is assigned and enabled. Show Workflows only when the workflow platform is enabled. API Case Manager appears only when its server feature is available; on `/account`, explain separately whether the workspace's case-copy policy is on.
- `allowed_modules: ['*']` must be treated as a wildcard for Flo as well as APIs, OCR, and Forms. Menu visibility is a presentation rule; existing server authorization remains the source of truth.

## 2. Findings in the current production code

| Priority | Evidence | User impact / required change |
| --- | --- | --- |
| P1 | `api-site/portal-auth.js:67-93` hardcodes all modules as flat links, places Flo last, and displays repeated sequence numbers. | Replace the one flat list with the target hierarchy and labels. |
| P1 | `api-site/account.html:18-46` places team, Case Manager policy, keys, usage, health and automation in one page; `api-site/account.js:216-225` loads almost all of them on every visit. | Give Account Settings, Usage & Billing, and API Keys separate URLs and load only each view's data. |
| P1 | `api-site/portal-auth.js:100` matches only exact paths and `:27-40` omits `/forms/{id}`. | Form detail pages currently lose sidebar active state and header context. Match route families. |
| P1 | `api-site/portal-auth.js:111` and `server.mjs:3219,3228` check `allowed_modules.includes('flo')` without the `*` wildcard used elsewhere. | Correct both menu visibility and page access for wildcard workspaces; do not show a Flo link that the route rejects. |
| P1 | `server.mjs:3142-3152` builds a session-filtered `/forms.json` response but marks it `public, max-age=60`. | Set `Cache-Control: private, no-store` for the personalized catalog so shared caches cannot serve one workspace's menu to another. Keep the public form schema route unchanged. |
| P1 | `api-site/portal-auth.js:137-148` closes the mobile overlay by changing a body class only; no Escape handling or focus return exists. | Keep `aria-expanded` synchronized, restore focus to the trigger, block focus behind an open drawer, and close with Escape. |
| P2 | `api-site/flo.js:60-72` presents raw flow IDs and versions in the link selector even though `/portal/api/flo/flows` already supplies `brand_name`; `api-site/flo-workflows.js:11-17` shows workflow name in its list. | Show a readable flow name first, with version and ID as secondary identifiers. Check duplicate names before relying on name alone. |
| P2 | `api-site/flo-workflows.js:69-125` appends branding, callback, email and SMTP below the builder. | Put these in internal Settings and Notifications panels, with the same saved-state guard as the builder. Keep the existing endpoints. |
| P2 | `api-site/forms.html:17,83` still says AI7 UAE/AETHERIX while the surrounding signed-in portal says KYCProbe. | Align customer-facing labels and footer. Keep Forms described as API orchestration so it is not confused with Flo applicant journeys. |
| P2 | `api-site/account.html:38-39` exposes balance/spend and the latest calls but not the rate card already returned by `/portal/api/usage`; `server.mjs:1990-1999` limits logs to 100. | Show current rates and make the 100-row limit explicit in release 1. Add server pagination/filter/export only as a later billing enhancement. Do not imply invoice or payment features exist. |
| P2 | Some portal pages have a skip link (`api-site/index.html:18`), while `api-site/account.html`, `api-site/forms.html`, `api-site/flo.html`, and `api-site/flo-workflows.html` do not. | Make skip-to-main and focus order consistent across signed-in pages. |
| P2 | `api-site/api.css:174-183,283-288` styles the fixed sidebar and mobile drawer but has no visible focus rule for the new group toggles or reduced-motion treatment for the drawer transition. | Add focus-visible, selected/expanded states, reduced-motion, long-label wrapping, and safe-area behavior using existing colors. |

These findings use the [Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md) for keyboard, focus, semantics, deep links, responsive behavior, and reduced motion. The exact release checks below apply those rules to this repository.

## 3. Screen-level UX specification

### Flo

Make `/flo` open on applications, with **Create onboarding link** as the clear primary action and an anchor for the Flo submenu. Preserve the current case filters, review tabs, reports, decisions, and callbacks. Show readable flow names in the creation selector and case filter; keep flow ID/version visible in detail and audit views. Use a stable case deep link if the current list can support it without exposing a new permission path. The flow editor at `/flo-workflows` should group Builder, Checks & Report, Preview/JSON, Settings, and Notifications as internal tabs or sections. A tab switch must preserve or explicitly discard unsaved JSON and form edits.

### Verification API and OCR

Keep the existing API tester and documentation on their current routes. Standardize page title, service status, input area, response area, and documentation anchors; do not rewrite API contracts. The OCR group is a navigation category, not a new OCR dashboard. Its child list must contain every currently available OCR route and update when the catalog grows. On narrow screens, keep request inputs and results readable without horizontal page overflow.

### Forms

The Forms group lists eligible published forms, with **All Forms** linking to the existing directory. The directory remains the place to discover descriptions and service combinations. On a form detail page, the active child is the form name and the header says `Forms / {form name}`. Clarify that the signed-in portal session does not replace the service API key required by the Form test console. Use the existing forms catalog instead of hardcoding entries in navigation.

### Account, usage and keys

`/account` contains workspace/team controls, API Case Manager retention and service health. `/usage` shows prepaid/postpay state, balance where relevant, spend, charged calls, current module rates and the latest 100 transactions. Label these as **Usage & Billing**, with a note that invoice downloads and payment methods are not yet provided. `/api-keys` shows the existing per-member key permissions, one-time secret reveal, rotation/revocation and automation examples. Navigating to Usage must never render a newly issued key; the one-time reveal remains on API Keys.

## 4. Files and implementation sequence

The exact Release 1 file checklist, with instructions for each file, is in [Implementation file map](implementation-file-map.md). That checklist is the handoff for the navigation release; the Release 2 table below is a separate follow-on scope.

### Release 1: navigation and distinct account views

| Step | Existing files to update | New files | Deliverable |
| --- | --- | --- | --- |
| 1. Navigation model and renderer | `api-site/portal-auth.js`, `api-site/api.css`, `server.mjs` | None | Ordered groups and direct links, entitlement filtering, active route families, mobile drawer, keyboard and focus behavior. Apply the same Flo wildcard rule at every server page, portal, and link gate. |
| 2. Forms/OCR catalogs | `api-site/portal-auth.js`, `server.mjs` | None | Dynamic eligible Forms and OCR children; personalized Forms catalog cache fix. Handle fetch failures with a visible **All Forms** fallback, not a false empty state. |
| 3. Account view split | `api-site/account.html`, `api-site/account.js`, `api-site/api.css`, `server.mjs`, `api-site/portal-login.js` | None | `/account`, `/usage`, `/api-keys` render distinct sections of the current account document. Only relevant data loads per route. Existing `/account` bookmarks work. |
| 4. Page context and labels | `api-site/flo.html`, `api-site/flo-workflows.html`, `api-site/forms.html`, `api-site/forms.js`, `api-site/flo.js`, `api-site/portal-auth.js` | None | Flo create-link anchor; readable flow labels; skip links; consistent KYCProbe copy and contextual header. Keep the workflow editor rearrangement for Release 2 to preserve its Save guard. |
| 5. Contract and browser tests | `test/portal-auth.test.mjs`, `test/forms.test.mjs`, `test/flo-portal-link.test.mjs`, `scripts/smoke-login-otp-ui.mjs`, `.github/workflows/api-pr-checks.yml` | `scripts/smoke-portal-navigation-ui.mjs` | Route/auth/cache/wildcard coverage and desktop/mobile navigation smoke in hosted CI. |

The new HTML paths are handled in `server.mjs` by serving `api-site/account.html`; no new customer-data endpoint, database migration, Key Vault secret, or storage resource is needed for Release 1. Keep `api-site/account.js` in one file for the first release, with small route-specific initialization functions. Extract shared modules only if the three views become hard to maintain after implementation.

### Release 2: page refinements after navigation is stable

| Work | Files likely to change | Acceptance |
| --- | --- | --- |
| Flo editor Settings and Notifications panels | `api-site/flo-workflows.js`, `api-site/flo-workflows.css`, `api-site/flo-builder.css`, `scripts/smoke-flo-builder-ui.mjs` | Draft/JSON edits survive tab changes or require explicit discard; settings save independently; mobile builder remains usable. |
| Flo case and form URL state | `api-site/flo.js`, `api-site/forms.js`, relevant CSS and smoke tests | Browser Back/Forward and copied links restore selected case, status filter, and form detail. Do not embed secrets in URLs. |
| Usage history beyond 100 rows | `server.mjs`, `lib/customer-usage.mjs`, `api-site/account.js`, `test/customer-usage.test.mjs` | Workspace-scoped pagination/date/module filters and CSV export agree with the ledger; invoices remain out of scope until a real invoice source exists. |
| Admin terminology alignment | `admin-site/index.html`, `admin-site/admin.js`, `admin-site/admin.css` | Admin Flo, Forms, integrations and customer usage labels match the customer portal, while admin authorization and workflow remain separate. |

## 5. Release acceptance matrix

1. **Navigation:** exact target order; all seven verification routes and eight current OCR routes present only when entitled/available; all eligible Forms visible; no empty or unavailable group; Flo hidden when disabled; wildcard entitlement works.
2. **Routing:** direct URLs, refresh, sign-in `next`, browser Back/Forward and old `/account` links work; `/forms/{id}` and `/document-extraction/{id}` highlight the correct child; `/usage` and `/api-keys` require the portal session. A member sees only actions allowed by existing role checks.
3. **Data safety:** `/forms.json` is not shared-cacheable when session-filtered; menu requests use same-origin credentials; no API key or callback signing secret enters HTML attributes, URL, telemetry, or the navigation DOM. API Keys keeps the one-time display behavior.
4. **Desktop/mobile:** test 1440, 1024, 768, 390 and 320 px; sidebar scroll, long form names, 50+ forms, narrow account tables, browser zoom at 200%, safe areas and no horizontal page overflow.
5. **Keyboard/accessibility:** skip link, native group buttons, Enter/Space, Escape, focus return, visible focus, `aria-expanded`, `aria-current`, logical heading order, screen-reader group names, and `prefers-reduced-motion`. Mobile overlay close resets the trigger state.
6. **Resilience:** slow/failed catalog requests show a retry or fallback rather than silently hiding purchased modules; expired session redirects to login; loading does not flash unauthorized menu items or shift the page after interaction.
7. **Regression:** `npm test`, syntax checks, existing Flo/Form/Case Manager smoke tests, new navigation smoke, and hosted PR CI pass. In a controlled production workspace, compare before/after entitlements and visit each route without making chargeable API calls.

## 6. Rollout and rollback

Ship Release 1 behind the existing reviewed production API workflow. It changes the customer portal bundle and two account page routes; existing API endpoints, data stores and published workflows stay intact. Verify one Flo-enabled workspace, one API-only workspace, a member account, and a wildcard-entitled workspace. Roll back by redeploying the previous API image if navigation or account routing fails. Release 2 can follow independently after actual usage feedback; no theme redesign is a prerequisite.
