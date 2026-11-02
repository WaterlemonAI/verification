import assert from 'node:assert/strict';
import test from 'node:test';
import { guardGptAdverseClassifications } from '../lib/ai7uae-gpt-adverse-guard.mjs';

test('related-party and namesake legal actions do not become screened-subject stages', () => {
  const result = guardGptAdverseClassifications([
    { result_id: 'director', media_bucket: 'general_news_mentions', subject_role: 'related_party', legal_stage: 'charged' },
    { result_id: 'namesake', media_bucket: 'no_impact_media', subject_role: 'namesake', legal_stage: 'convicted' },
    { result_id: 'company', media_bucket: 'adverse_media', subject_role: 'direct_actor', legal_stage: 'regulatory_action' }
  ]);
  assert.deepEqual(result.classifications.map((item) => item.legal_stage), [
    'media_mention', 'media_mention', 'regulatory_action'
  ]);
  assert.deepEqual(result.review, [
    { result_id: 'director', reason: 'non_subject_legal_stage' },
    { result_id: 'namesake', reason: 'non_subject_legal_stage' }
  ]);
});

test('adverse bucket with non-direct role requires review', () => {
  const result = guardGptAdverseClassifications([
    { result_id: 'breach', media_bucket: 'adverse_media', subject_role: 'victim', legal_stage: 'media_mention' }
  ]);
  assert.deepEqual(result.review, [{ result_id: 'breach', reason: 'adverse_role_conflict' }]);
});

test('direct actor in ordinary news requires review before any decision', () => {
  const result = guardGptAdverseClassifications([
    { result_id: 'workforce', media_bucket: 'general_news_mentions', subject_role: 'direct_actor', legal_stage: 'media_mention' }
  ]);
  assert.deepEqual(result.review, [{ result_id: 'workforce', reason: 'non_adverse_direct_role' }]);
});
