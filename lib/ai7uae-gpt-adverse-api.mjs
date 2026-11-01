import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';
import { ai7uaeGptInstructions, ai7uaeUntrustedEvidence } from './ai7uae-gpt-guidelines.mjs';
import { adjudicateGptPartyFacts } from './ai7uae-gpt-party-facts.mjs';

const DEPLOYMENT = 'ai7uae-gpt-5-mini';
const INPUT_PRICE = 0.25 / 1_000_000;
const OUTPUT_PRICE = 2 / 1_000_000;
const MAX_BATCH = 8;

const schema = {
  type: 'object', additionalProperties: false, required: ['facts'],
  properties: { facts: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['result_id', 'party_relation', 'acted_party', 'event_kind', 'reported_stage', 'supporting_quote'],
    properties: {
      result_id: { type: 'string' },
      party_relation: { type: 'string', enum: ['screened_subject', 'related_party', 'different_entity', 'victim', 'incidental', 'unclear'] },
      acted_party: { type: 'string' },
      event_kind: { type: 'string', enum: ['legal_action', 'adverse_allegation', 'material_incident', 'ordinary_event', 'unsupported_claim', 'irrelevant'] },
      reported_stage: { type: 'string', enum: ['media_mention', 'allegation', 'investigation', 'arrested', 'charged', 'convicted', 'regulatory_action', 'settled', 'pardoned'] },
      supporting_quote: { type: 'string' }
    }
  } } }
};

function outputText(body) {
  return body.output_text || (body.output || []).flatMap((item) => item.content || [])
    .map((item) => item.text || '').join('');
}

function factsInput(request, evidence) {
  return ai7uaeUntrustedEvidence({ subject: {
    type: request.entity_type, name: request.name, aliases: request.aliases, countries: request.countries
  }, evidence });
}

function cleanSearchText(value, limit) {
  return String(value || '').slice(0, limit * 3)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_match, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ' ';
    })
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_match, entity) => ({
      amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' '
    })[entity.toLowerCase()])
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

function evidenceFor(candidates) {
  return candidates.map((item) => ({ id: item.result_id, title: cleanSearchText(item.title, 300),
    excerpt: cleanSearchText(item.excerpt, 600), publisher: cleanSearchText(item.publisher, 100),
    url: item.url }));
}

function usage(body) {
  const inputTokens = Number(body.usage?.input_tokens) || 0;
  const outputTokens = Number(body.usage?.output_tokens) || 0;
  return { inputTokens, outputTokens, cost: Math.ceil((inputTokens * INPUT_PRICE + outputTokens * OUTPUT_PRICE) * 1_000_000) / 1_000_000 };
}

function safeFailureCode(error) {
  const message = String(error?.message || '');
  if (/^gpt_party_fact(?:s)?_(?:http_\d{3}|state_[a-z_]+|[a-z_]+)$/.test(message)) return message;
  if (error?.name === 'SyntaxError') return 'invalid_json';
  if (error?.name === 'TimeoutError') return 'timeout';
  return 'call_failed';
}

