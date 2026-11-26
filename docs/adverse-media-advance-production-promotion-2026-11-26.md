# Adverse Media Advance production promotion gate

Candidate source: `66b81af137cbabb4f701fc8fb67797793e579140` plus the admin integration change on PR #157. Customer access remains off.

## Credential setup

The admin integration catalog now has `adverse-media-jev` for the TypeSafe screening key and `adverse-media-summary` for the Mistral name-variant and summary key. An administrator can set their master credentials through the existing integration credential flow. The report API reads these server-side keys; it does not accept them from a report caller. Do not paste credentials into source, CI variables, or a PR.

## Why this source is not yet a production activation

1. PR #157 is draft and stacked on `codex/gdelt-versioned-summary`, not `main`. Its hosted check passed, but it is neither reviewed nor merged. The repository workflow builds and deploys on a push to `main`; its configured `ai7uae-api` environment currently targets `ca-ai7uae-api-private-qa`, while the customer API is `ca-ai7uae-api`. No reviewed promotion path to the customer app has been demonstrated for this candidate.
2. The candidate's one-call JSON/PDF report is `POST /internal/adverse-media-advance/report-test`, gated by `ADVERSE_MEDIA_JEV_API_ENABLED` and an internal bearer token. The customer `/service/adverse_media_advance` route still queues the existing Advance pipeline and uses its older classifier and report finalizer. Turning on `ADVERSE_MEDIA_ADVANCE_ENABLED` would enable that older route, not the new Jev/Mistral report path.
3. The owner has authorized an interim JSON plus unsigned-PDF response while a trusted certificate is deferred. The internal report endpoint now has an explicit unsigned mode that marks the JSON and PDF accordingly. This mode is not yet wired into a customer route or deployment configuration. A future signed release needs the production Key Vault certificate/secret reference and trust chain.
4. Four recent QA reports were generated with the archive source explicitly unavailable to the local QA principal. The runtime managed identity can read the archive, but the exact candidate has not completed an archive-backed end-to-end run under that identity. The last cohort had zero adverse incident groups, so it did not exercise a live Mistral incident-summary call.
5. Per-policy adjudication is `not_run` in this candidate. Existing Advance entitlements, idempotent admission, polling, callback, cost accounting, persisted evidence, and report retrieval cannot be replaced by the synchronous internal test route without a reviewed compatibility and migration design.

## Safe promotion sequence

Review the stacked source and land an explicit customer-route migration while preserving the existing customer contract or versioning it. Build once from reviewed `main`, retain the digest and deployment evidence, deploy the same digest to the private QA app, configure the two credentials in its admin integration panel, and run archive-backed adverse and no-adverse cases in the explicitly selected unsigned mode. After the customer app target, settings, and rollback are verified, promote that digest through the approved production workflow and only then enable customer access. A code-only deployment with both customer and internal gates off is safe, but is not an activated Adverse Media Advance service.
