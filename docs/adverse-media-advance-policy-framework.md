# Adverse Media Advance policy framework

This is the implementation guide for the gated asynchronous Adverse Media Advance API. The separate `/service/adverse_media_advance` route, signed callback event, workspace entitlement and rate gate, policy classifier, archive evidence mapping, and Advance PDF variant are wired in the isolated branch. `ADVERSE_MEDIA_ADVANCE_ENABLED` defaults off. Existing Adverse Media and Search+ routes retain their contracts.

The internal candidate must pass controlled full-journey validation before the flag is enabled for customer traffic. No production deployment or workspace entitlement is implied by this code.

## API journey

1. An entitled workspace sends `POST /service/adverse_media_advance` with a 16–128 character `Idempotency-Key`, a public HTTPS `callback_url`, subject identity fields, and either `policy_selection: "all"` or selected `policy_ids`. The request cannot choose Search+, disable archive review, or supply a free-form policy instruction.
2. The server validates the request and callback target, claims the workspace-scoped idempotency key, checks the Advance rate, and queues one version-pinned job. The 202 receipt contains the screening ID and a callback signing secret shown once. An exact replay returns the same screening ID without a new provider run or charge; a changed payload returns 409.
3. The existing deep-research worker performs Search+, searches the stored Azure archive, and reviews archived articles within the shared provider cost ceiling. It checkpoints provider work, then Gemini tags each bounded article batch against the 64-event catalog once. Server-side quote, identity, coverage, and policy rules determine the three-state profile and policy outcome.
4. The worker stores the JSON result and Advance PDF, then posts `adverse_media.advance.completed` to the callback URL with `x-ai7-signature`. Callback retries reuse the saved report and do not repeat searches. `GET /service/adverse_media_advance/jobs/{screening_id}` provides the final result to the owning workspace when callback delivery cannot be confirmed. The PDF link is under `/service/adverse_media_advance/reports/{report_id}.pdf`.

The request and PDF contain no account-plan information. Additional registration, tax, address and birth-date identifiers used solely for matching stay out of Brave and Gemini prompts; they remain in the private job and retained request record.

### Internal release gates

- Verify a complete controlled end-to-end job with the real providers, stored PDF, Case Manager capture, and signed callback. Test model schema acceptance on English and Arabic articles and confirm the provider cost reservation ledger.
- Replay the ten earlier problematic subjects plus ten independent subjects and review false positives, namesakes, archive findings, p50/p90/p95, and per-provider spend. Do not enable the customer route while the policy assessment or archive evidence is unverified.
- Confirm the article-text provider account permits production use and set an explicit Advance workspace rate and entitlement. Enable the flag only through the reviewed production deployment path after those gates pass.

## Catalog and selection

- `lib/adverse-media-advance-policy-catalog.mjs` contains 64 stable policy IDs: eight each in financial crime (`FIN`), regulatory/governance (`REG`), employee/leadership (`EMP`), health/safety (`HSE`), cyber/privacy (`CYB`), environment (`ENV`), financial stability (`STB`), and human rights/security (`HUM`).
- `listAdvancePolicies()` is the source for a future API reference and policy editor. Changing a rule's meaning requires a new catalog version rather than silently reusing its ID.
- `policy_selection: "all"` selects all 64 IDs. Omitting both selection fields has the same default. Supplying `policy_ids` selects a narrower list; sending both forms is rejected. The UI should present "All policies · Gemini classification" as the default option.
- `compileAdvancePolicySet()` sorts IDs, rejects duplicates and unknown IDs, and produces a versioned SHA-256 snapshot recording `selection_mode`. The hash is an audit identifier, **not** an authorization signature.
- The public request should contain the All option or policy IDs, plus an approved policy-set ID where applicable. Rule actions and matrices must come from trusted, versioned workspace configuration. Free-form prompts and action overrides from the screening request must not reach the evaluator.

```json
{ "policy_selection": "all" }
```

All mode gives Gemini the full event catalog for each article. Gemini proposes whether the article is adverse to the screened subject, not adverse, or unclear; it also identifies the subject role and event types. The server verifies the quoted source text and independently supplied identity match before promoting an adverse proposal to a confirmed event. Gemini cannot override missing coverage or an unsupported quote. The catalog's approved action rules still determine the organisation policy outcome.

Each policy has a default action of `review` or `escalate`. A trusted workspace rule may use `acceptable`, `review`, or `escalate`, with exact role/severity or role/severity/legal-stage matrix cells:

```js
const selection = compileAdvancePolicySet(
  { policy_ids: ['EMP-01', 'FIN-06', 'HSE-03'],
    policy_set_id: 'supplier-screening', policy_set_version: '2.1.0' },
  { trustedRules: {
    'EMP-01': { matrix: { 'related_party:minor': 'acceptable' } },
    'FIN-06': { matrix: { 'direct_actor:moderate:allegation': 'review' } },
    'HSE-03': { default_action: 'escalate' }
  } }
);
```

