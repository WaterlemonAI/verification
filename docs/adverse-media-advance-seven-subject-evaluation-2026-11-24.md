# Advance seven-subject isolated evaluation — 24 November 2026

## Scope and retained evidence

The original seven runs used source `92215b3db9d1a46e28481c025bde97d5e4349b15`, ACR build `dg6q`, and private candidate image digest `sha256:59f2cde6087f361cf5f0a62c2c02e312c416343a3a11ab30f103992c25ae04c9`. Each request used an individual subject, English, global scope, all policies, 15 report results, and no DOB or associated-organisation identifiers. Customer Advance access was not changed. The archive posting ceiling was 10,000; the provider ceiling remained $0.25 per screening.

The local, private evidence directory is `output/adverse-advance-qa-2026-11-24/seven-revised-v6/`. Its `run-manifest.json` binds each request to a screening ID, source/image, V2 preflight, worker stages, provider calls, cost, output hashes, and replay. Each completed run retains its request, result JSON, PDF, cost, redacted provider exchanges, archive evidence, and Advance evidence. All seven original worker logs are retained. The two original budget stops have no final report. A separate replay on source `4deaa33dabc469e5ac79748cc2bbd151125284f3` (image `sha256:884cba1061de0c0985ef0f709a97a66895a614e2d300173b34d45d6081d41e55`) retains request, cost, redacted provider exchanges, and budget-stop records for both. The replay changed only the QA artifact-writing path.

V1 and V2 archive coverage both ended at 23 November 2026 01:30 UTC at preflight. V2 point-summary mentions for these exact individual names were 0, 2, 7,508, 0, 0, 78, and 44 in the order below. This is stored-archive coverage, not a count of adverse articles.

## Results

| Subject | Original terminal result | Archive | Advance decision | Provider reserve |
| --- | --- | --- | --- | ---: |
| Mickey Mouse | Delivered; callback verified | Completed, 0 postings | Inconclusive; 23 unresolved candidates | $0.182624 |
| Chota Bheem | Delivered; callback verified | Completed, 2 postings | Safe; 0 confirmed or unresolved candidates | $0.055482 |
| Jesus Christ | Delivered; callback verified | **Inconclusive:** 7,508 expected, 7,507 evidence items | Inconclusive; 22 unresolved candidates | $0.235080 |
| Gautam Buddha | Delivered; callback verified | Completed, 0 postings | Inconclusive; 5 unresolved candidates | $0.093848 |
| Nirav Modi | **Budget blocked; no report** | 0 V2 mentions | 71 candidates pending in replay | $0.249066 |
| Vijay Mallya | Delivered; callback verified | Completed, 78 postings | **Inconclusive; 19 proposed Direct adverse relationships, 0 confirmed** | $0.169334 |
| Lalit Modi | **Budget blocked; no report** | 44 V2 mentions | 35 candidates pending in replay | $0.245754 |

The original seven runs reserved $1.231188. The two trace-retention replays reserved another $0.497447, for $1.728635 total reserved provider cost. The replay results were budget blocked again, at $0.248260 for Nirav Modi and $0.249187 for Lalit Modi. These are reserved costs reported by the candidate, not a statement of final provider invoices.

All five completed PDFs match the SHA-256 recorded in their JSON. Their JSON has no `official_records` field, and extracted PDF text has no “Official records” label. The signed callback check passed for all five completed runs. No PDF or signed callback exists for either budget stop.

## Classification root cause

1. **The individual identity gate cannot confirm these name-only requests.** `strongIdentityMatch` in `lib/adverse-media-advance-classifier.mjs` confirms an individual only when the article matches a supplied DOB or associated organisation. None was supplied. Gemini's own `entity_match: confirmed` is then reduced to `possible` by `buildAdvanceFindingsFromGemini` unless the independent identity check confirms it. This prevents the one-confirmed-Direct-implies-Unsafe rule from firing for Vijay Mallya, even though Gemini proposed Direct adverse involvement in 19 selected findings. This is a guard against namesake errors, but it leaves the requested name-only stress case unresolved.
2. **Evidence quotes fail exact source verification.** `quoteSupported` in `lib/adverse-media-advance-policy.mjs` requires the model's supporting quote to be a contiguous substring of the verified article text after Unicode, case, and whitespace normalisation. Gemini frequently returned a paraphrase or composite sentence. In Vijay Mallya's final decisions, 15 findings have `direct_evidence_unverified` and 4 have `article_evidence_unverified`; all 19 are unresolved. The evidence gate should not be removed. The review needs an extractive quote and a bounded retry/recovery path tied to the actual source span.
3. **The same evidence rule turns low-risk mentions into inconclusive outcomes.** Mickey Mouse has 23 unresolved selected candidates; Gautam Buddha has 5. In the selected decisions, proposed non-adverse or unclear mentions fail quote or identity verification. The system does not safely treat weak name-only evidence as a confirmed exclusion, so these are not reliable Safe decisions. Chota Bheem is Safe because the completed checks selected no adverse candidates and left none unresolved.
4. **Candidate volume consumes the fixed cost budget before adjudication.** The Nirav replay normalised 176 unique URLs and selected 107; 71 remained at the guard. The Lalit replay normalised 191 unique URLs and selected 71; 35 remained. The early-stop rule cannot help until a Direct adverse story passes the identity and evidence gates. The two budget stops therefore produced no report, status, or callback.
5. **One Jesus Christ posting is absent from the archive evidence ledger.** The V2 summary expected 7,508 postings and the archive scanner reports scanning 7,508, but only 7,507 evidence items were retained. The archive review correctly marks `archive_posting_count_mismatch` and the profile remains Inconclusive. The QA runner nevertheless prints `status: verified`, which verifies report/PDF/callback transport but is too broad a label for complete archive coverage. Row-level V2-versus-ledger reconciliation is needed to locate the missing posting; duplicate posting IDs or a ledger write loss are hypotheses, not established causes.
6. **The three-valued relationship contract is incomplete for unresolved items.** Gemini's reviewed-event schema only permits Direct, Indirect, or No Association, but final selected decisions can still contain a null relationship when classification fails or an item is unassessed. The reported nulls were 8 for Mickey Mouse, 6 for Jesus Christ, and 4 for Gautam Buddha. The output needs either a completed three-way classification for every potentially adverse candidate or an explicit processing exception outside the relationship field.

The current run is an evaluation of the implemented flow. It does **not** establish that a person is safe or unsafe from name-only evidence, and it does not justify converting an unverified model claim into a confirmed adverse finding.

## Follow-up gates

- Make the model return an exact source span and retry or recover only from the verified article body. Retain the original and corrected model output.
- Define an independently verifiable individual identity route for name-only reports, with explicit ambiguity handling and tests for namesakes. Re-run the three Modi stress cases after this route and quote recovery are in place.
- Reconcile the 7,508 Jesus Christ V2 postings against persisted archive ledger IDs, fix the missing record, and make the QA result distinguish transport verification from archive completion.
- Ensure every selected potentially adverse article receives one of the three relationship values or a separately visible processing failure. Preserve the $0.25 guard and make partial review visible in the report flow.

