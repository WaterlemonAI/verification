function normalized(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formalActionOnParty(quote, party) {
  const escaped = escapedPattern(party);
  return new RegExp(`\\b(fines?|fined|penalt\\w*|penaliz\\w*|charg\\w*|convict\\w*|settl\\w*|pardon\\w*)\\b\\s+${escaped}\\b`).test(quote)
    || new RegExp(`\\bimposed\\b.{0,45}\\b(fine|penalty|sanction)\\b.{0,25}\\b(on|against)\\b\\s+${escaped}\\b`).test(quote);
}

const ACTION_CUES = [
  /\bconvict\w*\b/g, /\b(charg\w*|indict\w*)\b/g,
  /\b(fine\w*|penalt\w*|penaliz\w*)\b/g, /\bsettl\w*\b/g, /\bpardon\w*\b/g
];

function positiveCueNearParty(text, party, cue) {
  for (const match of text.matchAll(cue)) {
    let at = text.indexOf(party);
    while (at >= 0) {
      const start = Math.min(at, match.index);
      const end = Math.max(at + party.length, match.index + match[0].length);
      if (end - start <= 80
        && !/\b(no|not|without|denies)\b/.test(text.slice(Math.max(0, match.index - 18), match.index))
        && !/\b(no|not|without|denies)\b/.test(text.slice(start, end))) return true;
      at = text.indexOf(party, at + 1);
    }
  }
  return false;
}

// Source observations are independent. Only the caller's verified event_ref
// may link two records; a model-generated narrative cannot create that link.
export function validateGptSourceLedger({ sources, observations, verifiedEventRefs = {} }) {
  if (!Array.isArray(sources) || !Array.isArray(observations)) {
    throw new TypeError('invalid_gpt_source_ledger');
  }
  const byId = new Map(sources.map((source) => [source.id, source]));
  if (byId.size !== sources.length || observations.length !== sources.length) {
    throw new TypeError('gpt_source_ledger_count_mismatch');
  }
  const seen = new Set();
  const accepted = [];
  const review = [];
  for (const observation of observations) {
    const source = byId.get(observation?.source_id);
    if (!source || seen.has(source.id)) throw new TypeError('gpt_source_ledger_id_mismatch');
    seen.add(source.id);
    const quote = normalized(observation.supporting_quote);
    const text = normalized(`${source.title || ''} ${source.excerpt || ''}`);
    const party = normalized(observation.acted_party);
    const reasons = [];
    if (quote.length < 12 || !text.includes(quote)) reasons.push('unsupported_quote');
    if (!party || !quote.includes(party)) reasons.push('party_not_in_quote');
    if (!['formal_action', 'allegation', 'material_incident', 'ordinary_news', 'unsupported_claim', 'none'].includes(observation.action_kind)) {
      reasons.push('invalid_action_kind');
    }
    if (observation.action_kind === 'ordinary_news'
      && /\b(fine\w*|penalt\w*|penaliz\w*|charg\w*|convict\w*|settle\w*|pardon\w*)\b/.test(quote)) {
      reasons.push('formal_action_in_ordinary_quote');
    }
    if (typeof observation.headline_disputed !== 'boolean') reasons.push('invalid_dispute_flag');
    if (reasons.length) {
      review.push({ source_id: source.id, reasons });
      continue;
    }
    const excerpt = normalized(source.excerpt);
    const explicitKeyDefect = /डिजिटल कीज.{0,50}कमजोरी सामने आई|\b(?:private|digital|cryptographic) keys? (?:were|are) (?:found )?weak\b/.test(excerpt);
    let actionKind = observation.action_kind;
    if (actionKind !== 'formal_action' && formalActionOnParty(quote, party)) {
      actionKind = 'formal_action';
      review.push({ source_id: source.id, reasons: ['formal_action_normalized'] });
    }
    if (actionKind === 'unsupported_claim' && explicitKeyDefect
      && !/\b(anonymous|forum)\b/.test(normalized(source.publisher))) {
      actionKind = 'material_incident';
      review.push({ source_id: source.id, reasons: ['documented_key_defect_normalized'] });
    }
    let headlineDisputed = observation.headline_disputed;
    const title = normalized(source.title);
    if (headlineDisputed && title.includes(party)
      && ACTION_CUES.some((cue) => positiveCueNearParty(title, party, cue)
        && positiveCueNearParty(quote, party, cue))) {
      headlineDisputed = false;
      review.push({ source_id: source.id, reasons: ['matching_headline_normalized'] });
    }
    const headlineClaimsDataLeak = /\bdata (?:leak|breach)\b|डेटा लीक/.test(title);
    const excerptDescribesKeyWeakness = /\b(?:private|digital|cryptographic) keys?\b|\bcertificates?\b|डिजिटल कीज|निजी कीज|सर्टिफिकेट/.test(excerpt)
      && /\b(?:weak|compromis|flaw|incident)\w*\b|कमजोरी|कमजोर|सेंध/.test(excerpt);
    const excerptReportsDataLeak = /\bdata (?:leak|breach)\b|डेटा लीक/.test(excerpt)
      && !/\bno data (?:leak|breach)\b|डेटा लीक नहीं/.test(excerpt);
    if (!headlineDisputed && title.includes(party) && headlineClaimsDataLeak
      && excerptDescribesKeyWeakness && !excerptReportsDataLeak) {
      headlineDisputed = true;
      review.push({ source_id: source.id, reasons: ['headline_data_leak_scope_review'] });
    }
    accepted.push({ source_id: source.id, acted_party: observation.acted_party,
      action_kind: actionKind, supporting_quote: observation.supporting_quote,
      headline_disputed: headlineDisputed,
      event_ref: Object.hasOwn(verifiedEventRefs, source.id) ? verifiedEventRefs[source.id] : null });
  }
  const groups = new Map();
  for (const item of accepted) {
    if (!item.event_ref) continue;
    const group = groups.get(item.event_ref) || [];
    group.push(item.source_id);
    groups.set(item.event_ref, group);
  }
  return { observations: accepted, review,
    linked_events: [...groups].filter(([, ids]) => ids.length > 1)
      .map(([event_ref, source_ids]) => ({ event_ref, source_ids })) };
}
