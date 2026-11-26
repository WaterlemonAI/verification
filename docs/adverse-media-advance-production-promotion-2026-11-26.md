# Adverse Media Incident Screening production promotion gate

This is a **new KYCProbe API**, with product ID `adverse-media-incident-screening` and endpoint `/service/adverse_media_incident_screening`. The existing `/service/adverse_media_advance` route, its entitlement, rate, callback contract, and release switch are unchanged. See [the new API contract](adverse-media-incident-screening-api.md).

As read back on 2026-11-26, the customer app `ca-ai7uae-api` was still on revision `--0000093`, image digest `sha256:e8efcef74a0920a00a59dcf11e822543ab3f58f2dd3a9344263dabd3c86d9285`. The GitHub `ai7uae-api` deployment environment targets `ca-ai7uae-api-private-qa`. PR #156 and stacked PR #157 were both draft and unmerged. Refresh these facts before promotion.

## What the new source provides

- Its own admin catalog entry, entitlement, rate, and default-off `ADVERSE_MEDIA_INCIDENT_SCREENING_ENABLED` switch.
- An authenticated, idempotent 202 submission route; separate queue and dead-letter queue; polling route; and workspace-private PDF route.
- A worker using the existing incident screening engine, with a 40-article maximum, global `all` profile, public JSON, and explicitly unsigned PDF. A successful completed check keeps one charge; failure is refunded. Interrupted jobs fail and refund rather than repeating provider calls without a checkpoint.
- A separate QA queue name for parallel deployment, so the new worker cannot consume older Advance jobs. The old API and queue remain in place.

## Remaining release gates

1. Review and merge PR #156 and PR #157 into `main`, including the new API. The hosted tests and Bicep build must pass on the final source SHA.
2. Deploy to the private QA app with the new switch enabled only after its runtime identity can read the archive and the dedicated QA queue. In its admin integration panel, set `adverse-media-jev` for TypeSafe, `adverse-media-summary` for Mistral, and `adverse-media-article-extraction` for Event Registry full-text extraction. Confirm the existing Brave credential is available. The current production vault does not contain a secret named `event-registry-api-key` (read back 2026-11-26), so do not rely on that runtime secret without provisioning it. Do not place credentials in source, CI variables, or a PR.
3. Call the **new public endpoint** from an entitled synthetic QA workspace with its own configured rate. Complete an archive-backed adverse incident case, a no-adverse Safe case, an idempotent replay, a provider failure/refund, a cross-workspace denial, and PDF retrieval. Check response times, cost audit, and that no internal provider names appear in returned JSON or PDF.
4. Review the new `promote-incident-api.yml` workflow. After a successful QA build from the same `main` SHA, run it with that workflow's run ID and attempt. It verifies the retained artifact and ACR digest, previews and provisions only the dedicated production queues, records the prior production digest, and promotes the **same immutable image digest** to `ca-ai7uae-api` with the new switch off. Do not temporarily retarget the existing QA workflow variable or rebuild a feature branch for production.
5. Read back the exact production revision and configuration, enter the three admin credentials there, enable the new product switch, assign its separate entitlement and rate to selected customer workspaces, and run one authenticated synthetic check. Verify 202 admission, polling, final JSON, private unsigned PDF, and one charge before calling it live.

The owner deferred the PDF signing certificate and authorized JSON plus unsigned PDF. Certificate setup is therefore not a release blocker. The QA end-to-end proof, credentials, reviewed main build, and review/execution of the production promotion workflow are still required.
