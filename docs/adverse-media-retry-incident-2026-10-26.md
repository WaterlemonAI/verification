# Adverse-media deep-research retry incident — 26 October 2026

## Evidence and attribution

- The supplied Brave CSV records 615 successful Search calls on 25 October and 2,391 on 26 October UTC: 3,006 total. At USD 0.005 per call, that is USD 15.03. The owner reports fewer than 20 app requests and has separately matched the charged key hash to AI7's adverse-media Key Vault credential.
- Deployed source `8383894` creates a fresh screening cost guard inside every deep-research queue receipt. The worker reruns screening and report creation before each callback attempt. Any exception, including callback failure, releases the same message for another receipt. This is a confirmed code defect and a credible amplification path.
- The supplied storage-account UpdateMessage counts combine `adverse-media-deep-research` and `forms-submissions`. They cannot prove how many of the 3,006 Brave calls came from either queue.
- The selected Azure subscription was **Azure subscription 1**. The dedicated account `stai7uaejobsuaen001` in `rg-ai7uae-web-uaen-001`, UAE North, contains both queues. At the owner's direction on 26 October, the signed-in operator received **Storage Queue Data Reader** on the adverse-media queue only. A read-only Entra-authenticated peek at approximately 19:51 UTC found three version-1 adverse jobs. Their dequeue counts were **216**, **226**, and **232**; they were inserted at 23:41:26, 21:57:50, and 20:44:34 UTC on 25 October, respectively. All have callbacks configured. Peeking did not receive, update, or delete messages. No account-key fallback was used.
- The same operator received **Storage Table Data Reader** on the `AdverseMediaReports` table only. Metadata for screening `9c2c6950-f181-4ab8-9cb3-40e38ea6d395` (queue message `6c6aaa46-15fe-4151-9a0e-031cfc27e081`, 216 dequeues) contains **91 distinct report IDs** across 179 owner/public index rows, including 88 public index rows, generated from 25 October 23:42 UTC through 26 October 08:10 UTC. In deployed version `8383894`, each receipt runs screening before creating a new report; these rows establish at least 91 screening/report attempts for that single job. The source writes the blob and owner/public index rows during finalization, before callback delivery. At least 88 retries passed full report persistence and then failed in callback delivery or queue acknowledgement. The exact exception is unlogged. The other two queued screening IDs have no matching report-index rows, so their failure stages remain unproven; they may have failed during screening or report finalization. This evidence does not allocate all Brave charges among jobs.

## Immediate containment

At the owner's direction, `ADVERSE_MEDIA_QUEUE_URL` was removed only from Container App `ca-ai7uae-api`. Revision `ca-ai7uae-api--0000064` became healthy at **2026-10-26 19:31:13 UTC**, with the same image digest as prior revision `0000063`. A fresh readback showed the deep-research queue URL absent, `FORMS_QUEUE_URL` retained, and only revision `0000064` active. `https://api.ai7uae.com/healthz` returned `ok`. No queue messages were received, deleted, or modified during containment. New deep-research callback submissions return 503 while the queue is detached; other routes retain their configuration. A deployment of older Bicep/source could restore the queue URL, so the pause must be verified after any deployment.

## Candidate fix

Branch `codex/adverse-retry-containment` is based directly on deployed main commit `8383894`; it is separate from the broader P0 draft. The candidate:

1. Persists the presented screening after search, then persists the finalized PDF response. Callback retries load the saved result and never rerun search or report creation.
2. Reserves paid Brave/Gemini cost in an Azure Table row keyed by owner and screening ID **before** each provider call, with ETag concurrency control and a lifetime USD 0.14 provider cap per job. Failed provider calls consume the reservation.
3. Bounds screening, finalization, callback and total dequeue attempts; exhausted jobs go to a dedicated private dead-letter queue. Legacy version-1 jobs are quarantined without provider calls if the worker is eventually re-enabled.
4. Logs screening ID, queue message ID, dequeue count, failure stage/code and provider-attempt counts, excluding subject, callback URL, payload and credentials.
5. Adds an explicit deployment flag defaulting to paused. The worker and new deep-research submissions remain disabled until old messages are inspected and an operator deliberately enables it.

The synthetic callback-failure test forces two delivery failures and then success: one screening, two Brave attempts total, **zero additional Brave attempts** during delivery retries. Separate tests cover the lifetime cap across restarted guards and concurrent Azure Table reservations.

## Gate before resuming

1. Preserve the read-only queue and report metadata above. The queue reader role is scoped to the adverse queue, and the table reader role is scoped to the report index. No Forms data access was granted. Do not print message bodies, callback secrets, subjects, or reports.
2. Compare the observed message and report states with any available sanitized API/queue diagnostics and Brave usage time buckets. Label any attribution beyond observed evidence as an inference. The deployed worker did not log per-job failure stage or provider-call counts, so the exact exception for each old job may remain unknowable.
3. Review the isolated PR and deploy the candidate with `enableDeepResearchWorker=false`. Confirm the dead-letter queue exists and the active revision remains paused. Do not roll back to the old worker revision while its queue URL is present.
4. Decide the disposition of every legacy queued job before enabling the worker. The candidate quarantines version-1 jobs; it does not silently replay them. Preserve the queue/dead-letter evidence according to the project's retention policy.
5. Only then enable the worker for controlled synthetic jobs. Verify one screening, callback-failure retries, no extra Brave calls, lifetime budget enforcement, dead-lettering, PDF access and the new sanitized logs. Monitor actual Brave usage and queue activity before broad resumption.

This file records a code defect, containment, read-only inspection, and scoped reader grants. It does **not** claim exact charge attribution, candidate deployment or live resumption has passed.
