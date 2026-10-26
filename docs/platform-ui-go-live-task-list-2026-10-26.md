# KYCProbe platform: developer task list and go-live gate

**Prepared:** 26 October 2026 (Asia/Dubai)
**Source baseline:** `WaterlemonAI/verification` `main` at `8383894ad1458e71691c629b415a4bfc640de2e8`
**Live surfaces tested:** `kycprobe.com`, `app.kycprobe.com`, and the signed-in portal/admin at `api.ai7uae.com`
**Scope:** Implementation and verification handoff. This document does not authorize a production deployment, a customer credit adjustment, or use of real KYC/bank data in tests.

## Evidence and launch status

The live UI test on 26 October found three adverse-media HTTP 502 responses, a JavaScript error immediately after a customer created an API key, a Form tester that submitted blank required fields, misleading empty-login feedback, and stale bank-statement tester feedback. The follow-up test confirmed that a three-tier rate, module toggle, and prepaid/postpay mode saved and reloaded on a revoked-key smoke workspace; each was restored to its original state. A disposable customer key was created, rotated, displayed in the admin registry, and revoked. The original key remained active. Negative credit was rejected. **Positive wallet funding, charged calls against tiers, credit depletion, and customer entitlement enforcement were not live-tested.**

The working checkout is an older `codex/owned-news-foundation` branch. Implement against current `main`; verify the source SHA again before coding. Do not overwrite the unrelated untracked `build_publishers.py` in the working checkout.

### Release rule

Do not advertise the platform as ready for regulated customer decisions until every **P0** item below has a passing, retained test record. A route shown as `enabled` by `/service/health` is only a transport/configuration observation; it is not proof that a supplier or screening engine works.

## P0 — launch blockers

### P0-1. Restore adverse-media screening and prevent misleading outcomes

- [ ] Reproduce the live HTTP 502 with a synthetic individual name in broad and narrow regional modes. Correlate the response transaction IDs with sanitized Container App logs, Brave/GDELT/AI provider status, Key Vault credential access, and runtime timeouts. Keep provider secrets and query subjects out of logs and tickets.
- [ ] Identify whether the failure is source access, configuration, rate limit, dependency timeout, or error handling. Fix the root cause and add bounded retries/circuit behavior where appropriate. Preserve a truthful `partial`/inconclusive result when a required source fails; never turn an empty result into a completed safe decision.
- [ ] Run a synthetic positive-evidence case and a synthetic no-material-evidence case. Verify actual evidence URLs, source coverage, `summary.decision_eligible`, threshold behavior, and the PDF metadata/link. Test deep-research callback delivery separately.
- [ ] Add an alert on sustained 5xx and source failure, with a traceable transaction ID and a customer-safe error. Record a live post-deploy smoke result, not only route health.

**Accept:** The same live tester flow no longer returns 502; a known synthetic evidence case returns the expected evidence, and a forced source outage is explicitly ineligible. The account ledger retains the correct HTTP code and cost policy for each run.

### P0-2. Fix key-creation UI crash and verify the full key lifecycle

- [ ] In `api-site/account.js`, capture the form element before the asynchronous request. `event.currentTarget.reset()` runs after an `await` and produced `Cannot read properties of null (reading 'reset')` even though the key was created. Audit the analogous reset pattern in `admin-site/admin.js`.
- [ ] On creation success, show the secret once, update the masked list and admin customer record without a reload, clear the label, and leave the original key valid. On failure, show an error and re-enable the control without creating a duplicate key on retry.
- [ ] Test create, rotate, old-value rejection, new-value authentication, revoke, revoked-value rejection, owner binding, 20-active-key limit, CSRF, and concurrent actions. Never put full keys in browser logs, URLs, analytics, screenshots, or support evidence.
- [ ] Add an automated browser test for the customer create/rotate/revoke flow and a server test for key ownership and invalidation.

**Accept:** The UI has no JavaScript error; the created/rotated key appears immediately as masked data in customer and admin views; only the intended key changes; revoked material cannot authenticate.

### P0-3. Validate Forms before charging or queuing

- [ ] Validate required dynamic fields, types, option values, URL format, and at least one valid identifier in the browser. Put the error beside the relevant field and keep focus there. Do not send a request with blank required fields.
- [ ] Preserve server-side validation as the authority. Review `gateCustomerApi` and `submitForm` in `server.mjs`: billing admission currently occurs before `validateFormSubmission`. Define the commercial policy for malformed submissions and move or compensate admission so invalid requests do not consume credits/hit tiers unless that is an explicit, disclosed policy.
- [ ] Keep the live four-service Form definition in sync with docs: UAE Trade Licence, Entity Search, Adverse Media, Merchant Screening. IBAN and bank-statement uploads are not part of this live Form. Make required versus optional fields and callback requirements unambiguous.
- [ ] Verify a valid Form returns HTTP 202, one submission ID and signing secret, runs each selected service once, and posts a signed callback with exact nested results, coverage/eligibility reasons, and consolidated PDF. Verify partial HTTP-200 adverse-media/merchant results stay decision-ineligible.
- [ ] Test invalid payload, missing/invalid callback, disabled module, insufficient prepaid credit, queue failure, callback retries, and duplicate/idempotent submission. Confirm the ledger never double-charges queued work or retries.

