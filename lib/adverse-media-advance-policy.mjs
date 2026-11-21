import { createHash } from 'node:crypto';
import { decideAdverseMediaProfile } from './adverse-media-profile-decision.mjs';
import { ADVANCE_POLICY_CATALOG_VERSION, ADVANCE_POLICY_IDS, getAdvancePolicy } from './adverse-media-advance-policy-catalog.mjs';

const ACTION_RANK = Object.freeze({ acceptable: 0, review: 1, escalate: 2 });
const ROLES = new Set(['direct_actor', 'related_party', 'victim', 'namesake', 'context_only', 'unclear']);
const SEVERITIES = new Set(['minor', 'moderate', 'serious', 'critical']);
const STAGES = new Set(['media_mention', 'allegation', 'investigation', 'arrested', 'charged',
  'convicted', 'regulatory_action', 'settled', 'pardoned']);
const ADJUDICATION = new Set(['confirmed_event', 'not_adverse', 'unresolved']);
const POLICY_IDS = new Set(ADVANCE_POLICY_IDS);
const STORY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

// Supply this schema to one bounded Gemini event-tagging batch. Schema
// conformance is not evidence verification; evaluateAdvancePolicies checks
// the adjudicated source quote and identity separately.
export function advanceEventTaggingSchema(storyKeys) {
  if (!Array.isArray(storyKeys) || storyKeys.length < 1 || storyKeys.length > 25
    || storyKeys.some((key) => typeof key !== 'string' || !STORY_KEY.test(key))
    || new Set(storyKeys).size !== storyKeys.length) {
    throw new TypeError('advance_story_batch_invalid');
  }
  return {
    type: 'object', additionalProperties: false, required: ['events'],
    properties: { events: { type: 'array', minItems: storyKeys.length, maxItems: storyKeys.length,
      items: { type: 'object', additionalProperties: false,
        required: ['story_key', 'event_type_ids', 'severity', 'legal_stage', 'supporting_quote', 'confidence'],
        properties: {
          story_key: { type: 'string', enum: [...storyKeys] },
          event_type_ids: { type: 'array', uniqueItems: true, maxItems: 8,
            items: { type: 'string', enum: [...ADVANCE_POLICY_IDS] } },
          severity: { type: 'string', enum: [...SEVERITIES] },
          legal_stage: { type: 'string', enum: [...STAGES] },
          supporting_quote: { type: 'string', maxLength: 600 },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        } } } }
  };
}

export function validateAdvanceEventTags(response, storyKeys) {
  advanceEventTaggingSchema(storyKeys);
  if (!record(response) || Object.keys(response).some((key) => key !== 'events')
    || !Array.isArray(response.events) || response.events.length !== storyKeys.length) {
    throw new TypeError('advance_event_tags_invalid');
  }
  const byStory = new Map();
  for (const item of response.events) {
    if (!record(item) || Object.keys(item).some((key) =>
      !['story_key', 'event_type_ids', 'severity', 'legal_stage', 'supporting_quote', 'confidence'].includes(key))
      || !storyKeys.includes(item.story_key) || byStory.has(item.story_key)
      || !Array.isArray(item.event_type_ids) || item.event_type_ids.length > 8
      || item.event_type_ids.some((id) => !POLICY_IDS.has(id))
      || new Set(item.event_type_ids).size !== item.event_type_ids.length
      || !SEVERITIES.has(item.severity) || !STAGES.has(item.legal_stage)
      || typeof item.supporting_quote !== 'string' || item.supporting_quote.length > 600
      || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new TypeError('advance_event_tags_invalid');
    }
    byStory.set(item.story_key, Object.freeze({ ...item, event_type_ids: Object.freeze([...item.event_type_ids]) }));
  }
  return Object.freeze(storyKeys.map((key) => byStory.get(key)));
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function action(value) {
  if (!Object.hasOwn(ACTION_RANK, value)) throw new TypeError('advance_policy_action_invalid');
  return value;
}

function name(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new TypeError(field + '_invalid');
  }
  return value;
}

