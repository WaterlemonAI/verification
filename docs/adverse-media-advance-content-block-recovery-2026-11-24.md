# Advance provider content-block recovery — 24 November 2026

## Evidence and cause

The retained seven-subject V6 run shows three Gemini `generateContent` responses for Mickey Mouse with HTTP 200, `promptFeedback.blockReason: PROHIBITED_CONTENT`, and no candidates. Those requests covered 11 selected articles in batches of four, four, and three. The articles concerned alleged child sexual offences involving people who had performed as the character; they were selected by title/URL signals even though an article about a former performer is not evidence that the fictional character participated in an offence. The provider did not identify the exact triggering passage. Other batches on the same topic were accepted, so the topic alone does not identify a deterministic trigger.

The V6 catch path replaced every item in each blocked batch with an unresolved tag. The report then showed an unassessed relationship without saying the provider blocked the batch. The local provider-exchange trace in `output/adverse-advance-qa-2026-11-24/seven-revised-v6/` retains the actual block responses.

## V7 source change

- Detect prompt and candidate content-block reasons before attempting to parse model JSON.
- Split only a blocked batch, down to individual articles. Persist child claims and results in the screening checkpoint so completed sub-batches are reused. A four-article batch requires at most seven classification calls if every subgroup blocks; the existing per-screening provider cost guard remains authoritative.
- Keep an individually blocked article unresolved with `provider_content_blocked` in its evidence decision and a classification block count in the assessment. Continue reviewing the other articles. A blocked article cannot establish Safe or Unsafe by itself. A separately verified Direct adverse article can still establish Unsafe.
- Render a pending or blocked *review status* in the PDF when a relationship has not been verified. The subject relationship field continues to carry only Direct, Indirect, No Association, or null when no defensible classification exists.
- Bump the review schema to V7 so an accepted screening does not reuse V6 classification checkpoints.

## Isolated V7 validation

The private Mickey Mouse candidate run used source `2261339231b62d9d3bbb603aec9328726f133845` at image digest `sha256:3db8c6b7566e7a6665507f7b4a76b51e62a59e848419b50b609547c4cef45025`. Before the run, the V1 archive and V2 summary both ended at 24 November 2026 01:30 UTC. The retained trace is in `output/adverse-advance-qa-2026-11-24/mickey-v7-content-block/` (local, private, untracked), screening `67bd9683-2d0a-470e-9bff-3263d7dc0773`.

The run selected 23 candidates. Gemini made 12 calls including the search planner and 11 classification requests. Three four/two-article classification requests returned `PROHIBITED_CONTENT`; child calls recovered all their articles. Gemini returned 20 distinct article classifications: 18 Indirect and two No Association, all proposed as not adverse. Those are model proposals, not verified final findings. The remaining three candidates were not classified: the existing $0.25 per-screening cost guard stopped the run after $0.249248 was reserved. The worker emitted `budget_blocked` with an Inconclusive, decision-ineligible profile and no JSON/PDF report or callback. The provider responses, cost, budget-stop record, request, and worker log were retained. This run therefore confirms blocked-batch isolation but does not demonstrate a completed review under the current cost ceiling.

The private candidate was restored to its previous image digest `sha256:729f4cfc5c49668b459bed37379a4dcd6d6d8959f02a5eef91471bd6f02b5cab` and minimum replica count zero. Customer Advance access remained off.

## Remaining gate

This source change recovers classifications for unblocked articles. It cannot force Gemini to classify a single article whose content is prohibited by the provider. Such an article remains visibly Inconclusive and requires an approved human or separately governed review path. Do not infer that severe content is non-adverse, disable provider protections, or make an Unsafe finding from a blocked response alone. The identity and exact-quote gates identified in the seven-subject evaluation remain separate work.

The V7 synthetic tests cover partial batch recovery, singleton prompt/output blocks, checkpoint replay, preservation of a verified Direct Unsafe finding, and provider-budget propagation. A bounded cost policy or review handoff is needed for high-volume cases: batch isolation can add calls and reach the current ceiling before every selected candidate is reviewed. Do not silently drop the pending candidates or declare the profile Safe. No customer rollout was part of this validation.
