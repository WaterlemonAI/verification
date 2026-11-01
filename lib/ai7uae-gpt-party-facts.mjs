const RELATIONS = new Set(['screened_subject', 'related_party', 'different_entity', 'victim', 'incidental', 'unclear']);
const EVENTS = new Set(['legal_action', 'adverse_allegation', 'material_incident', 'ordinary_event', 'unsupported_claim', 'irrelevant']);
const STAGES = new Set(['media_mention', 'allegation', 'investigation', 'arrested', 'charged', 'convicted', 'regulatory_action', 'settled', 'pardoned']);
const STAGE_CUES = Object.freeze({
  allegation: /\b(alleg\w*|accus\w*|complaint|claim\w*)\b|ادعاء|زعم|يزعم|يدعي/,
  investigation: /\b(investigat\w*|probe\w*|inquiry)\b|تحقيق/,
  arrested: /\b(arrest\w*|detain\w*)\b|اعتقال|قبض/,
  charged: /\b(charg\w*|indict\w*)\b|اتهام|تهمة/,
  convicted: /\b(convict\w*|found guilty|guilty verdict)\b|إدانة|أدين|أدانت/,
  regulatory_action: /\b(fine\w*|penalt\w*|penaliz\w*|sanction\w*|infringement|regulatory action)\b|غرامة|تغريم|عقوبة/,
  settled: /\b(settl\w*|resolution agreement)\b|تسوية|تصالح/,
  pardoned: /\b(pardon\w*|clemency)\b|عفو/
});

