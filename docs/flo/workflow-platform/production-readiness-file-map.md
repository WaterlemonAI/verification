# Flo workflow platform: production readiness file map

Status: user-directed live rollout in progress. The workflow platform defaults on when Flo is enabled; `FLO_WORKFLOW_PLATFORM_ENABLED=false` remains the emergency pause. This file records the source checks and the live evidence still to collect.

## Evidence checked on 10 November 2026

- Production GitHub environment `ai7uae-api` has `FLO_ENABLED=true`. The latest `main` API deployment at `428c8f5` succeeded. A merge touching these paths triggers `.github/workflows/deploy-api.yml` and deploys production automatically.
- PR #142's hosted `test` check passed at `9185f72`; the PR had no approval at review time. The repository suite, login, Case Manager, Ejari and Flo browser smoke passed at desktop and mobile widths. The default-on change must pass these gates again before merge.
- `flo-staging` was not found through the repository environment API, and no `deploy-flo-staging.yml` run was listed. No hosted staging journey, Azure `what-if`, production SMTP delivery, callback delivery, or provider-result validation has been observed for this release.
- Read-only production HTTP checks returned `200` for the API health path and buyer login. The Flo hostname rejected an invalid application URL with `404`. These checks do not prove an authenticated or paid journey.
- The local production-dependency audit reported zero vulnerabilities, the modified workflow YAML parsed, the API and Flo storage Bicep templates compiled, and the Ejari Python suite passed in an isolated environment. An API Docker build was attempted but the local Colima daemon was unavailable; image-build evidence must come from the hosted deployment workflow.

## Minimum source file map

| Gate | Files | Required behavior | QA evidence |
| --- | --- | --- | --- |
| Separate rollout switch | `infrastructure/api.bicep`, `.github/workflows/deploy-api.yml`, `server.mjs`, `lib/flows/routes.mjs`, `api-site/portal-auth.js`, `admin-site/index.html`, `admin-site/admin.js`, `scripts/smoke-flo-ui.mjs`, `test/flo-portal-link.test.mjs` | Keep `FLO_ENABLED` for the existing live service. Default `FLO_WORKFLOW_PLATFORM_ENABLED` to true when Flo is enabled; an explicit false pauses new authoring, workflow management and schema-defined links while old links and cases remain usable. | Test both flag states and legacy compatibility. Bicep build; production `what-if` must show the new switch on and no unexpected resource changes. |
| Assignment revocation | `lib/flows/workflow-service.mjs`, `lib/flows/routes.mjs`, `test/flo-workflow-ownership.test.mjs`, `test/flo-workflow-routes.test.mjs` | A paused platform assignment makes its organisation copies ineffective and removes them from the new-link list. Existing applications remain reviewable. | Pause a source assignment after a copy is published; no new link or visible selectable flow; resume restores availability. |
| Durable notification recovery | `lib/flows/notifications.mjs`, `server.mjs`, `test/flo-notifications.test.mjs` | Rotate reconciliation through the full workspace case list, not only the newest 200, while bounding work per pass. | Queue an undelivered event on case 201; successive passes reach it exactly once. |
| Premerge staging proof | `.github/workflows/deploy-flo-staging.yml`, `scripts/prepare-flo-staging.mjs`, `test/flo-staging-config.test.mjs` | Permit an approved PR head with a successful exact-SHA `test` check to run in the separate staging environment; keep production resources and hosts excluded. Enable the new workflow switch in staging. | Verify reviewed SHA, staging resource separation, Bicep build/what-if, digest-pinned image, and staging UI journey before merge. |
| Mobile workflow management | `api-site/flo-workflows.css`, `scripts/smoke-flo-ui.mjs` | Long flow IDs and card content wrap within a 390 px viewport after the portal sidebar loads. | Desktop and mobile browser smoke report no document overflow. |

## Remaining release gates

1. The separate `flo-staging` GitHub environment is absent, so the planned hosted staging journey cannot run. The user directed a default-on live rollout. Recheck the production workflow's `what-if` and deployment before using a controlled live workspace; record the staging omission as an unverified gate.
2. Verify each enabled provider's actual result or explicit `not_run`, document scanning, report versions, signed callbacks, and applicant email through both platform and configured organisation SMTP. Check SPF, DKIM and DMARC for the real sender domain. Watermarked sample documents establish transport and review behavior, not genuine issuer authenticity.
3. Confirm the production merge `what-if` sets `FLO_WORKFLOW_PLATFORM_ENABLED=true` with no unexpected resource changes; monitor the automatically triggered production deployment and existing Flo paths. The variable is global, so workspace assignment and entitlement remain the tenant controls. Set the GitHub environment variable to `false` and redeploy if the new platform must be paused.
4. Existing `kys-v1` and `supplier-onboarding-v1` are code-owned compatibility flows. They are still available in the Case Manager and link selector but have no validated schema to copy or edit in Workflows. The earlier plan explicitly deferred schema parity. Do not claim the “copy every assigned flow” requirement is met until a pinned parity schema and tests are added.
5. The current platform and organisation preview screens summarize stage counts instead of rendering the actual form, and the platform screen does not expose its copy route. These are product acceptance gaps for general self-service. Keep rollout controlled until those screens and keyboard/mobile review are accepted.
6. Email and callback work share the `flo-callbacks` queue. The rotating reconciler prevents permanent starvation from a fixed 200-case window, but queue capacity, dead-letter handling and callback/email contention still need a staging load test before broad enablement.

No production mutation or paid supplier submission was performed during the source readiness review. The user has now authorized the default-on live rollout; record the actual deployment and controlled-workspace journey separately.