**Accept:** A blank Form is stopped locally; invalid authenticated requests have the agreed zero/explicit charge and no queued job; valid and partial submissions preserve every service's business status and eligibility reason in JSON, callback, and PDF.

### P0-4. Prove billing, credit, tier, and entitlement behavior end to end

- [ ] Create an isolated **non-production** customer workspace with synthetic keys, provider stubs, and a reversible test balance. Do not use a real customer's rates, balance, or active key.
- [ ] Test the admin credit entry and durable credit audit row; positive amount, zero/negative, malformed decimals, six-place precision, duplicate submit, currency lock after funding, and authorization/CSRF. Decide whether a credit reversal/adjustment operation is required and make it auditable if implemented.
- [ ] Verify inclusive tier boundaries at hits 1, 10,000, 10,001, 20,000, and 20,001 using seeded counters rather than 20,001 paid provider calls. Check the per-workspace/per-module counters, `*` final tier, zero rate, USD/AED display, and decimal arithmetic.
- [ ] Test prepaid admission with just enough credit, one unit short, concurrent last-credit requests, 402 response, no supplier call, and no debit on denied access. Test postpay unlimited usage with a recorded charge.
- [ ] Test the owner-selected charge policy for HTTP 2xx, supplier 4xx/5xx, wrong method, invalid payload, disabled module, report downloads, health checks, key rotation, and a Form plus its selected APIs. Direct supplier HTTP 4xx/5xx and failed Form queue writes receive an immutable refund adjustment; accepted Forms retain orchestration cost and refund selected APIs without HTTP 2xx. Verify the net cost and adjustment in both ledgers.
- [ ] Test admin module toggle through to customer sidebar/catalog visibility **and** direct API 403 enforcement. A hidden menu item alone is not access control. Confirm a newly invited customer starts prepaid with no enabled modules; explicitly migrate/price legacy zero-rate postpay workspaces before commercial use.
- [ ] Match response `X-AI7-Transaction-ID`, UTC time, HTTP code, cost and tier breakdown in customer/admin ledgers. Ensure atomic balance+counter+log behavior under concurrent requests and a failed Azure Table write.

**Accept:** Retained automated integration results and a staging UI walkthrough reconcile starting balance + credit adjustments − debits = ending balance. Denied/invalid requests follow the approved billing policy; duplicate retries do not create extra charges.

### P0-5. Complete identity, email, and hostname journeys

- [ ] Test invitation email delivery to a controlled mailbox, single-use 48-hour setup link, password policy, first sign-in, expiry, resend, and invalid/used link. Invitation mail must never include an API key.
- [ ] Test password recovery for known/unknown addresses, 30-minute link expiry, session invalidation, and security notice. Empty sign-in fields should show required-field feedback before a network call; incorrect non-empty credentials should retain a generic error.
- [ ] Verify cookies, CSRF and navigation on the canonical `app.kycprobe.com` host. Decide whether legacy portal/admin pages at `api.ai7uae.com` redirect to the app host. Keep **all published API paths, report URLs and callback contracts** on `api.ai7uae.com` unchanged.
- [ ] Verify role boundaries: customer cannot open admin endpoints, another customer's keys/ledger/reports, or disabled modules; admin access cannot be obtained from a customer session. Rate-limit login, reset and invitation endpoints.
- [ ] Verify production email identity and delivery (`notify@kycprobe.com`, reply-to `notify@ai7lab.net`), SMTP secret via Key Vault, and the domain's SPF/DKIM/DMARC and mail records. Use controlled test recipients and redact tokens.

**Accept:** A new customer can set a password and use the app without receiving an API key by email; recovery works; sessions remain host-scoped and secure; old API client URLs continue to work.

## P1 — complete product verification before broad rollout

### P1-1. Run a provider-backed contract matrix for every API

- [ ] UAE Trade Licence: all four primary inputs, optional emirate/authority, binary document path, all supplier response fields, success and failure HTTP codes.
- [ ] IBAN: ISO-country selection, request-category mapping, locked document type 610, generated transaction ID, encryption/decryption, success/no-record/provider-error responses.
- [ ] Entity Search: mandatory country/gender/DOB, all documented response paths, JSON copy, logo/PDF option, and exact supplier payload preservation.
- [ ] Adverse Media: English and each enabled regional/language pack, Search+, thresholds, publisher list, actual evidence, partial coverage, PDF and deep-research callback. Distinguish name match from adverse evidence; do not make a definitive compliance decision from search coverage alone.
- [ ] Merchant Screening: HTTPS/SSRF validation, thresholds, critical finding override, desktop/mobile screenshots in an opt-in PDF, coverage status, and source-specific `not_configured` fields.
- [ ] Bank Statement Analysis: encrypted upload, malware scan fail-closed, S0 multi-page extraction, OCR/ledger reconciliation, private result retrieval, callback, PDFs/XLSX, and ineligible/partial cases. Use synthetic statements only; this remains decision support.
- [ ] For every API, check invalid auth, disabled module, bad method, malformed input, provider timeout, rate limit, transaction header, UTC log row, cost, documentation example, and copy controls. Compare JSON field-for-field to the documented contract without leaking supplier identity or private configuration.

