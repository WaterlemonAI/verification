# KYCProbe P0 verification record — 26 October 2026

**Candidate:** `codex/platform-p0-p1-fixes`, based on `8383894ad1458e71691c629b415a4bfc640de2e8` (`origin/main`).

**Test environment:** isolated local checkout and in-memory synthetic server on `127.0.0.1:4199`. Test accounts, keys, providers, callback targets and credits were synthetic. No production customer balance or key was changed.

## Implemented and verified locally

| P0 area | Evidence | Result |
| --- | --- | --- |
| Key UI crash and lifecycle | Customer UI create/rotate/revoke; admin registry owner and revoked state; server tests for CSRF, old-key invalidation, other-workspace isolation and 20-active-key limit | Pass locally |
| Forms validation and billing order | Blank UI Form stopped before request; invalid authenticated Form receives 400, zero cost and no queue; valid synthetic Form receives 202; disabled selected module receives 403 and zero cost | Pass locally |
| Billing and entitlements | Admin rate save/reload, USD 0.30 initial Form+service charge, USD 0.15 second-tier charge, 402 on insufficient credit, customer/admin UTC ledgers, hidden disabled module, direct 403 | Pass locally |
| Credit audit | Atomic Azure Table balance+audit adjustment, idempotent credit request, UTC amount/actor/ID in admin UI; tests for six-decimal precision, currency lock, concurrent duplicate requests | Pass locally |
| Login feedback | Empty email/password blocked locally; valid synthetic sign-in, key creation and account navigation work | Pass locally |
| Adverse-media outage behavior | Forced paid 402 plus free 429 returns customer-safe 502 with `SEARCH_SOURCES_UNAVAILABLE` and transaction ID; logs contain source status codes and no subject | Pass locally |
| Monitoring template | API 5xx metric alert and adverse-media source-failure log alert target the dedicated AI7 UAE API and action group | Bicep build and Azure deployment validation pass; alert firing not yet tested |
| API hostname in Form docs | Copied Form endpoint uses `api.ai7uae.com` on hosted pages; local development uses local origin | Code review; hosted verification awaits deployment |

`npm test`: **106 passed, 0 failed** after the backend and availability-filter changes. The final field-level UI validation was checked in the local browser and with `node --check`; it does not change the server test suite. `az bicep build` and `az deployment group validate` passed for `infrastructure/api.bicep` with the current digest-pinned AI7 UAE images and certificate IDs. The validation was read-only.

## P0 gates still open

1. **Live adverse media:** the Key Vault credential is enabled, but a synthetic Brave web query returned HTTP 402 on 26 October at 19:02 UTC. Hosted GDELT returned HTTP 429 in the earlier probe. The user is resolving Brave billing. A real positive-evidence/no-result/partial/callback/PDF smoke cannot pass until at least one reliable source is available. A forced outage remains decision-ineligible.
2. **Monitoring:** alert resources are staged in Bicep and validated. They need a reviewed deployment, action-group email confirmation, a test firing and an on-call owner before this P0 is complete.
3. **Forms commercial policy:** malformed requests cost zero. Admitted Form requests are charged at submission; a subsequent queue write failure returns 503 without automatic compensation. The provider-error and never-queued-job charge/refund policy needs finance/product approval before go-live. Do not advertise Form billing as fully reconciled until this is resolved.
4. **Forms idempotency:** worker retries reuse stored results and do not rerun checks; separate duplicate client submissions can still create separate jobs and charges. A durable submission idempotency contract is required before broad rollout.
5. **Key creation under retry/concurrency:** the UI now distinguishes a successful creation from a failed list refresh. If the create response itself is lost after the server commits the key, a manual retry can still create another key. The 20-active-key limit is checked before creation but is not an atomic cross-replica limit. Request idempotency and a durable workspace lock/reservation are needed for full P0 sign-off.
6. **Production identity/email:** SPF, DMARC, MX and app/API DNS were observed. The SMTP secret is enabled in the dedicated Key Vault. DKIM, controlled end-to-end mail delivery, invitation/recovery in the deployed UI and app-host cookie behavior still need staging/live proof.
7. **Live UI and P1:** changes remain in the candidate checkout. The deployed UI still serves the previous revision. P1 provider-backed contracts, callback/report persistence and accessibility/responsive testing are on hold under the requested P0-before-P1 order.

## Go-live rule

Keep this candidate out of production until the remaining P0 gates have passing evidence. After P0 clears, run the P1 matrix from `docs/platform-ui-go-live-task-list-2026-10-26.md`, then review the PR and deploy through the protected workflow. Preserve transaction IDs, callback receipts, alert firings and revision/digest evidence in the release packet.