export function createGptAdverseClassifier({
  credential = new ContainerAppsManagedIdentityCredential(),
  endpoint = process.env.AZURE_OPENAI_ENDPOINT || 'https://aoai-ai7uae-uaen-001.openai.azure.com'
} = {}) {
  const url = new URL('/openai/v1/responses', endpoint);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.openai.azure.com')) throw new TypeError('invalid_azure_openai_endpoint');
  return async function classify(results, request, { fetchImpl }) {
    if (!results.length) return { status: 'not_needed', results, candidates: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    const token = (await credential.getToken('https://cognitiveservices.azure.com/.default')).token;
    const instructions = ai7uaeGptInstructions('edd', 'adverse_media_party_facts') +
      '\n\nCopy one short, verbatim quote containing acted_party from the same item. For a formal stage, include the stage cue in that quote. Return every result_id exactly once or more when distinct parties have separate material actions.';
    const classified = [];
    const totals = { candidates: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    const reviewReasons = {};
    const countReason = (reason) => { reviewReasons[reason] = (reviewReasons[reason] || 0) + 1; };
    let incomplete = false;
    for (let offset = 0; offset < results.length; offset += MAX_BATCH) {
      const candidates = results.slice(offset, offset + MAX_BATCH);
      totals.candidates += candidates.length;
      const evidence = evidenceFor(candidates);
      const subject = { name: request.name, aliases: request.aliases };
      const call = async (selected, reasoning, maxOutputTokens) => {
        const payload = { model: DEPLOYMENT, instructions,
          input: 'Extract source facts for the screened subject. ' + factsInput(request, selected),
          reasoning: { effort: reasoning }, max_output_tokens: maxOutputTokens,
          text: { format: { type: 'json_schema', name: 'party_facts', schema, strict: true } } };
        const response = await fetchImpl(url, { method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(45_000) });
        const body = await response.json();
        const measured = usage(body);
        totals.inputTokens += measured.inputTokens;
        totals.outputTokens += measured.outputTokens;
        totals.cost += measured.cost;
        if (!response.ok) throw new Error(`gpt_party_facts_http_${response.status}`);
        if (body.status !== 'completed') throw new Error(`gpt_party_facts_state_${body.status || 'unknown'}`);
        const facts = JSON.parse(outputText(body)).facts;
        return adjudicateGptPartyFacts({ subject, evidence: selected, facts });
      };
      let adjudicated;
      try { adjudicated = await call(evidence, 'minimal', 4096); }
      catch (error) { countReason(safeFailureCode(error)); incomplete = true; classified.push(...candidates); continue; }
      const accepted = new Map(adjudicated.results.map((item) => [item.result_id, item]));
      const reviews = new Set(adjudicated.review.map((item) => item.result_id));
      for (const item of adjudicated.review) for (const reason of item.reasons) countReason(reason);
      const missing = evidence.filter((item) => !accepted.has(item.id));
      for (let retryOffset = 0; retryOffset < missing.length; retryOffset += 3) {
        const retryEvidence = missing.slice(retryOffset, retryOffset + 3);
        try {
          const retried = await call(retryEvidence, 'low', 2048);
          for (const item of retried.results) accepted.set(item.result_id, item);
          for (const item of retried.review) {
            reviews.add(item.result_id);
            for (const reason of item.reasons) countReason(reason);
          }
        } catch (error) { countReason(safeFailureCode(error)); }
      }
      if (accepted.size !== candidates.length) incomplete = true;
      for (const candidate of candidates) {
        const fact = accepted.get(candidate.result_id);
        if (!fact) { classified.push(candidate); continue; }
        const reviewRequired = reviews.has(candidate.result_id);
        const adverse = fact.media_bucket === 'adverse_media' ? 'confirmed'
          : fact.subject_role === 'related_party' || fact.subject_role === 'unclear' ? 'possible' : 'not_adverse';
        classified.push({ ...candidate, ai_classification: {
          provider: 'azure_openai',
          entity_match: fact.subject_role === 'namesake' ? 'unlikely' : fact.subject_role === 'unclear' ? 'possible' : 'confirmed',
          subject_role: fact.subject_role,
          media_bucket: fact.media_bucket,
          adverse,
          categories: fact.media_bucket === 'adverse_media' ? candidate.categories : [],
          legal_stage: fact.legal_stage,
          confidence: reviewRequired ? 0.7 : 0.9,
          summary: `${fact.acted_party}: ${fact.supporting_quote}`.slice(0, 240)
        } });
      }
    }
    if (classified.length && !classified.some((item) => item.ai_classification?.provider === 'azure_openai')) {
      console.warn('gpt_party_facts_no_supported_items', JSON.stringify({ candidates: totals.candidates, reasons: reviewReasons }));
    } else if (incomplete) {
      console.warn('gpt_party_facts_partial', JSON.stringify({ candidates: totals.candidates,
        supported: classified.filter((item) => item.ai_classification?.provider === 'azure_openai').length,
        reasons: reviewReasons }));
    }
    return { status: incomplete ? 'partial' : 'completed', results: classified,
      ...totals, cost: Math.ceil(totals.cost * 1_000_000) / 1_000_000 };
  };
}