**Accept:** A signed staging matrix records request fixture, expected/actual HTTP code, response schema, transaction ID, cost, and evidence/report link for each case. No test requires real customer PII.

### P1-2. Verify reports, callbacks, and durable data

- [ ] Check public capability links for Adverse Media, Merchant and Forms PDFs work without a key and cannot be listed or guessed; check Bank Statement artifacts remain authenticated/private. Confirm logo fetch restrictions, PDF rendering, full results, processing location/time, transaction ID, hashes, and source provenance.
- [ ] Use a controlled public webhook to verify callback POST body bytes, signature, delivery ID, retries/backoff, duplicate handling, and final `completed`/`partial`/`failed` states. A 0-byte callback is a failure. Protect against SSRF, redirects to private networks, and secret leakage.
- [ ] Verify report/queue persistence across API restarts, worker restarts and retries; check retention, soft-delete/restore and access audit evidence. Confirm sensitive BSA files do not land in public report storage.

**Accept:** Report links and callback receipts can be correlated to the originating transaction without exposing keys or customer documents in logs.

### P1-3. Finish UI quality and accessibility

- [ ] Clear stale validation messages when fields are corrected, including the Bank Statement Analysis key message after native file validation.
- [ ] Provide explicit loading, success, partial and failure states; prevent duplicate submissions; retain a visible response JSON/copy action for every tester. Do not label a partial/ineligible screening “safe.”
- [ ] Test desktop, tablet and mobile layouts; sidebar/menu, long response JSON, tables, forms, PDFs, contrast, keyboard focus, labels, error announcements and screen-reader navigation.
- [ ] Check homepage and Terms claims against shipped features. “Monitoring active,” regional publisher coverage and auditable reports must be backed by an available feature or clearly scoped wording.

**Accept:** No console errors in the core journeys; all required actions work with keyboard and small viewports; marketing, docs and live functionality agree.

## Go-live execution checklist

1. [ ] **Freeze the release candidate.** Implement on current `main`, review the PR, document migrations/configuration, and record the exact source SHA. Do not deploy from the older handoff checkout or a mutable image tag.
2. [ ] **Run automated gates.** `npm ci`, `npm test`, relevant Python/worker tests, Bicep build/validation, dependency/security checks, browser journey tests, and a staging contract suite. Keep sanitized CI artifacts.
3. [ ] **Preview infrastructure.** Run the repository `what-if` for the dedicated AI7 UAE resource group. Review identity, RBAC, network, certificate, storage, tier and cost deltas. Do not alter assets belonging to other projects.
4. [ ] **Verify production configuration without printing secrets.** Confirm managed identities, Key Vault references, SMTP, supplier credentials, Brave/Gemini/GDELT configuration, Document Intelligence S0, ClamAV sidecar, workers/queues/tables, DNS/TLS for `kycprobe.com` and `app.kycprobe.com`, and unchanged `api.ai7uae.com` contracts.
5. [ ] **Approve commercial policy.** The owner selected refunds for failed Form queue writes and supplier HTTP 4xx/5xx. Sign off module availability, price tiers, currencies, remaining partial-result and invalid-request rules, Form acceptance charges, report retention, and customer-facing terms/invoices. Record who approved each policy.
6. [ ] **Deploy through the protected workflow.** Use the reviewed `main` SHA, GitHub OIDC, digest-pinned images and existing protected environment. Retain run/attempt, digest, Azure revision and sanitized deployment outputs.
7. [ ] **Run live synthetic smoke tests after cutover.** Sign-in/recovery, one permitted and one denied API, adverse-media positive/no-result/error, merchant, trade licence, IBAN, entity search, BSA scan, Form callback/PDF, credit/tier/ledger reconciliation, and key lifecycle. Never use real customer records for smoke testing.
8. [ ] **Enable monitoring and on-call response.** Alert on API 5xx, adverse-media source degradation, callback backlog, worker failures, billing write failures, credit reconciliation drift, malware scanner unavailable, queue age, certificate/SMTP failures, and cost ceilings. Route each alert to an owner with a runbook.
9. [ ] **Prove rollback.** Identify a compatible prior digest/configuration, verify database changes are additive, rehearse rollback and report retrieval, and preserve the immutable billing ledger. Stop new billable traffic if ledger integrity or security controls fail.
10. [ ] **Release decision.** Product, engineering, security/privacy, finance and operations sign off the evidence matrix. Record unresolved P1 items, customer impact, temporary restrictions and an owner/date. Do not treat a green `/healthz` or enabled-route list as launch approval.

## Required handoff evidence

For each task, attach a ticket/PR, owner, exact test environment, fixture ID, result, timestamp, and link to sanitized logs/screenshots. The release packet must include the reviewed source SHA, CI run, image digests, infrastructure preview, live revision, API contract matrix, billing reconciliation, callback receipts, report checks, security review, cost estimate, rollback target and final approval. Record separately whether an item is **implemented**, **locally tested**, **staging verified**, or **live verified**.
