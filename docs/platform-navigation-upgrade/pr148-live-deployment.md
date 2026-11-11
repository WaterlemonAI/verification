# PR #148 live deployment runbook

**Release:** customer workspace navigation and account views. **Target:** the existing production KYCProbe API Container App. **Date:** 11 November 2026. This runbook is deliberately limited to PR #148; it does not enable a new Flo flow, provision storage, change secrets, migrate data, or run chargeable verification checks.

## Recorded baseline and scope

- Before this release, `main` was `bef5557377d505ccbc6339276cf62432e853dfc7`. Reconfirm it immediately before merge.
- Production resource group: `rg-ai7uae-web-uaen-001`; API app: `ca-ai7uae-api-private-qa`. At planning time its image was `acrai7uaeuaen001.azurecr.io/ai7uae-api@sha256:245cff4476a773f022581e2033c65a20e2bec2fb25b29ae3db0edbff80254e43`, revision `ca-ai7uae-api-private-qa--0000050`, single-revision mode, 100% traffic to latest. **Capture these again immediately before merge; use the fresh image digest as the rollback target.**
- The `ai7uae-api` GitHub environment had `FLO_ENABLED=true`, `CASE_MANAGER_DESIRED_ENABLED=true`, `CASE_MANAGER_EMERGENCY_OFF=false`, `CASE_MANAGER_MAINTENANCE_ENABLED=true`, and `DOCUMENT_OCR_ENABLED=true`. Keep these values unchanged for this release.
- The document OCR worker is `ca-ai7uae-ocr-qa`; at planning time it ran `acrai7uaeuaen001.azurecr.io/ai7uae-document-ocr-worker@sha256:2da0e9f965ae1a5d1ef58344bddce3e55bb554c06584fd40c959e0f6eeeaab43`, revision `ca-ai7uae-ocr-qa--0000039`. Capture its live digest again immediately before merge.
- PR #148 changes the API image, portal HTML/JavaScript/CSS, usage read/export code, and tests. It does not change `infrastructure/api.bicep`, workspace data schemas, or published workflow templates.
- A merge into `main` automatically starts `.github/workflows/deploy-api.yml`. Do not also dispatch it manually. The workflow has no environment approval pause. It builds a digest-pinned API image, verifies the Flo and Case Manager prerequisites, runs Bicep `what-if`, and applies the full API Bicep template. It also builds a document OCR worker image unconditionally; inspect the resulting worker image and revision even though PR #148 changes no OCR worker source. Other worker image steps may reuse their pinned digests when their source and live image match.

## Before merge

1. Confirm PR head is the reviewed commit plus this documentation-only commit, CI is green, and the PR is mergeable. Confirm `main` has not advanced unexpectedly. The new documentation commit must not alter runtime or workflow files.
2. Record the API image digest, active revision, traffic, FQDN, and enabled feature flags from the live app. Record the document OCR worker image and revision, because the workflow rebuilds its image.
3. Confirm the existing AI7LAB UAE workspace can open Flo and API Case Manager. Keep one signed-in organisation-admin session for the post-deployment read-only check. Record the current menu and account routes as a visual baseline.
4. Confirm no other production deployment is running. The workflow uses the `ai7uae-api-production` concurrency group with `cancel-in-progress: false`; a queued run must be understood before merging.

## Merge and automatic deployment

1. Mark PR #148 ready, then merge it with a merge commit so the reviewed PR commits remain traceable. Record the merge SHA and resulting `Deploy AI7 UAE API` run ID.
2. Watch that single `push` run through tests, immutable-image build, private-path checks, Bicep validation, `what-if`, deployment, and evidence upload. Do not set any provisioning inputs or change environment variables. If a preflight fails, stop; do not bypass it with a manual update.
3. In the `what-if` output and deployment evidence, expect the API image/revision and the workflow's normal document OCR image rebuild. Investigate any proposed deletion, storage, identity, certificate, ingress, traffic, Flo, or Case Manager policy change before accepting the release. The workflow does not pause between `what-if` and create, so cancel immediately if such a change appears; if deployment already applied it, use the rollback procedure.
4. Check that the deployed API image equals the run's recorded digest, the API is healthy, and production traffic still points 100% to the intended app. Retain the workflow evidence artifact and rollback digest with the release record.

## Read-only production acceptance

Use the existing AI7LAB UAE organisation-admin workspace; do not submit a chargeable verification or create a supplier case solely for this navigation release.

1. Open `/home`, `/flo`, `/flo-workflows`, `/cases`, `/account`, `/usage`, and `/api-keys` on `app.kycprobe.com`. Verify the menu order, active item, Flo and API Case Manager availability, and the distinct account views. Check a Form detail and an OCR detail route without uploading a document.
2. Verify Usage loads and date/module filtering changes the rows. If exporting, use a narrow controlled UTC range and check that the CSV contains only that workspace's usage. Do not create, rotate, or revoke a production API key.
3. Check a desktop and narrow mobile viewport: menu opens and closes, Escape restores focus, long lists scroll, and no horizontal overflow appears. Confirm a temporary catalog failure shows Retry if naturally observed; do not induce an outage in production.
4. Confirm normal login return paths and that a first-time key remains on `/api-keys` only if a controlled first-time account is available. Otherwise rely on the browser regression for this path.
5. Observe the deployment and application logs for unexpected 4xx/5xx spikes and JavaScript errors during a short post-cutover watch. Treat inaccessible Flo/Case Manager, wrong workspace data, failed auth routing, or key exposure as rollback triggers.

## Rollback

If the workflow fails before it changes the live API image, retain the previous revision and investigate; do not start a second deployment blindly. If the new image is live and acceptance fails, update **only the API app image** to the freshly recorded pre-merge digest using `az containerapp update --resource-group rg-ai7uae-web-uaen-001 --name ca-ai7uae-api-private-qa --image <PRE_MERGE_API_IMAGE_BY_DIGEST>`. Verify the new rollback revision, health, 100% traffic, Flo, and API Case Manager. If the document OCR worker changed and shows a regression, restore its separately recorded digest through the reviewed operations path. Follow with a revert PR to prevent the next main-branch deployment from restoring the faulty code. Never rotate keys, change retention, disable Flo, or alter Case Manager settings as a UI rollback.

**Done:** hosted deployment succeeded; its source SHA and image digests are recorded; the live navigation and account routes pass the read-only workspace check; no unrelated resource change or error spike is observed. Until then, report the release as deployed but under verification rather than complete.
