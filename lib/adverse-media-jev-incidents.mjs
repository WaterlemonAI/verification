import { createHash } from 'node:crypto';
import { JevScreeningError, JEV_SCREENING_MODEL, validateJevEventRegister } from './adverse-media-jev-screening.mjs';

export const JEV_INCIDENT_CONTRACT = 'advance-incident-grouping-v1';
const URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_TEXT_SENT = 8_000;
const MAX_ESTIMATED_COST_USD = 0.20;
const INCIDENT_DEADLINE_MS = 180_000;
const PAIR_CHOICES = ['same', 'different', 'inconclusive'];

function evidence(article) {
  return { story_key: article.story_key, title: article.title, url: article.url,
    publisher: article.publisher, published_at: article.published_at,
    excerpt: article.excerpt, text: article.text.slice(0, MAX_TEXT_SENT),
    text_truncated: article.text.length > MAX_TEXT_SENT };
}

export function jevIncidentEligibilityRequest(subject, article) {
  return { model: JEV_SCREENING_MODEL, state: { subject, article: evidence(article) },
    questions: { specific_incident: {
      type: 'noul',
      instructions: 'Does this article describe a particular real-world incident or case concerning the screened subject?',
      criteria: {
        true: 'It reports a particular occurrence, dispute, fraud, investigation, proceeding, breach, or its subsequent developments involving the screened subject.',
        false: 'It is generic commentary, a list of unrelated cases, a namesake, or a topic mention with no identifiable incident concerning the screened subject.'
      }
    } } };
}

export function jevIncidentPairRequest(subject, first, second) {
  return { model: JEV_SCREENING_MODEL,
    state: { subject, first_article: evidence(first), second_article: evidence(second) },
    questions: { same_incident: {
      type: 'choice',
      instructions: 'Do these two articles report the same particular real-world incident or case concerning the screened subject?',
      criteria: {
        same: 'They cover the same underlying occurrence or case, including later investigation, charges, judgment, response, or follow-up reporting about it.',
        different: 'They cover distinct occurrences or cases, even if the subject, allegation type, location, or general topic is similar.',
        inconclusive: 'The supplied evidence does not establish whether these are the same occurrence, or a roundup mixes multiple incidents.'
      }
    } } };
}

function modelAnswers(response) {
  if (!response || response.model !== JEV_SCREENING_MODEL || !response.answers
    || typeof response.answers !== 'object' || Array.isArray(response.answers))
    throw new JevScreeningError('invalid_jev_incident_answer');
  return response.answers;
}

function readEligibility(response) {
  const answer = modelAnswers(response).specific_incident;
  if (!answer || answer.type !== 'noul' || !Number.isFinite(answer.noul)
    || answer.noul < 0 || answer.noul > 1)
    throw new JevScreeningError('invalid_jev_incident_answer');
  return answer.noul;
}

function readPair(response) {
  const answer = modelAnswers(response).same_incident;
  const p = answer?.probabilities;
  if (!answer || answer.type !== 'choice' || !PAIR_CHOICES.includes(answer.choice)
    || !p || typeof p !== 'object' || Array.isArray(p)
    || Object.keys(p).length !== PAIR_CHOICES.length
    || !PAIR_CHOICES.every((key) => Number.isFinite(p[key]) && p[key] >= 0 && p[key] <= 1)
    || Math.abs(PAIR_CHOICES.reduce((sum, key) => sum + p[key], 0) - 1) > 0.02
    || PAIR_CHOICES.some((key) => p[key] > p[answer.choice] + 0.000001))
    throw new JevScreeningError('invalid_jev_incident_answer');
  const runnerUp = Math.max(...PAIR_CHOICES.filter((key) => key !== answer.choice).map((key) => p[key]));
  const margin = p[answer.choice] - runnerUp;
  const decision = answer.choice === 'same' && p.same >= 0.85 && margin >= 0.20 ? 'same'
    : answer.choice === 'different' && p.different >= 0.80 && margin >= 0.20 ? 'different'
      : 'inconclusive';
  return { decision, probabilities: { same: p.same, different: p.different,
    inconclusive: p.inconclusive } };
}

function estimatedCost(subject, articles) {
  let bytes = 0;
  for (let i = 0; i < articles.length; i++) {
    bytes += Buffer.byteLength(JSON.stringify(jevIncidentEligibilityRequest(subject, articles[i])));
    for (let j = i + 1; j < articles.length; j++)
      bytes += Buffer.byteLength(JSON.stringify(jevIncidentPairRequest(subject, articles[i], articles[j])));
  }
  return bytes * 0.042 / 1_000_000;
}

