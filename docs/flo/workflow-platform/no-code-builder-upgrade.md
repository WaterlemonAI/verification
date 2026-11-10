# Flo no-code template builder: file-by-file upgrade plan

**Planning baseline:** `WaterlemonAI/verification` `origin/main` at `4a67281dd9611574ad23efe05010039182759818` (10 November 2026). This is an implementation plan, not a deployed change. The existing Flo workflow platform, published versions, cases, assignments and supplier renderer remain the execution contract.

## Outcome and boundaries

Platform admins create and edit workflows by adding and arranging stages, fields, document requests and declarations on a visual canvas. Each edit updates one in-memory schema object. The builder serializes that object to Flo's current JSON schema for validation, draft save and publish. A JSON tab remains available for inspection and advanced editing; switching back to the builder requires a successful parse and validation, so there are never two competing drafts. Organisation admins use the same builder on copies they own. Assigned platform templates remain read-only to them until copied.

The builder is a **structured form editor**, not a pixel-positioning tool. Dragging changes order within the schema. The current schema supports at most 8 stages, 80 fields and 30 document slots; field types are `text`, `email`, `url`, `date`, `select`, `textarea`, `number` and `people`. A `show_if` condition can only test equality against an earlier field. The UI must explain these limits. New field types, complex branching, arbitrary HTML/JavaScript, new verification providers and a pricing change are outside this upgrade.

Keep these invariants throughout:

- IDs are generated once, remain stable across label changes and are unique across stages, fields, documents and declarations. Copying a component generates a new ID. Existing JSON imported into the builder must round-trip without changing IDs or meaning.
- Draft edits never change a published version. Save uses the current `draft_revision`; publish creates a new immutable version and definition hash. Existing applications continue to resolve their pinned version.
- Check selection is limited to the approved, entitled catalog. The builder shows the required fields/documents and blocks publish when dependencies are missing. A check is never silently removed because of an edit.
- Preview is local and non-submitting: it never creates an application, uploads a document, charges a workspace, or calls a verification provider. Supplier data and credentials stay out of preview fixtures.
- Platform APIs remain platform-admin-only; organisation APIs remain owner-workspace-scoped. Render labels as text, never as executable markup. Load sortable code from this application origin under the existing CSP.

## Target interaction

1. **Template list:** search and filter draft/active/paused/archived workflows; show version, owner and active organisation count. Actions: New, Copy, Edit, Preview, Publish, Pause and Archive where authorized.
2. **Builder:** left palette for stage, field type, document and declaration; center ordered stage canvas; right properties panel for the selected item. A separate Checks and Report tab edits the approved checks, report section titles and presentation colours.
3. **Preview:** desktop/mobile widths and next/back stage navigation using the unsaved schema. Show required and conditional behavior with synthetic example values. Clearly label it Preview and disable upload/submit actions.
4. **JSON:** generated JSON is readable, copyable and downloadable. Advanced edit is explicit; valid edits replace the builder model, while invalid edits stay in the JSON tab with exact errors and do not overwrite the last valid model.
5. **Save and publish:** show unsaved changes and current draft revision. Save draft first; publish requires a current saved revision and displays a summary of changed stages, fields, documents and checks. Preserve the existing confirmation and immutable version behavior.

Every drag handle also has Move up/Move down controls and a keyboard reorder interaction. Announce the new position to assistive technology, retain focus after a move, and make the same operation usable on touch. A pinned, self-hosted SortableJS release is suitable for pointer/touch reordering in this framework-free frontend; the schema object, not DOM order or the library, is the source of truth. Do not load it from a CDN.

## Step 1 — lock a builder-compatible schema contract

