# KYCProbe release status — 27 October 2026 (Dubai)

This snapshot was taken before the live deployment. See [the current live evidence](platform-live-evidence-2026-10-27.md) for the verified production state and remaining gates.

## Production currently serving

- API Container App revision `ca-ai7uae-api--0000065`, image digest `sha256:baca8d297e69a02a2a6168c4f83553ce5ee770005ce95d1287b63d64454eeeb2`, is ready. It contains the narrow adverse-media retry-containment release from PR #76.
- `ADVERSE_MEDIA_WORKER_ENABLED=false`. Three old adverse-media queue messages remain paused with observed dequeue counts 216, 226 and 232. Their historical failure stage cannot be proved from the old logs. The dedicated Forms queue had zero visible messages at the latest authorized peek.
- The live Gemini credential returned HTTP 429 `RESOURCE_EXHAUSTED` at 2026-10-26 20:59 UTC. A positive live Signzy Search+ probe found the exact MediaNama data-leak article but was `partial` and decision-ineligible because classification was incomplete. Standard search in the current live revision missed that article.

## Candidate in draft PR #77

- Provider components are checkpointed separately; only missing search components retry. Gemini runs once after searches finish or controlled source retries are exhausted. Callback delivery only retries the saved final response; it never repeats Brave, Gemini or PDF generation. Legacy version-1 jobs are quarantined before any provider call when the new worker is enabled.
- All billable API requests use bounded per-service lanes. The assumed target mix is 10 QPM AML/entity and trade licence, 20 QPM IBAN, and 30 QPM each adverse media and bank statement analysis. API replicas scale from one to eight. These traffic figures are not supplier quotas; provider-wide limits remain to be confirmed.
- Forms use the same lanes for each selected API, checkpoint each completed component, and retry only missing work. After controlled capacity retries, an unavailable component yields a final partial, decision-ineligible result and refund for that selected API. Forms use a durable submission idempotency claim before credit admission; accepted replays do not duplicate jobs or charges. The first submission ID equals its transaction ID for log, callback and PDF correlation.
- Forms callback, settlement and report stages are independently bounded; exhausted infrastructure failures go to a dedicated dead-letter queue. Portal API-key creation is idempotent and serializes the cross-replica 20-active-key limit with a workspace Blob lease. The candidate adds a broad web query that directly targets the previously missed MediaNama Signzy article.

## Verified locally

- Integrated Node suite passed 146/146 after the Form checkpoint and target-burst tests. Focused Form suite passed 17/17 and capacity suite passed 7/7. JavaScript syntax, diff checks and Bicep build passed on the candidate. PR #77 now runs a clean GitHub test job on updates; its first run is pending at the time of this record.
- A controlled failing-callback test causes one screening's provider calls and zero additional Brave/Gemini calls on delivery retries. Form duplicate submission and prepaid tests show one queue write and one USD 0.20 reservation across first acceptance plus replay; failed queue admission is refunded.
- The 100-request burst mix (10+10+20+30+30) completed in a local capacity harness without exceeding global or service concurrency. This is a capacity test, not a hosted load benchmark or supplier performance guarantee.

## Gates before regulated go-live

1. Restore Gemini quota, then pass live positive-evidence, no-material-evidence, partial-outage, final callback and public PDF smokes. Keep the adverse worker paused until legacy jobs are quarantined and callback retry proves zero additional provider calls.
2. Deploy the reviewed PR through the protected GitHub workflow with `enableDeepResearchWorker=false`; verify exact digest/revision, Azure what-if, alert routing and health. Confirm runtime Blob lease and Forms Azure Table idempotency under hosted storage, plus credit/refund ledger reconciliation.
3. Complete P0 identity/email/DKIM and app-host session tests, then the P1 provider-backed contract, callback/report, accessibility and responsive UI matrix in `platform-ui-go-live-task-list-2026-10-26.md`. Record source response, transaction ID, cost and evidence for each.
4. Obtain operations, finance and security/privacy sign-off on the live evidence and the partial-result policy. A healthy transport or passing local test is not approval for automated regulated decisions.