async function askJev(request, apiKey, fetchImpl) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('jev_timeout')); }, 20_000);
      });
      const result = (async () => {
        const response = await fetchImpl(URL, { method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(request), signal: controller.signal });
        if (!response.ok) throw new JevScreeningError(`jev_http_${response.status}`);
        return response.json();
      })();
      return await Promise.race([result, timeout]);
    } catch (error) {
      if (error instanceof JevScreeningError) throw error;
      if (attempt === 1) throw new JevScreeningError('jev_provider_unavailable');
    } finally { clearTimeout(timer); }
  }
}

function pairKey(first, second) { return [first, second].sort().join('\u0000'); }

function presentClusters(subject, storyGroups, pairReviews) {
  const owner = new Map(storyGroups.flatMap((keys) => keys.map((key) => [key, keys[0]])));
  const incidents = storyGroups.map((keys) => [...keys].sort())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((storyKeys, index) => ({
      incident_id: `inc-${createHash('sha256').update(`${subject.name}\u0000${storyKeys[0]}`).digest('hex').slice(0, 24)}`,
      incident_label: `Incident ${index + 1}`, story_keys: storyKeys
    }));
  const assignments = incidents.flatMap((incident) => incident.story_keys.map((storyKey) => ({
    story_key: storyKey, incident_id: incident.incident_id,
    incident_label: incident.incident_label,
    group_status: incident.story_keys.length > 1 ? 'grouped' : 'single_article'
  }))).sort((a, b) => a.story_key.localeCompare(b.story_key));
  const unmerged_same_pairs = pairReviews.filter((pair) => pair.decision === 'same'
    && owner.get(pair.first_story_key) !== owner.get(pair.second_story_key))
    .map(({ first_story_key, second_story_key }) => ({ first_story_key, second_story_key }));
  return { incidents, assignments, unmerged_same_pairs };
}

function clusterIncidents(subject, eligible, pairReviews) {
  const clusters = new Map(eligible.map((article) => [article.story_key, [article.story_key]]));
  const owner = new Map(eligible.map((article) => [article.story_key, article.story_key]));
  const byPair = new Map(pairReviews.map((pair) => [pairKey(pair.first_story_key, pair.second_story_key), pair]));
  const samePairs = pairReviews.filter((pair) => pair.decision === 'same')
    .sort((a, b) => b.probabilities.same - a.probabilities.same
      || pairKey(a.first_story_key, a.second_story_key).localeCompare(pairKey(b.first_story_key, b.second_story_key)));
  for (const pair of samePairs) {
    const left = owner.get(pair.first_story_key);
    const right = owner.get(pair.second_story_key);
    if (left === right) continue;
    if (!clusters.get(left).every((a) => clusters.get(right).every((b) =>
      byPair.get(pairKey(a, b))?.decision === 'same'))) continue;
    const merged = [...clusters.get(left), ...clusters.get(right)].sort();
    const anchor = merged[0];
    clusters.delete(left); clusters.delete(right); clusters.set(anchor, merged);
    for (const key of merged) owner.set(key, anchor);
  }
  return presentClusters(subject, [...clusters.values()], pairReviews);
}