| File | Implementation instruction | QA gate |
|---|---|---|
| `lib/flows/template-schema.mjs` | Add a structured diagnostics function returning stable error codes and schema paths for invalid stages, fields, conditions, limits and check dependencies. Keep `validateWorkflowSchema` and its current rejection behavior for existing callers. Add a normalization/serialization helper only if it preserves property order, array order and existing IDs; do not silently drop unknown keys. | An untouched import/export preserves the exact `JSON.stringify` input to `schemaHash` and therefore the definition hash. Invalid JSON/schema yields a path that can focus the corresponding builder control. |
| `lib/flows/checks-catalog.mjs` | Add safe display metadata (label, description and visible dependency list) to the existing approved check entries. Do not introduce a second executable check registry. | Every displayed check maps to an existing adapter and dependency rule; an unknown or unentitled check cannot be selected or published. |
| `test/flo-template-schema.test.mjs` | Add fixtures for all supported field types, stage/field/document limits, duplicate and stable IDs, `show_if` ordering, check dependencies and round-trip of both current 1.0.1 templates. | `node --test test/flo-template-schema.test.mjs` passes; old schema and hash tests still pass. |

**Gate 1:** agree on the current schema as the builder's first-release capability set. Do not start UI work by inventing properties that the supplier renderer cannot execute.

## Step 2 — add a read-only validation and preview contract for unsaved work

| File | Implementation instruction | QA gate |
|---|---|---|
| `lib/flows/workflow-service.mjs` | Add a method that validates a supplied *unsaved* schema against the caller's allowed checks and returns a safe presentation plus diagnostics. Reuse the same validation used by save/publish. No store write, version increment or provider call. | Preview of an invalid check or condition fails before save; preview leaves `draft_revision`, published version, assignments, prices and case count unchanged. |
| `lib/flows/routes.mjs` | Add CSRF-protected `POST /admin/api/flows/validate` and `POST /portal/api/flo/workflows/validate` (or equivalent scoped routes) for unsaved schemas. The organisation route uses its workspace entitlements. Keep the existing saved-draft GET preview routes for compatibility. Return bounded issue objects `{path, code, message}`; never return secrets or stack traces. | Platform admin succeeds; signed-out, missing-CSRF, cross-workspace and unentitled requests fail. A validation call cannot create or mutate a workflow. |
| `api/flo-openapi.json` | Document request limits, issue shape and both authorization scopes, distinguishing unsaved validation from saved-draft preview. | OpenAPI parses and route contract tests match examples. |
| `test/flo-workflow-routes.test.mjs`, `test/flo-workflow-ownership.test.mjs` | Test valid and invalid previews, no-write behavior, CSRF, workspace isolation, allowed checks and a stale draft revision at save/publish. | No unauthorized schema read or write; conflict returns a recoverable message rather than overwriting another admin's work. |

**Gate 2:** the server can validate exactly the JSON the builder will save, without persisting it.

## Step 3 — create one shared builder model and renderer

| File | Implementation instruction | QA gate |
|---|---|---|
| `api-site/flo-builder.js` **new** | Expose a small, framework-free builder module used by both admin and organisation pages. Hold a cloned schema model; provide add, duplicate, delete, rename, reorder and property-update operations; emit one change event with generated JSON. Derive stable IDs from labels only at creation and resolve collisions. Maintain undo/redo for editing operations and an explicit dirty flag. | Unit tests prove every operation produces valid ordered JSON or a visible error; drag and keyboard reorder produce the same schema. Undo/redo restores the exact prior JSON. |
| `api-site/flo-builder.css` **new** | Style the palette, canvas, properties panel, validation summary, drag handles and compact mobile layout. Scope selectors to the builder so admin, Workflows and supplier styles do not collide. | No horizontal page overflow at 390px or 1440px; focus, selected item, invalid field and unsaved state are distinguishable without relying only on colour. |
| `package.json`, `package-lock.json`, `server.mjs` | Pin a reviewed SortableJS release and expose only its minified browser asset at a fixed same-origin path on the app host. Keep dependency files private, retain the current CSP, and avoid a general `node_modules` static route. | Production image serves only the named asset with JavaScript MIME type; no CDN request or permissive CSP change; mouse, touch and keyboard all reorder. |
| `test/flo-builder-model.test.mjs` **new**, `test/server.test.mjs` | Test model transforms independently of the DOM and the exact static asset route. Cover duplicate IDs, dependent conditions, deleting a field required by a check, copying nested items and import of existing JSON. | A potentially invalid move is rejected with a specific explanation; no silent reference loss. |