function normalized(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resultFor(fact) {
  const { party_relation: relation, event_kind: event } = fact;
  if (relation === 'related_party') return ['general_news_mentions', 'related_party', 'media_mention'];
  if (relation === 'different_entity') return ['no_impact_media', 'namesake', 'media_mention'];
  if (relation === 'victim') return ['no_impact_media', 'victim', 'media_mention'];
  if (relation === 'incidental') return ['no_impact_media', 'context_only', 'media_mention'];
  if (relation === 'unclear') return ['general_news_mentions', 'unclear', 'media_mention'];
  if (event === 'legal_action' || event === 'adverse_allegation') {
    return ['adverse_media', 'direct_actor', fact.reported_stage];
  }
  if (event === 'material_incident') return ['adverse_media', 'direct_actor', 'media_mention'];
  if (event === 'unsupported_claim') return ['general_news_mentions', 'unclear', 'media_mention'];
  if (event === 'irrelevant') return ['no_impact_media', 'context_only', 'media_mention'];
  return ['general_news_mentions', 'context_only', 'media_mention'];
}

// Converts source facts into subject-specific labels. Any unsupported fact is
// withheld for review instead of being turned into a safe or adverse decision.
export function adjudicateGptPartyFacts({ subject, evidence, facts }) {
  if (!subject?.name || !Array.isArray(evidence) || !Array.isArray(facts)) {
    throw new TypeError('invalid_gpt_party_fact_input');
  }
  const expected = new Map(evidence.map((item) => [item.id, item]));
  if (expected.size !== evidence.length || facts.length < evidence.length || facts.length > evidence.length * 3) {
    throw new TypeError('gpt_party_fact_count_mismatch');
  }
  const aliases = new Set([subject.name, ...(subject.aliases || [])].map(normalized));
  const grouped = new Map(evidence.map((item) => [item.id, []]));
  for (const fact of facts) {
    if (!grouped.has(fact?.result_id)) throw new TypeError('gpt_party_fact_id_mismatch');
    const group = grouped.get(fact.result_id);
    if (group.length === 3) throw new TypeError('gpt_party_fact_count_mismatch');
    group.push(fact);
  }
  const results = [];
  const review = [];
  for (const source of evidence) {
    const candidates = grouped.get(source.id);
    if (!candidates.length) {
      review.push({ result_id: source.id, reasons: ['missing_party_fact'] });
      continue;
    }
    const valid = [];
    for (const fact of candidates) {
      const reasons = [];
      if (!RELATIONS.has(fact.party_relation) || !EVENTS.has(fact.event_kind) || !STAGES.has(fact.reported_stage)) {
        reasons.push('invalid_party_fact_enum');
      }
      const quote = normalized(fact.supporting_quote);
      const sourceText = normalized(`${source.title || ''} ${source.excerpt || ''}`);
      if (quote.length < 12 || !sourceText.includes(quote)) reasons.push('unsupported_quote');
      const party = normalized(fact.acted_party);
      if (party && ['legal_action', 'adverse_allegation', 'material_incident'].includes(fact.event_kind)
        && !quote.includes(party)) reasons.push('party_not_in_quote');
      if (fact.party_relation === 'victim'
        && !/\b(victim|target\w*|impersonat\w*|defraud\w*|divert\w*|stol\w*|hacked)\b|ضحية|انتحال|اختراق|تعرضت/.test(sourceText)) {
        reasons.push('victim_relation_unproven');
      }
      if (fact.party_relation === 'screened_subject' && ['legal_action', 'adverse_allegation'].includes(fact.event_kind)
        && STAGE_CUES[fact.reported_stage] && !STAGE_CUES[fact.reported_stage].test(quote)) {
        reasons.push('stage_not_in_quote');
      }
      if (fact.party_relation === 'screened_subject' && !aliases.has(party)) reasons.push('subject_party_mismatch');
      if (fact.party_relation === 'related_party'
        && (!party || (aliases.has(party) && fact.event_kind !== 'ordinary_event'))) reasons.push('other_party_mismatch');
      if (fact.party_relation === 'different_entity' && !party) reasons.push('other_party_missing');
      if (fact.party_relation === 'screened_subject'
        && ['legal_action', 'adverse_allegation'].includes(fact.event_kind)
        && fact.reported_stage === 'media_mention') reasons.push('missing_reported_stage');
      if (reasons.length) {
        review.push({ result_id: fact.result_id, reasons });
        continue;
      }
      valid.push(fact);
    }
    const subjectAction = valid.filter((fact) => fact.party_relation === 'screened_subject'
      && ['legal_action', 'adverse_allegation', 'material_incident'].includes(fact.event_kind));
    const relatedAction = valid.filter((fact) => fact.party_relation === 'related_party'
      && ['legal_action', 'adverse_allegation', 'material_incident'].includes(fact.event_kind));
    const preferred = subjectAction.length ? subjectAction : relatedAction.length ? relatedAction : valid;
    if (preferred.length !== 1) {
      if (preferred.length || !review.some((item) => item.result_id === source.id)) {
        review.push({ result_id: source.id, reasons: [preferred.length ? 'ambiguous_party_actions' : 'no_supported_party_fact'] });
      }
      continue;
    }
    const chosen = preferred[0];
    const sourceText = normalized(`${source.title || ''} ${source.excerpt || ''}`);
    const subjectName = normalized(subject.name);
    const allegationNearSubject = new RegExp(`\\b(alleg\\w*|accus\\w*|complaint)\\b.{0,90}\\b${escapedPattern(subjectName)}\\b`);
    const negatedAllegation = new RegExp(`\\b(no|not|without|does not)\\b.{0,30}\\b(alleg\\w*|accus\\w*)\\b.{0,90}\\b${escapedPattern(subjectName)}\\b`);
    if (chosen.party_relation !== 'screened_subject' && chosen.event_kind !== 'unsupported_claim'
      && !/\b(anonymous|forum)\b/.test(normalized(source.publisher))
      && allegationNearSubject.test(sourceText) && !negatedAllegation.test(sourceText)) {
      review.push({ result_id: source.id, reasons: ['subject_allegation_not_extracted'] });
      continue;
    }
    let selected = chosen;
    if (!['screened_subject', 'victim'].includes(chosen.party_relation)
      && ['legal_action', 'adverse_allegation'].includes(chosen.event_kind)
      && STAGE_CUES[chosen.reported_stage]
      && !STAGE_CUES[chosen.reported_stage].test(normalized(chosen.supporting_quote))) {
      review.push({ result_id: source.id, reasons: ['other_party_stage_unverified'] });
    }
    if (chosen.party_relation === 'victim' && chosen.reported_stage !== 'media_mention') {
      selected = { ...chosen, reported_stage: 'media_mention' };
      review.push({ result_id: source.id, reasons: ['victim_stage_neutralized'] });
    }
    if (chosen.party_relation === 'related_party' && chosen.event_kind === 'ordinary_event'
      && aliases.has(normalized(chosen.acted_party))) {
      selected = { ...chosen, party_relation: 'screened_subject' };
      review.push({ result_id: source.id, reasons: ['ordinary_self_relation_normalized'] });
    }
    const brokerShareLink = sourceText.includes(subjectName)
      && ((/\bbrokers?\b/.test(normalized(chosen.acted_party))
        && /\b(trad\w*|trading)\b/.test(sourceText)
        && /\b(shares|securities)\b/.test(sourceText))
        || (/(وسيط|وسطاء)/.test(normalized(chosen.acted_party))
          && /تداول/.test(sourceText) && /أسهم/.test(sourceText)));
    if (brokerShareLink && chosen.party_relation !== 'related_party') {
      selected = { ...chosen, party_relation: 'related_party' };
      review.push({ result_id: source.id, reasons: ['broker_share_relation_normalized'] });
    }
    if (selected.party_relation === 'incidental' && selected.event_kind === 'irrelevant'
      && /\b(fine\w*|penalt\w*|penaliz\w*|charg\w*|convict\w*)\b/.test(sourceText)) {
      review.push({ result_id: source.id, reasons: ['other_party_action_not_extracted'] });
      continue;
    }
    const [media_bucket, subject_role, legal_stage] = resultFor(selected);
    results.push({ result_id: source.id, media_bucket, subject_role, legal_stage,
      acted_party: selected.acted_party, supporting_quote: selected.supporting_quote });
  }
  return { results, review };
}
