# Adverse media archive QA access RCA - 26 November 2026

Source checkout: `codex/adverse-media-advance-policy` at `9b309bada7f6fc625eb0645151ad2c69188e0c06`, with uncommitted candidate changes. Live readback observed 25 November 2026 around 18:55 UTC in subscription `Azure subscription 1`, resource group `rg-ai7uae-web-uaen-001`, UAE North. The private QA container was revision `ca-ai7uae-api-private-qa--0000055`, image `ai7uae-api@sha256:1ec78509d83a12e26521b4c7e830ebf2669dce954ccafd00dacf59585b45eae2`.

## Impact

The local QA run for Arbaz Uddin and Raj Malik could not read the archived media index. The QA runner's explicit 403 fallback supplied an empty archive branch and marked coverage incomplete. The first no-media reports labeled both results `Safe` without naming the unavailable source. Signed reports now retain `Safe` under the explicit no-media rule and disclose the coverage gap. Customer access to this candidate remains off.

## Root cause and evidence

- The active local Azure CLI account is an external human account with an inherited subscription `Owner` assignment. That management-plane role does not grant Azure Table data reads. Bounded reads of synthetic nonexistent rows in `GdeltEntitySummaryV2` and `GdeltEntityMentions` both returned HTTP 403 from the local account.
- The API runtime managed identity has `Storage Table Data Reader` and `Storage Blob Data Reader` on the dedicated GDELT archive storage account in UAE North, matching `infrastructure/api-gdelt-platform.bicep`. The existing `ca-ai7uae-api-private-qa` container uses that identity. The same synthetic table reads from that container returned HTTP 404, proving data-plane access without exposing a real row.
- The local runner used the CLI account for both the V2 summary and V1 postings. On 403 it returned an empty QA archive with `qa_source_gap: true`. This was a test-harness identity mismatch, not an archive outage or an article-extraction failure.
- Read-only point and bounded V1 range lookups inside the private QA container found zero rows for each of the two names and their reviewed Arabic/Hindi variants in the tested range. That observation does not prove complete coverage through 25 November: the archive watermark available to the run was 25 November 2026 01:30 UTC, before that day's end.

## Correction

- The public report returns `screening_result: "Safe"` whenever discovery retains no media. Source completeness is reported separately.
- Public JSON identifies `coverage.unavailable_sources: ["archived_media_index"]` for the degraded run. The one-page PDF uses a `SAFE` result and names the unavailable archived media index, limiting Safe to sources searched.
- The QA runner now selects the Container Apps managed identity for Blob/Table reads and Key Vault secret reads when `IDENTITY_ENDPOINT` and `IDENTITY_HEADER` are present. `QA_REQUIRE_MANAGED_IDENTITY=true` fails before any source call if it is accidentally run outside that environment. A private QA container readback confirmed that the runtime identity can read both archive tables (synthetic missing-row lookups returned 404) and both existing discovery credentials (presence only was logged). This candidate runner has not yet been deployed to that container.
- The local QA runner remains explicit about its degraded fallback. It has not been given the runtime identity's access or a new role assignment. The normal API archive path remains fail closed.
- Both subjects were rerun through the direct report API with the reviewed name spellings. The source results are in the private `output/adverse-advance-qa-2026-11-26/arbaz-raj-rca-corrected/` directory; zero-cost report projections and re-signed preview copies were subsequently made from those results to reflect the no-media Safe rule. The original two-check modeled variable cost was $0.060064.

## Verification and remaining gate

The four targeted test files listed in `docs/adverse-media-incident-final-report-api.md` pass (24 tests), including complete-source Safe, incomplete-source Safe with a named coverage limit, and extraction-failure behavior. No Azure resources, RBAC assignments, secrets, or deployed revisions were changed.

To validate complete archive coverage end to end, run the reviewed candidate in the existing private QA container under its managed identity with `QA_REQUIRE_MANAGED_IDENTITY=true` and a closed request window fully covered by the committed archive watermark. The currently deployed private QA image predates the V2 paging helper in this candidate. Releasing that image requires the normal reviewed build and deployment process; a local CLI-user role grant is not the intended fix. Until then, the local 403 fallback can test the Safe result with a disclosed coverage gap but cannot certify complete archive coverage.