When a source field is moved after a dependent `show_if` rule, or deleted while referenced, stop the operation and show the affected items. When a field/document required by a selected check is removed, keep the edit in the draft only with a visible publish blocker; never silently deselect the check. Store unsaved changes only in page memory unless a later, explicitly designed recovery feature is added; do not put applicant data or schemas in browser local storage.

**Gate 3:** import existing schemas and exercise every builder operation before wiring Save or Publish.

## Step 4 — make preview match the applicant renderer

| File | Implementation instruction | QA gate |
|---|---|---|
| `flow-site/renderer/schema-view.js` **new** | Extract pure stage/field/document/declaration DOM rendering and conditional visibility from the current supplier app. Accept schema, draft, current stage and a preview flag; perform no fetch, session, upload or submit in this component. Use text nodes for labels/descriptions. | The same schema and draft render the same visible controls and required marks in preview and in a supplier session. Malicious label text stays inert. |
| `flow-site/renderer/app.js`, `flow-site/renderer/index.html`, `flow-site/renderer/styles.css` | Replace duplicated stage DOM construction with the shared view while retaining current session, save, upload, Restart and receipt behavior. Use the existing supplier bundle for published cases. | Current Supplier Onboarding and generic workflow UI smoke tests still pass on desktop/mobile; supplier submission and receipt do not change. |
| `server.mjs`, `admin-site/index.html`, `api-site/flo-workflows.html` | Serve the shared view module to the app host at one explicit path and load it on both authoring pages. Keep it separate from supplier network/session code. | The admin/organisation preview runs under the existing CSP with no cross-origin script, case API or provider request. |
| `scripts/smoke-flo-builder-ui.mjs` **new** | Compare preview and supplier form for a synthetic schema containing every field type, a condition, document slot and declaration; switch desktop/mobile widths and stages. | Visible labels, order, options, required state and condition behavior match. Preview cannot submit, upload or call `/flo/api/session`. |

**Gate 4:** preview is a reliable representation of the supplier journey, including conditional rules; the existing text-only summary is retired.

## Step 5 — replace the platform admin JSON-first editor

| File | Implementation instruction | QA gate |
|---|---|---|
| `admin-site/index.html` | Replace the dominant textarea with Builder, Preview and JSON tabs, a template list, validation summary and Save/Publish action bar. Keep the existing assignment and legacy-flow settings accessible. Load the shared builder/view scripts with versioned asset URLs. | Admin can find and edit both current stored workflows; assignment controls still work; JSON is readable but no longer required for creation. |
| `admin-site/admin.js` | Mount the shared builder on New, Copy and selected stored workflows. Feed generated JSON to the existing create/draft/publish routes. Call unsaved validation before save and again before publish; map issue paths to controls. Preserve `expected_revision`, copy lineage and current lifecycle actions. Surface a stale revision with Reload/compare options, without auto-overwriting local changes. | New → add/reorder → preview → save → publish → assign works by mouse and keyboard. A failed save leaves the local draft intact. Existing active template version remains unchanged until publish. |
| `admin-site/admin.css` | Integrate builder layout with current admin shell and leave the legacy settings panel visually separate. | 390px and 1440px screenshots show no overlap or clipped actions; the JSON tab and validation messages remain readable. |
| `test/flo-workflow-routes.test.mjs`, `scripts/smoke-flo-builder-ui.mjs` | Add platform authoring UI journey and assert generated schema equals the POST/PATCH payload. Cover copy, invalid condition, save, publish, assignment and active-org count refresh. | No raw HTML/JS template path; published version increments once; assigned organisation sees the new version only for new applications. |

**Gate 5:** a platform admin can publish a valid workflow without typing JSON, and cannot publish a schema that the supplier form cannot render.

## Step 6 — reuse the builder for organisation-owned copies