The example's `trustedRules` must originate from approved server-side configuration. The strictest action across triggered selected policies determines the run's policy outcome.
Without a matrix override, a related-party event defaults to Review and a victim event defaults to Acceptable. A direct-actor event uses the catalog default. These role defaults prevent an employee's offence or a fraud against the company from being attributed automatically to the company.

## Upstream classification contract

Gemini should make **one structured, multi-label classification per unique article**, not a provider call per policy. `advanceEventTaggingSchema()` bounds each batch to 25 known story keys and the 64 catalog IDs; `validateAdvanceEventTags()` rejects omitted, duplicated and invented story tags. Its output includes `adverse_assessment`, subject role, proposed entity match, event IDs, severity, legal stage and a supporting quote. `buildAdvanceFindingsFromGemini()` combines this proposal with source text and an independent identity match. The evaluator accepts the resulting finding shaped like:

Google's [structured-output guidance](https://aistudio.google.com/docs/structured-output) says `uniqueItems` and `maxLength` are not enforced by constrained decoding and complex schemas can be rejected. The local validator enforces those limits. The production adapter must probe the chosen model and reduce the article batch size if this schema exceeds its serving limits.

```json
{
  "finding_id": "article-1",
  "story_key": "canonical-story-id",
  "event_type_ids": ["EMP-01", "FIN-06"],
  "severity": "moderate",
  "legal_stage": "allegation",
  "evidence_text": "A verbatim quote from the source text. Further article context.",
  "adjudication": {
    "status": "confirmed_event",
    "entity_match": "confirmed",
    "subject_role": "related_party",
    "confidence": 0.91,
    "supporting_quote": "A verbatim quote from the source text."
  }
}
```

The quote must occur in supplied text for confirmed and non-adverse adjudications. Story keys are restricted to opaque identifiers. Missing or unsupported quotes, uncertain identity, invalid story keys, unknown event IDs and malformed classifications are unresolved. The framework never executes instructions in article text. A matching quote alone does not prove the subject acted; the upstream adjudicator still needs tested party-attribution rules.

`confirmed_event` means a reported event is supported. A direct-actor event is adverse to the screened subject. A related-party event can trigger an employee policy without being misreported as direct company misconduct. `not_adverse` findings never trigger policies.

## Coverage and outcomes

The evaluator requires explicit `source_complete`, `article_review_complete`, `classification_complete` and `unresolved_count`. Missing coverage data fails closed. The current candidate can report `coverage.complete=true` while hundreds of archive articles remain unresolved; do not map that flag to article-review completion.

The response contains:

- `evidence_profile.status`: `safe`, `unsafe` or `inconclusive` under factual evidence rules.
- `policy_outcome.status`: `acceptable`, `review` or `escalate` under the policy snapshot.
- Separate decision eligibility, distinct direct-adverse and related-party counts, unresolved and unselected events, results for every selected policy, and a decision for every finding.

Unselected confirmed event types require Review. Incomplete coverage or classification cannot yield Acceptable. Ten distinct confirmed direct adverse stories can support early Unsafe/Escalate if the worker marks `sufficient_adverse`. The same early stop cannot support Acceptable because unreviewed articles could trigger a stricter policy.

## Implemented boundary and remaining work

- The route is async only, forces Search+ and stored-archive review, and accepts the All option or multiple catalog IDs. The idempotency claim, separate entitlement/rate, cost guard, signed callback, private JSON retention, Case Manager mapping, and Advance PDF are wired. The deployment parameter remains false by default.
- The submitted policy IDs and catalog hash are pinned in the job. Rule overrides and workspace policy-set selection are not yet exposed through a trusted admin configuration. The API uses the catalog defaults. Registration, licence, tax and domain numbers, LEI, and date of birth can confirm article identity when the article contains the same value. Address, nationality and association inputs are retained but not yet used as strong matches.
- A one-article live Gemini call accepted the All-catalog schema. This proves model compatibility for that bounded case, not classification quality or a multi-article batch. Search+ article bucketing and Advance policy tagging currently make separate Gemini passes, both under the same provider budget.
- The callback is the primary result-delivery mechanism. The owner-authenticated job status/result route is implemented; a public API reference page remains to be built before general release.
- The archive reviewer still has a bounded posting limit and can return Inconclusive for large subject histories. The full-journey QA must establish acceptable Safe/Unsafe/Inconclusive rates before customer enablement. A supported direct archive hit remains Unsafe and is shown in the PDF even when the ordinary media buckets omit it.
- The article-text provider account must allow production use. The earlier problematic subjects and an independent holdout must pass attribution, coverage, latency and spend gates before the Advance flag is enabled.
