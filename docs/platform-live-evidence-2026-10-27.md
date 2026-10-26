# KYCProbe live release evidence — 27 October 2026 (Dubai)

This record distinguishes verified behavior from remaining launch gates. All live requests below used public or synthetic subjects and disposable AI7LAB UAE keys that were revoked after use. No other project's Azure resources were changed.

## Source and deployment

- PR [#77](https://github.com/WaterlemonAI/verification/pull/77), merge `a9d4f05232fb73fa9151567e63241c98333d7f75`, contains adverse-media retry containment, bounded per-service request lanes, durable Form submission idempotency, Form component checkpoints, cross-replica API-key creation locking, and API alerts. The integrated Node suite passed 146/146; its protected PR test passed.
- The current live API uses digest `sha256:d3b8ddc37b52fcbe4767e2412aff82d3a21dc1acff9aaa406db761ba464fe0eb` at ready revision `ca-ai7uae-api--0000070`, with `ADVERSE_MEDIA_WORKER_ENABLED=true` and `/healthz` returning HTTP 200. The earlier live retry test ran on the same PR #77 application code at revision `ca-ai7uae-api--0000069`.
- PR [#78](https://github.com/WaterlemonAI/verification/pull/78), merge `1db84341dc49f8aa60a32be0f360bcfc409a4a4f`, changes subsequent normal push deployments to keep the verified worker enabled. Manual deployments retain a pause option. Its protected [deployment run 40413216236](https://github.com/WaterlemonAI/verification/actions/runs/40413216236) completed successfully; the final revision, worker setting, alert and health were read back from Azure.
- The dedicated API 5xx metric alert and adverse-media all-source log alert are enabled and route to `notify@kycprobe.com`. The log alert was deployed separately after the GitHub deploy identity lacked Log Analytics query access; that identity has since been granted Log Analytics Reader on this project's workspace. Alert receipt by an on-call owner remains unproved.

## Adverse-media live checks

- At 21:36 UTC on 26 October, a standard Signzy business check returned HTTP 200, `completed`, `summary.decision_eligible: true`, 20 results, the specific MediaNama data-leak article previously missed, and a public PDF returned HTTP 200.
- Deep-research screening `bdd22b84-3a81-4c4b-a9bb-40d89a4a5f1e` was accepted with HTTP 202. Its first signed webhook POST contained 20,552 bytes and received an intentional HTTP 503. After the webhook was switched to HTTP 200, the final callback arrived with the same screening ID, a verified HMAC signature, `completed`, 20 results, the MediaNama article, and a public PDF returned HTTP 200.
- Azure logs for that job show one screening and one finalization. Provider attempts were Brave 4 and Gemini 2 immediately before callback failure and remained **Brave 4 and Gemini 2** after successful delivery on dequeue 2. Gemini ran after search evidence was obtained. The callback retry made **zero** additional provider calls.
- Three pre-fix version-1 adverse-media jobs, previously at dequeue counts 216, 226 and 232, were quarantined to the dedicated dead-letter queue as `legacy_job_requires_review`. Their post-restart provider counts were Brave 0 and Gemini 0. Historical failure stages before the fix remain unproven.
- The live Gemini credential returned HTTP 200 after quota restoration. The deep-research result confirms actual classification and PDF narrative calls completed.

## Forms live checks

- The live `uae-vendor-due-diligence` Form selects UAE Trade Licence, Entity Search, Adverse Media, and Merchant Screening. Its Entity Search template was corrected in the dedicated Key Vault from a `fields_weightage` object to the supplier-required list. The configured check set was narrowed to `pep`, `sanction`, and `watchlist`; `russiabridge` is not enabled on this supplier key, and `apc` requires an additional duration input. The live Form is version 6.
- Four synthetic Form submissions each returned HTTP 202; replaying the same `Idempotency-Key` returned the same submission ID, hid the one-time callback signing secret, and created no second usage ledger row. Each generated one callback with report metadata; the first Form PDF was fetched publicly with HTTP 200. The AI7LAB UAE test workspace has zero rates, so this proves deduplication and ledger settlement, **not** paid-credit arithmetic.
- In the final version-6 run, all four selected checks returned HTTP 200. The Form's transport status was `completed`, while `summary.decision_eligible` remained `false` because Merchant Screening reported incomplete coverage for synthetic `example.org`. The callback named the ineligible service and reason. This confirms transport completion does not override business eligibility.

## Still open before regulated customer release

1. Include the retained `ai7uae-api-deployment-evidence-40413216236-1` artifact from the successful protected run in the release packet. The prior run 40402838286 was cancelled after the unchanged bank-statement image built but its ACR layer push stalled; the successful protected run supersedes it. Repeated full image builds remain an operational efficiency issue.
2. Verify alert delivery to an owned operational mailbox and identify the on-call owner. Add queue age, billing-integrity, callback backlog and malware scanner alerts before broad rollout.
3. Run paid-rate prepaid/postpay ledger reconciliation and tier-boundary tests in a controlled workspace. Zero-rate live smoke cannot prove charging or refunds.
4. Finish invitation/recovery delivery to a distinct controlled recipient, DKIM/authentication checks, canonical app-host session and role-boundary UI tests.
5. Complete the provider-backed contract and responsive/accessibility matrix in [the platform task list](platform-ui-go-live-task-list-2026-10-26.md), especially the Entity Search, IBAN, UAE Trade Licence, Merchant Screening and Bank Statement Analysis success/error cases. Use synthetic data.
6. Obtain product, security/privacy, finance and operations sign-off on evidence, partial-result policy, and report retention before calling the platform ready for automated regulated decisions.