function matrixKey(value) {
  const parts = value.split(':');
  if ((parts.length !== 2 && parts.length !== 3) || !ROLES.has(parts[0])
    || !SEVERITIES.has(parts[1]) || (parts.length === 3 && !STAGES.has(parts[2]))) {
    throw new TypeError('advance_policy_matrix_key_invalid');
  }
}

function compileRule(policy, trustedRule) {
  if (trustedRule !== undefined && !record(trustedRule)) throw new TypeError('advance_policy_rule_invalid');
  const rule = trustedRule || {};
  if (Object.keys(rule).some((key) => !['default_action', 'matrix'].includes(key))) {
    throw new TypeError('advance_policy_rule_field_invalid');
  }
  const matrix = rule.matrix === undefined ? {} : rule.matrix;
  if (!record(matrix) || Object.keys(matrix).length > ROLES.size * SEVERITIES.size * (STAGES.size + 1)) {
    throw new TypeError('advance_policy_matrix_invalid');
  }
  const sortedMatrix = {};
  for (const key of Object.keys(matrix).sort()) {
    matrixKey(key);
    sortedMatrix[key] = action(matrix[key]);
  }
  return Object.freeze({
    id: policy.id,
    default_action: action(rule.default_action === undefined ? policy.default_action : rule.default_action),
    matrix: Object.freeze(sortedMatrix)
  });
}

// Only the policy IDs belong in the public request. The second argument must
// come from a trusted, versioned workspace policy configuration.
export function compileAdvancePolicySet(input, { trustedRules = {} } = {}) {
  if (!record(input) || Object.keys(input).some((key) =>
    !['policy_ids', 'policy_set_id', 'policy_set_version'].includes(key))) {
    throw new TypeError('advance_policy_selection_invalid');
  }
  const ids = input.policy_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > ADVANCE_POLICY_IDS.length
    || ids.some((id) => typeof id !== 'string' || !POLICY_IDS.has(id))
    || new Set(ids).size !== ids.length) {
    throw new TypeError('advance_policy_ids_invalid');
  }
  if (!record(trustedRules) || Object.keys(trustedRules).some((id) => !POLICY_IDS.has(id))) {
    throw new TypeError('advance_trusted_rules_invalid');
  }
  const policies = Object.freeze([...ids].sort().map((id) =>
    compileRule(getAdvancePolicy(id), trustedRules[id])));
  const snapshot = {
    catalog_version: ADVANCE_POLICY_CATALOG_VERSION,
    policy_set_id: name(input.policy_set_id === undefined ? 'default' : input.policy_set_id, 'policy_set_id'),
    policy_set_version: name(input.policy_set_version === undefined ? '1' : input.policy_set_version, 'policy_set_version'),
    policies
  };
  const sha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return Object.freeze({ ...snapshot, sha256 });
}

function assertCompiled(selection) {
  if (!record(selection) || !Array.isArray(selection.policies)
    || selection.catalog_version !== ADVANCE_POLICY_CATALOG_VERSION
    || !/^[a-f0-9]{64}$/.test(selection.sha256 || '')) {
    throw new TypeError('advance_policy_snapshot_invalid');
  }
  const { sha256, ...snapshot } = selection;
  if (createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') !== sha256
    || snapshot.policies.some((item) => !POLICY_IDS.has(item.id))) {
    throw new TypeError('advance_policy_snapshot_invalid');
  }
}

function quoteSupported(quote, sourceText) {
  if (typeof quote !== 'string' || quote.trim().length < 12 || quote.length > 600
    || typeof sourceText !== 'string' || sourceText.length > 200_000) return false;
  const normalize = (value) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return normalize(sourceText).includes(normalize(quote));
}

