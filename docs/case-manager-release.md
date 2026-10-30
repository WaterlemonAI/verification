# Case Manager release and support checklist

Case Manager is an optional copy of verification results. Keep production capture and every customer workspace policy off until the checks below pass. The separate internal QA app is enabled only for disposable synthetic testing. This checklist does not authorize customer traffic or change retention in the original service stores.

## Decisions to record before enabling customer workspaces

- Workspace access: every signed-in user of the same workspace can read its cases, raw final responses and recorded artifacts. API keys alone cannot read case history. Approved by the product owner on 2026-10-30.
- Successful UAE trade licence, IBAN, entity search and dynamic integration responses remain `Unclassified` until their business response contracts are reviewed. Approved by the product owner on 2026-10-30.
- Customer text states that Case Manager TTL applies only to its copy. Adverse-media JSON, OCR source data, BSA source data and public or permanent PDFs follow separate retention. Approved by the product owner on 2026-10-30.
- Completed eligible adverse-media and merchant screenings display **No material findings**; partial coverage remains **Review required**. This wording was approved on 2026-10-30 and does not assert legal or credit clearance.
- Storage must be accessible only through private endpoints before any Case Manager QA. The new VNet-integrated private runtime and Blob/Table/Queue endpoints are provisioned, and a managed-identity running-container probe has verified all three private paths. No public-network exception is approved.
- Reads stop immediately at expiry or opt-out; physically delete Case Manager copies within 24 hours. This target was approved on 2026-10-30 and must be demonstrated in Azure-backed QA.
- Peak traffic and added-latency objective remain provisional. The code and synthetic results alone do not settle these items.

The proposed comparison objective for Azure-backed QA is no more than **+100 ms p95** and **+250 ms p99** versus the same private runtime with capture off. This is a test objective, not an achieved result. The provisional peak is 90 QPM; run the planned mixed load at 180 QPM and record failures and lag even if latency misses the objective.

## Azure evidence on 2026-10-30

- The running-container private-path probe `caj-ai7uae-cm-private-probe-uom8ham` succeeded with private DNS and managed-identity Blob, Table and Queue CRUD.
- The manual synthetic smoke job `caj-ai7uae-cm-azure-qa-i68t90w` succeeded: exact 230,597-byte response, signed-in portal retrieval, workspace isolation, API-key-only denial and physical Blob/Table/index purge of a controlled fixture. The isolated QA table/container smoke `caj-ai7uae-cm-azure-qa-dwas9zn` also succeeded. A later audit found the runner's final cleanup checked a different fixture workspace. The guarded cleanup execution `caj-ai7uae-cm-azure-qa-o54zl7u` verified only allowed synthetic rows, deleted **363** original-table and **362** QA-table case copies, and confirmed zero remaining case rows in both tables. The runner was fixed to clean its captured workspace.
- The first Azure-backed 180 QPM run `caj-ai7uae-cm-azure-qa-7f2h7c0` succeeded with 360 capture-off and 360 capture-on calls over two minutes per phase. There were zero HTTP failures and all 360 capture-on cases were recorded. With 230,597-byte synthetic responses, capture-off p95/p99 were 7/9 ms and capture-on p95/p99 were 169/190 ms, or **+162/+181 ms**. The +100 ms p95 objective was **missed**. This was a synchronous dynamic integration using fake supplier data; it did not measure cost or a 24-hour deletion observation. The run used the private account's original metadata names before the QA-specific names were provisioned; its cases were physically removed by the guarded cleanup.
- The isolated synthetic OCR/BSA reconciliation execution `caj-ai7uae-cm-azure-qa-o9zb5zz` offered and completed **360** queue messages at 180 QPM over two minutes. There were zero errors, remaining messages or dead letters. Measured receive age was **1.315 s p95**, **1.382 s p99** and **1.405 s max**. The source results were fake terminal records; this does not prove real OCR/BSA workers, callbacks or Forms.
- The corrected isolated smoke `caj-ai7uae-cm-azure-qa-kytfmu2` succeeded with a real private Azure PDF upload/download through the signed-in case artifact route, 401/404 denial for unauthenticated and other-workspace reads, and durable retirement after a simulated queue-send failure. It confirmed the Case Manager Blob was physically gone while the separate source artifact still existed, then removed that synthetic artifact explicitly. Its finalizer verified zero cases in its disposable workspaces.
- The later internal QA redeployment `cm-api-qa-final-20261030` succeeded with digest `sha256:dd44eeeee9fd64e36acc21ac1c7f8a0199ccc171cfb423b90f5cae2624ea1678`; readback kept Case Manager on in the **internal QA** app, selected `CaseManagerQaMetadata`, left shared Forms/adverse queues absent, and left the production API on its prior digest with no Case Manager variable. This is not a production routine-deployment test.
- The internal API `ca-ai7uae-api-private-qa` has internal ingress, the corrected `id-ai7uae-api-runtime` identity, and the separate `CaseManagerQaMetadata` table, `case-manager-qa-private` Blob container and `case-manager-qa-reconcile` queue. Its BSA, OCR, Forms and adverse-media production queue consumers remain off. The production API, DNS and customer capture were unchanged.