| File | Implementation instruction | QA gate |
|---|---|---|
| `api-site/flo-workflows.html`, `api-site/flo-workflows.js`, `api-site/flo-workflows.css` | Replace the organisation JSON-first textarea with the same Builder/Preview/JSON interface. Show assigned platform templates as read-only, with Copy to my workspace. Permit editing/publishing only on owned copies. Keep branding, callbacks, email templates and SMTP settings in their existing per-flow settings area. | An organisation admin can copy, edit and publish its own flow; cannot edit the platform source or another workspace's copy. Existing settings still save and secret values are not redisplayed. |
| `lib/flows/routes.mjs`, `lib/flows/workflow-service.mjs` | Reuse the scoped validation endpoint and current ownership/entitlement/publish checks; change only what the shared builder requires. | Revoked assignment, paused ancestor, missing Flo entitlement or price still blocks new links/publish as before. |
| `test/flo-workflow-ownership.test.mjs`, `scripts/smoke-flo-builder-ui.mjs` | Exercise two workspaces, copied flow lineage, publish and link creation. | One workspace cannot read/edit/preview the other copy; historical cases remain readable after pause/archive. |

**Gate 6:** platform and organisation editors produce the same schema for the same visual operations, with no authorization regression.

## Step 7 — accessibility, release and rollback

| File | Implementation instruction | QA gate |
|---|---|---|
| `.github/workflows/api-pr-checks.yml` | Run the new builder browser smoke beside `smoke-flo-ui.mjs`; keep syntax, unit and existing production checks. | Hosted PR CI passes on the reviewed SHA. A failed 390px layout or keyboard path blocks merge. |
| `scripts/smoke-flo-builder-ui.mjs`, `test/flo-template-schema.test.mjs` | Add keyboard-only reorder, Move up/down, touch/pointer drag, focus retention, live announcement, condition dependency, JSON round-trip and malicious-label scenarios. Test the actual admin and organisation pages, not only isolated controls. | All actions work without dragging; screen-reader labels identify item and position; no content or API call escapes preview. |
| `docs/flo/workflow-platform/README.md`, `docs/flo/README.md` | Link this guide and document Builder/Preview/JSON behavior, schema limits, check dependencies, version pinning and how to recover from a draft conflict. Remove statements that JSON editing is required. | Docs match the shipped UI and current production status. |

Release through a reviewed PR and the existing production workflow, keeping Flo enabled. After deployment, verify an unassigned synthetic platform draft and a copied existing 1.0.1 template, then exercise an owned copy in a controlled organisation. Compare exported JSON and definition hashes before and after an untouched import. Publish a **new** version for the pilot, create one controlled link, complete the supplier form, inspect Case Manager and confirm the callback. Do not mutate published 1.0.1 schemas or republish solely to change the authoring interface.

Rollback is a redeploy of the previous JSON-first UI against the unchanged saved-draft and API contract. Keep the JSON tab in the new UI so an editor defect does not strand draft work while rollback is prepared. Any new published version remains readable by its pinned applications; rollback must not delete schema versions, assignments, cases or reports. This upgrade needs no new Flo storage resource, Key Vault secret, verification adapter or production infrastructure template.

## Completion checklist

- [ ] Existing templates import and export without semantic change; untouched import does not increment a version.
- [ ] Platform and organisation admins can build, copy, preview, save and publish within their scopes without writing JSON.
- [ ] Drag, touch, keyboard and Move up/down produce identical ordering; invalid moves explain why.
- [ ] Every selected check has its required inputs/documents or a clear publish blocker.
- [ ] Preview matches the supplier renderer and never writes a case, uploads a file or runs a provider.
- [ ] Draft conflicts, invalid JSON and validation errors preserve unsaved work.
- [ ] Older version-pinned applications and code-owned flows still render and remain reviewable.
- [ ] `npm test`, desktop/mobile Flo smoke, new builder smoke and hosted PR CI pass; controlled live workflow confirms generated JSON, supplier UI, Case Manager and callback.

## Implementation references

- [SortableJS source and usage](https://github.com/SortableJS/Sortable) for a reviewed, self-hosted pointer/touch reorder dependency.
- [WCAG 2.2: Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements) for the non-drag reorder controls and keyboard QA gate.