function findingFact(finding, index) {
  const validKey = typeof finding?.story_key === 'string' && STORY_KEY.test(finding.story_key);
  const key = validKey ? finding.story_key : 'unidentified-' + index;
  const id = typeof finding?.finding_id === 'string' && STORY_KEY.test(finding.finding_id)
    ? finding.finding_id : key;
  if (!validKey) return { id, key, status: 'unresolved', reason: 'story_key_missing' };
  const adjudication = finding?.adjudication;
  if (!record(adjudication) || !ADJUDICATION.has(adjudication.status)) {
    return { id, key, status: 'unresolved', reason: 'adjudication_invalid' };
  }
  if (adjudication.status === 'not_adverse') {
    return Number.isFinite(adjudication.confidence) && adjudication.confidence >= 0.75
      && ROLES.has(adjudication.subject_role)
      && quoteSupported(adjudication.supporting_quote, finding.evidence_text)
      ? { id, key, status: 'not_adverse' }
      : { id, key, status: 'unresolved', reason: 'non_adverse_evidence_unverified' };
  }
  if (adjudication.status === 'unresolved') return { id, key, status: 'unresolved', reason: 'adjudication_unresolved' };
  if (adjudication.entity_match !== 'confirmed'
    || !ROLES.has(adjudication.subject_role) || ['namesake', 'context_only', 'unclear'].includes(adjudication.subject_role)
    || !Number.isFinite(adjudication.confidence) || adjudication.confidence < 0.75
    || !quoteSupported(adjudication.supporting_quote, finding.evidence_text)) {
    return { id, key, status: 'unresolved', reason: 'direct_evidence_unverified' };
  }
  const eventIds = finding.event_type_ids;
  if (!Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > ADVANCE_POLICY_IDS.length
    || eventIds.some((eventId) => typeof eventId !== 'string' || !POLICY_IDS.has(eventId))
    || !SEVERITIES.has(finding.severity) || !STAGES.has(finding.legal_stage)) {
    return { id, key, status: 'confirmed_event', eventIds: [],
      role: adjudication.subject_role, severity: finding.severity, stage: finding.legal_stage,
      reason: 'event_classification_invalid' };
  }
  return { id, key, status: 'confirmed_event', eventIds: [...new Set(eventIds)],
    role: adjudication.subject_role, severity: finding.severity, stage: finding.legal_stage };
}

function ruleAction(rule, fact) {
  const exact = fact.role + ':' + fact.severity + ':' + fact.stage;
  const broad = fact.role + ':' + fact.severity;
  const roleDefault = fact.role === 'related_party' ? 'review'
    : fact.role === 'victim' ? 'acceptable' : rule.default_action;
  return { action: rule.matrix[exact] || rule.matrix[broad] || roleDefault,
    rule_key: rule.matrix[exact] ? exact : rule.matrix[broad] ? broad : 'default' };
}

