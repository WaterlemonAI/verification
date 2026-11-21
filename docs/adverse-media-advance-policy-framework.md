# Adverse Media Advance policy framework

This is the reusable policy layer for the proposed asynchronous Adverse Media Advance API. It does **not** register an API route, call Gemini, change billing, generate a new PDF, or enable a live product. Existing Adverse Media and Search+ behavior is unchanged.

## Catalog and selection

- `lib/adverse-media-advance-policy-catalog.mjs` contains 64 stable policy IDs: eight each in financial crime (`FIN`), regulatory/governance (`REG`), employee/leadership (`EMP`), health/safety (`HSE`), cyber/privacy (`CYB`), environment (`ENV`), financial stability (`STB`), and human rights/security (`HUM`).
- `listAdvancePolicies()` is the source for a future API reference and policy editor. Changing a rule's meaning requires a new catalog version rather than silently reusing its ID.
- One run can select one through all 64 IDs. `compileAdvancePolicySet()` sorts IDs, rejects duplicates and unknown IDs, and produces a versioned SHA-256 snapshot. The hash is an audit identifier, **not** an authorization signature.
- The public request should contain policy IDs or an approved policy-set ID. Rule actions and matrices must come from trusted, versioned workspace configuration. Free-form prompts and action overrides from the screening request must not reach the evaluator.

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

Gemini should make **one structured, multi-label classification per unique article**, not a provider call per policy. `advanceEventTaggingSchema()` bounds each batch to 25 known story keys and the 64 catalog IDs; `validateAdvanceEventTags()` rejects omitted, duplicated and invented story tags. Its output supplies event IDs, severity and legal stage. Independent evidence adjudication supplies subject role, identity match, confidence and a verbatim quote. The evaluator accepts a finding shaped like:

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

## Integration boundaries

1. Add a separately entitled `POST /service/adverse_media_advance` that always enables Search+ and accepts subject identifiers, policy IDs, idempotency key and HTTPS callback URL. Return `202` and a screening ID. Do not expose a Search+ switch.
2. Resolve and pin the workspace-approved policy set before enqueueing. Persist its catalog version, policy-set version, selected IDs and hash with the job and final JSON. Rehydrate only from trusted configuration in the worker.
3. Add identity matching for business licence/registration, LEI, tax identifiers, domains, jurisdiction, address and aliases; and for individuals, names, birth details, nationality and associations. Do not send private identity numbers to Brave or GDELT. Use identifiers only when a source provides a comparable value; otherwise identity remains uncertain.
4. Add structured Gemini event tagging and map verified article evidence into `evaluateAdvancePolicies()`. Existing keyword categories must not be promoted to confirmed policy events without source and subject-role evidence.
5. Add Advance-specific JSON retention, signed callback, owner-authenticated status/report retrieval, entitlement and rate, Case Manager mapping, OpenAPI and portal documentation. Reuse the existing queue and provider cost guard.
6. Build a separate PDF view from the final JSON: identity match, source coverage, event timeline, category/severity distribution, actor relationship, policy matrix, material finding cards and unresolved work. Show both evidence profile and policy outcome. Use vector charts with text equivalents.

Focused tests cover catalog integrity, multi-policy precedence, role/severity exceptions, unsupported quotes, unselected event types, incomplete coverage, early stopping and syndicated-story deduplication. These are not live classification-quality evidence. The previously failing ten subjects and a manually labelled holdout must pass attribution and article-review gates before Advance is published.
