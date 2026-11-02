// Candidate normalizer for a future GPT adapter. It is not wired into Gemini routing.
export function guardGptAdverseClassifications(classifications) {
  if (!Array.isArray(classifications)) throw new TypeError('invalid_gpt_classifications');
  const review = [];
  const guarded = classifications.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.result_id !== 'string') {
      throw new TypeError('invalid_gpt_classification');
    }
    const directAdverse = item.media_bucket === 'adverse_media' && item.subject_role === 'direct_actor';
    let legalStage = item.legal_stage;
    if (!directAdverse && legalStage !== 'media_mention') {
      legalStage = 'media_mention';
      review.push({ result_id: item.result_id, reason: 'non_subject_legal_stage' });
    }
    if (item.media_bucket === 'adverse_media' && item.subject_role !== 'direct_actor') {
      review.push({ result_id: item.result_id, reason: 'adverse_role_conflict' });
    }
    if (item.media_bucket !== 'adverse_media' && item.subject_role === 'direct_actor') {
      review.push({ result_id: item.result_id, reason: 'non_adverse_direct_role' });
    }
    return { ...item, legal_stage: legalStage };
  });
  return { classifications: guarded, review };
}