// This function never calls a search or AI provider. Each article is classified
// once upstream; evaluating many selected policies is a local, bounded pass.
export function evaluateAdvancePolicies({ selection, findings, coverage }) {
  assertCompiled(selection);
  if (!Array.isArray(findings) || findings.length > 10_000 || !record(coverage)) {
    throw new TypeError('advance_policy_evaluation_invalid');
  }
  const sourceComplete = coverage.source_complete === true;
  const articleReviewComplete = coverage.article_review_complete === true;
  const classificationComplete = coverage.classification_complete === true;
  const sufficientAdverse = coverage.sufficient_adverse === true;
  const externalUnresolved = Number.isInteger(coverage.unresolved_count) && coverage.unresolved_count >= 0
    ? coverage.unresolved_count : 1;
  const selected = new Map(selection.policies.map((item) => [item.id, item]));
  const perPolicy = new Map(selection.policies.map((item) => [item.id, {
    policy_id: item.id, default_action: item.default_action, triggered_stories: new Set(),
    highest_action: null, applications: []
  }]));
  const directAdverseStories = new Set();
  const relatedEventStories = new Set();
  const unresolvedStories = new Set();
  const unselectedStories = new Set();
  const findingDecisions = [];
  let strongest = 0;
  findings.forEach((finding, index) => {
    const fact = findingFact(finding, index);
    const decision = { finding_id: fact.id, story_key: fact.key, status: fact.status,
      matched_policies: [], unselected_event_types: [] };
    if (fact.status === 'unresolved') {
      unresolvedStories.add(fact.key);
      decision.reason = fact.reason;
    } else if (fact.status === 'confirmed_event') {
      if (fact.role === 'direct_actor') directAdverseStories.add(fact.key);
      else relatedEventStories.add(fact.key);
      if (fact.reason) {
        unresolvedStories.add(fact.key);
        unselectedStories.add(fact.key);
        decision.reason = fact.reason;
      }
      for (const eventId of fact.eventIds) {
        const rule = selected.get(eventId);
        if (!rule) {
          unselectedStories.add(fact.key);
          decision.unselected_event_types.push(eventId);
          continue;
        }
        const applied = ruleAction(rule, fact);
        const row = perPolicy.get(eventId);
        const existing = row.applications.find((item) => item.story_key === fact.key);
        if (!existing) {
          row.triggered_stories.add(fact.key);
          row.applications.push({ story_key: fact.key, action: applied.action, rule_key: applied.rule_key });
        } else if (ACTION_RANK[applied.action] > ACTION_RANK[existing.action]) {
          existing.action = applied.action;
          existing.rule_key = applied.rule_key;
        }
        if (row.highest_action === null || ACTION_RANK[applied.action] > ACTION_RANK[row.highest_action]) {
          row.highest_action = applied.action;
        }
        strongest = Math.max(strongest, ACTION_RANK[applied.action]);
        decision.matched_policies.push({ policy_id: eventId, ...applied });
      }
    }
    findingDecisions.push(decision);
  });
  const unresolvedCount = externalUnresolved + unresolvedStories.size;
  const fullCoverage = sourceComplete && articleReviewComplete;
  const classificationReady = classificationComplete && unresolvedCount === 0;
  const sufficientForUnsafe = sufficientAdverse && directAdverseStories.size >= 10 && classificationReady;
  const evidence = decideAdverseMediaProfile({
    coverageComplete: fullCoverage || sufficientForUnsafe,
    classificationComplete: classificationReady,
    adverseCount: directAdverseStories.size,
    unresolvedCount
  });
  const reasons = [];
  if (!sourceComplete) reasons.push('source_incomplete');
  if (!articleReviewComplete) reasons.push('article_review_incomplete');
  if (!classificationComplete) reasons.push('classification_incomplete');
  if (unresolvedCount) reasons.push('unresolved_evidence');
  if (unselectedStories.size) reasons.push('unselected_adverse_type');
  if ((!fullCoverage || !classificationReady || unselectedStories.size) && strongest < ACTION_RANK.review) {
    strongest = ACTION_RANK.review;
  }
  const status = Object.keys(ACTION_RANK).find((item) => ACTION_RANK[item] === strongest);
  const policyEligible = (fullCoverage && classificationReady && unselectedStories.size === 0)
    || (status === 'escalate' && sufficientForUnsafe && unselectedStories.size === 0);
  return {
    policy_set: { catalog_version: selection.catalog_version, policy_set_id: selection.policy_set_id,
      policy_set_version: selection.policy_set_version, sha256: selection.sha256,
      selected_policy_ids: selection.policies.map((item) => item.id) },
    evidence_profile: { status: evidence.profile,
      decision_eligible: evidence.decisionEligible, reason: sufficientForUnsafe && !fullCoverage
        ? 'sufficient_adverse_media_found' : evidence.reason },
    policy_outcome: { status, decision_eligible: policyEligible, reason_codes: reasons },
    counts: { distinct_adverse_stories: directAdverseStories.size,
      related_event_stories: relatedEventStories.size, unresolved_stories: unresolvedCount,
      unselected_adverse_stories: unselectedStories.size },
    policy_results: [...perPolicy.values()].map((row) => ({
      policy_id: row.policy_id, default_action: row.default_action,
      status: row.triggered_stories.size ? 'triggered' : 'not_triggered',
      triggered_stories: row.triggered_stories.size, highest_action: row.highest_action,
      applications: row.applications
    })),
    finding_decisions: findingDecisions
  };
}
