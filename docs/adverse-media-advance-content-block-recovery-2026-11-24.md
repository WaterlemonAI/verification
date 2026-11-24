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

## Remaining gate

This source change recovers classifications for unblocked articles. It cannot force Gemini to classify a single article whose content is prohibited by the provider. Such an article remains visibly Inconclusive and requires an approved human or separately governed review path. Do not infer that severe content is non-adverse, disable provider protections, or make an Unsafe finding from a blocked response alone. The identity and exact-quote gates identified in the seven-subject evaluation remain separate work.

The V7 synthetic tests cover partial batch recovery, singleton prompt/output blocks, checkpoint replay, preservation of a verified Direct Unsafe finding, and provider-budget propagation. No new paid provider run or customer rollout is part of this source change.
