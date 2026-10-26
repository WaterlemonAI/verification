# Adverse-media deep-research retry incident — 26 October 2026

## Evidence and attribution

- The supplied Brave CSV records 615 successful Search calls on 25 October and 2,391 on 26 October UTC: 3,006 total. At USD 0.005 per call, that is USD 15.03. The owner reports fewer than 20 app requests and has separately matched the charged key hash to AI7's adverse-media Key Vault credential.
- Deployed source `8383894` creates a fresh screening cost guard inside every deep-research queue receipt. The worker reruns screening and report creation before each callback attempt. Any exception, including callback failure, releases the same message for another receipt. This is a confirmed code defect and a credible amplification path.
- The supplied storage-account UpdateMessage counts combine `adverse-media-deep-research` and `forms-submissions`. They cannot prove how many of the 3,006 Brave calls came from either queue or establish an individual job's failure stage.
- The selected Azure subscription was **Azure subscription 1**. The dedicated account `stai7uaejobsuaen001` in `rg-ai7uae-web-uaen-001`, UAE North, contains both queue names. The signed-in operator can list queue names but `az storage message peek --auth-mode login` was denied for lack of Queue Data Reader. No account-key fallback was used. Therefore live dequeue counts, message versions, and failure stages remain unverified. Current app console logs showed startup only.

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

1. Grant the signed-in investigator **Storage Queue Data Reader** on only the dedicated jobs account (the owner is arranging this). Read the adverse queue and Forms queue separately using Entra login; record only sanitized message IDs, insertion times, dequeue counts, version, attempt counters, and stage. Do not print message bodies, callback secrets or subjects.
2. Compare those message states with sanitized API/queue diagnostics and Brave usage time buckets. Label any attribution beyond observed evidence as an inference. Identify whether screening, report creation, callback delivery or queue acknowledgement failed per adverse job.
3. Review the isolated PR and deploy the candidate with `enableDeepResearchWorker=false`. Confirm the dead-letter queue exists and the active revision remains paused. Do not roll back to the old worker revision while its queue URL is present.
4. Decide the disposition of every legacy queued job before enabling the worker. The candidate quarantines version-1 jobs; it does not silently replay them. Preserve the queue/dead-letter evidence according to the project's retention policy.
5. Only then enable the worker for controlled synthetic jobs. Verify one screening, callback-failure retries, no extra Brave calls, lifetime budget enforcement, dead-lettering, PDF access and the new sanitized logs. Monitor actual Brave usage and queue activity before broad resumption.

This file records a code defect and containment. It does **not** claim that queue payload inspection, exact charge attribution, candidate deployment or live resumption has passed.
