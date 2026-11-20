// A profile is an evidence decision, never a risk-score threshold decision.
// Source coverage and article adjudication are deliberately separate inputs.
export function decideAdverseMediaProfile({ coverageComplete, classificationComplete, adverseCount,
  unresolvedCount }) {
  if (!Number.isInteger(adverseCount) || adverseCount < 0 || !Number.isInteger(unresolvedCount) || unresolvedCount < 0) {
    throw new TypeError('Invalid adverse-media evidence counts');
  }
  if (adverseCount > 0) {
    return { profile: 'unsafe', decisionEligible: coverageComplete && classificationComplete,
      reason: !coverageComplete || !classificationComplete ? 'confirmed_adverse_incomplete_coverage' : 'confirmed_adverse' };
  }
  if (!coverageComplete) return { profile: 'inconclusive', decisionEligible: false, reason: 'incomplete_coverage' };
  if (!classificationComplete || unresolvedCount > 0) {
    return { profile: 'inconclusive', decisionEligible: false, reason: 'classification_uncertain' };
  }
  return { profile: 'safe', decisionEligible: true, reason: 'no_confirmed_adverse' };
}