## Packaging and Azure preview

1. Confirm the reviewed PR head, clean worktree, passing exact-head CI, and immutable API image digest. Do not substitute a mutable image tag.
2. Preserve the provisioned VNet-integrated API runtime, private endpoints and DNS. The production workflow still blocks automatic Case Manager provisioning. Re-run the running-container private-path probe after network, storage or identity changes.
3. The dedicated Case Manager encryption key exists in KYCProbe Key Vault. Verify managed-identity access, disabled shared-key authorization, disabled public Blob access, disabled public storage network access, and runtime data-plane access over the private endpoints. Do not print the key.
4. Run the API infrastructure what-if with the exact release digest and the intended values of `CASE_MANAGER_DESIRED_ENABLED`, `CASE_MANAGER_EMERGENCY_OFF`, and `CASE_MANAGER_MAINTENANCE_ENABLED`. Review every proposed change to the existing API and jobs before promotion.

The [private-network inventory and cutover runbook](case-manager-private-network.md) records the 2026-10-30 readback, applied network and storage, successful private-path probe, internal parallel API, worker handoffs, certificate/DNS sequence and rollback boundaries. The isolated QA image and previews **do not satisfy** the production exact-release-digest API what-if. CIDR overlap, cost and quota still need review before traffic promotion.

## Disposable workspace QA

Use synthetic subjects and documents. Enable one disposable workspace with a one-day TTL; leave other workspaces off.

1. Confirm no backfill. Submit one check with Case Manager off, then opt in and submit another. Only the later check should appear.
2. Submit one direct check from each current service, one administrator-configured integration, and one Form with multiple children. Verify the case count, final body, status badge, attempt IDs, and original API response remain correct. A Form child must not create a separate case.
3. Exercise OCR and bank-statement `202` receipts through completed and failed terminal states. Check the saved final response, source-independent case artifact link, and no extra supplier, OCR, Brave or Gemini calls. A failed BSA job should finish as `Could not complete` with its public 422 response.
4. Force a callback failure after a saved adverse-media or Form result. Retry delivery, then verify there is one logical case, one provider run, and one final result. Retry an idempotent submission and find the same case by both transaction IDs.
5. Verify the case list filters by time, service, outcome and exact transaction ID. Open the service-specific overview, raw JSON, copy action and PDF or other artifact on desktop and mobile. Render hostile strings as text.
6. Complete the new portal and admin email-code sign-in journeys with controlled mailboxes before using a real workspace. Check that first-time setup creates no session, the initial API key appears only after code verification, and SMTP or challenge-store failures issue no session.
7. Sign in to a second workspace. Its session must get 404 or an empty list for the first workspace's case, transaction ID and artifact. A Bearer API key alone must not access case-history routes.
8. Shorten the TTL and opt out. Reads must stop immediately; the due retirement task must delete only the Case Manager copies. Re-enable later and confirm old cases do not reappear. Inject a queue failure and verify the durable due task still completes physical deletion.

## Load, retention and rollback gates

- Run Azure-backed sustained traffic at twice the approved peak with representative response sizes and a mix of synchronous, OCR, BSA and Form jobs. Record API p95/p99 added latency, capture failures, queue age p95/p99/max, dead letters, cost and storage growth. The memory-store benchmark is not this gate.
- Prove the expiry purge keeps up with the approved arrival rate and physically deletes Case Manager copies within 24 hours of expiry or opt-out. Check encrypted Blob, case metadata, transaction indexes and due tasks after deletion; source stores remain untouched.
- Test a routine deployment after capture has been enabled. It must preserve the approved desired state. Test `CASE_MANAGER_EMERGENCY_OFF=true` as rollback while `CASE_MANAGER_MAINTENANCE_ENABLED=true` keeps deletion and reconciliation running. Confirm the prior immutable digest can be restored and no case storage is deleted during rollback.

## Customer support

Ask for the transaction ID from the API response header or usage log and search for it in the signed-in workspace portal. A missing case may mean capture was off at admission, the selected TTL expired, an opt-out retired it, or capture was marked incomplete. Check sanitized intent, capture, reconciliation and purge metrics without copying customer response bodies, documents, credentials or signed URLs into tickets or logs. An HTTP 200 is transport success; use the case outcome and coverage fields for the screening result.