export async function groupJevIncidents(input, { apiKey, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + INCIDENT_DEADLINE_MS;
  const { subject, articles } = validateJevEventRegister(input, { maxArticles: 100 });
  if (!apiKey) throw new JevScreeningError('jev_key_unavailable');
  const redundantKeys = new Set(input.articles.filter((item) => item.tag === 'redundant')
    .map((item) => item.story_key));
  const sorted = [...articles].sort((a, b) => a.story_key.localeCompare(b.story_key));
  const costUpperBound = sorted.length <= 20 ? estimatedCost(subject, sorted) : null;
  if (costUpperBound !== null && costUpperBound > MAX_ESTIMATED_COST_USD)
    throw new JevScreeningError('jev_incident_budget_exceeded');
  let reservedCost = 0;
  const ask = async (request) => {
    if (Date.now() >= deadline) throw new JevScreeningError('jev_incident_time_limit');
    const next = Buffer.byteLength(JSON.stringify(request)) * 0.042 / 1_000_000;
    if (reservedCost + next > MAX_ESTIMATED_COST_USD)
      throw new JevScreeningError('jev_incident_budget_exceeded');
    reservedCost += next;
    return askJev(request, apiKey, fetchImpl);
  };
  const eligible = [];
  const unassigned = [];
  const eligibility_reviews = [];
  for (const article of sorted) {
    if (redundantKeys.has(article.story_key)) {
      unassigned.push({ story_key: article.story_key, reason: 'redundant' });
      continue;
    }
    if (!article.text && !article.excerpt) {
      unassigned.push({ story_key: article.story_key, reason: 'insufficient_article_evidence' });
      continue;
    }
    const probability = readEligibility(await ask(jevIncidentEligibilityRequest(subject, article)));
    eligibility_reviews.push({ story_key: article.story_key, specific_incident_probability: probability,
      text_truncated: article.text.length > MAX_TEXT_SENT });
    if (probability >= 0.80) eligible.push(article);
    else unassigned.push({ story_key: article.story_key,
      reason: probability <= 0.20 && article.text.length <= MAX_TEXT_SENT
        ? 'no_specific_incident' : 'incident_inconclusive' });
  }
  const pair_reviews = [];
  let groups;
  let grouping_method;
  if (eligible.length <= 20) {
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const first = eligible[i], second = eligible[j];
        const judgment = readPair(await ask(jevIncidentPairRequest(subject, first, second)));
        pair_reviews.push({ first_story_key: first.story_key, second_story_key: second.story_key, ...judgment });
      }
    }
    groups = clusterIncidents(subject, eligible, pair_reviews);
    grouping_method = 'complete_pairwise';
  } else {
    // Large registers probe the largest current incident first. The first
    // member anchors identity; the latest member checks that a growing group
    // has not drifted. Stop after a supported match to bound provider calls.
    const clusters = [];
    const grouping_warnings = [];
    for (const article of eligible) {
      let matched = false;
      const possibleAnchors = [];
      const ordered = [...clusters].sort((a, b) => b.length - a.length
        || a[0].story_key.localeCompare(b[0].story_key));
      for (const cluster of ordered) {
        const anchor = cluster[0];
        const first = readPair(await ask(jevIncidentPairRequest(subject, anchor, article)));
        pair_reviews.push({ first_story_key: anchor.story_key,
          second_story_key: article.story_key, ...first });
        if (first.decision === 'different') continue;
        if (first.decision === 'inconclusive') possibleAnchors.push(anchor.story_key);
        let second = null;
        if (cluster.length > 1) {
          const latest = cluster.at(-1);
          second = readPair(await ask(jevIncidentPairRequest(subject, latest, article)));
          pair_reviews.push({ first_story_key: latest.story_key,
            second_story_key: article.story_key, ...second });
        }
        if (second?.decision === 'different') {
          if (first.decision === 'same') {
            possibleAnchors.push(anchor.story_key);
            grouping_warnings.push({ story_key: article.story_key,
              reason: 'conflicting_representatives', incident_anchor: anchor.story_key });
          }
          continue;
        }
        if (first.decision === 'same' && (!second || second.decision === 'same')) {
          cluster.push(article);
          matched = true;
          break;
        }
        if (first.decision === 'same' || second?.decision === 'same') {
          possibleAnchors.push(anchor.story_key);
          grouping_warnings.push({ story_key: article.story_key,
            reason: 'insufficient_representative_agreement', incident_anchor: anchor.story_key });
        }
      }
      if (!matched && possibleAnchors.length) {
        unassigned.push({ story_key: article.story_key, reason: 'incident_match_inconclusive',
          possible_incident_anchors: [...new Set(possibleAnchors)] });
      } else if (!matched) clusters.push([article]);
    }
    groups = presentClusters(subject, clusters.map((cluster) => cluster.map((item) => item.story_key)), pair_reviews);
    groups.grouping_warnings = grouping_warnings;
    grouping_method = 'representative_pairs';
  }
  const assignmentByKey = new Map(groups.assignments.map((item) => [item.story_key, item]));
  const unassignedByKey = new Map(unassigned.map((item) => [item.story_key, item]));
  const event_register = { articles: articles.map((article) => assignmentByKey.get(article.story_key)
    || { story_key: article.story_key, incident_id: null, incident_label: null,
      group_status: 'unassigned', reason: unassignedByKey.get(article.story_key).reason }) };
  return { contract: JEV_INCIDENT_CONTRACT, model: JEV_SCREENING_MODEL, ...groups,
    event_register, unassigned, eligibility_reviews, pair_reviews,
    grouping_method, estimated_input_cost_upper_bound_usd: Number(reservedCost.toFixed(6)) };
}
