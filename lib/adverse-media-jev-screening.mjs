export const JEV_SCREENING_MODEL = 'jev-1.14.0';
export const JEV_SCREENING_CONTRACT = 'advance-article-screening-v1';
export const JEV_ADVERSENESS = Object.freeze(['adverse', 'non-adverse', 'inconclusive']);
export const JEV_RELATIONSHIP = Object.freeze(['direct', 'indirect', 'inconclusive']);

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_ARTICLES = 40;
const MAX_TEXT = 48_000;

export class JevScreeningError extends Error {
  constructor(code) { super(code); this.name = 'JevScreeningError'; }
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function field(value, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new JevScreeningError('invalid_event_register');
  return value.trim();
}

export function validateJevEventRegister(input, { maxArticles = MAX_ARTICLES } = {}) {
  if (!object(input) || !object(input.subject) || !Array.isArray(input.articles)
    || input.articles.length < 1 || input.articles.length > maxArticles)
    throw new JevScreeningError('invalid_event_register');
  const subject = {
    name: field(input.subject.name, 200, true),
    entity_type: field(input.subject.entity_type, 30),
    aliases: input.subject.aliases === undefined ? [] : input.subject.aliases
  };
  if (!Array.isArray(subject.aliases) || subject.aliases.length > 20)
    throw new JevScreeningError('invalid_event_register');
  subject.aliases = subject.aliases.map((alias) => field(alias, 200, true));
  const seen = new Set();
  const articles = input.articles.map((item) => {
    if (!object(item)) throw new JevScreeningError('invalid_event_register');
    const article = {
      story_key: field(item.story_key, 160, true),
      title: field(item.title, 500, true),
      url: field(item.url, 2048),
      publisher: field(item.publisher, 200),
      published_at: field(item.published_at, 60),
      excerpt: field(item.excerpt, 2000),
      text: field(item.text, MAX_TEXT)
    };
    if (seen.has(article.story_key)) throw new JevScreeningError('duplicate_story_key');
    seen.add(article.story_key);
    return article;
  });
  return { subject, articles };
}

export function jevArticleRequest(subject, article) {
  return {
    model: JEV_SCREENING_MODEL,
    state: { subject, article },
    questions: {
      subject_association: {
        type: 'noul',
        instructions: 'Is the subject meaningfully connected to the events or facts reported in this article?',
        criteria: {
          true: 'The article is about the screened subject or an identifiable person or entity connected to it.',
          false: 'The name is a different person or entity, or the subject has no meaningful connection to the reported facts.'
        }
      },
      adverseness: {
        type: 'choice',
        instructions: 'What is the adverseness of the reported facts concerning the screened subject?',
        criteria: {
          adverse: 'The article reports a concrete harmful, criminal, regulatory, legal, financial or reputational incident connected to the subject. The subject may be an actor or affected party; do not infer fault.',
          'non-adverse': 'The article reports ordinary, neutral or favorable facts and no supported adverse incident concerning the subject.',
          inconclusive: 'The available article evidence does not establish whether the reported facts concerning the subject are adverse.'
        }
      },
      relationship: {
        type: 'choice',
        instructions: 'How is the screened subject connected to the reported facts in this article?',
        criteria: {
          direct: 'The screened subject itself is directly involved or directly affected, including as a victim; this does not imply fault.',
          indirect: 'The facts concern an identifiable related person or entity, and the screened subject has a supported indirect connection.',
          inconclusive: 'The article does not establish whether the screened subject is directly or indirectly connected.'
        }
      }
    }
  };
}

function choice(answer, allowed) {
  if (!object(answer) || answer.type !== 'choice' || !allowed.includes(answer.choice)
    || !object(answer.probabilities)
    || Object.keys(answer.probabilities).length !== allowed.length
    || !allowed.every((key) => Number.isFinite(answer.probabilities[key])
      && answer.probabilities[key] >= 0 && answer.probabilities[key] <= 1)
    || Math.abs(allowed.reduce((sum, key) => sum + answer.probabilities[key], 0) - 1) > 0.02
    || allowed.some((key) => answer.probabilities[key] > answer.probabilities[answer.choice] + 0.000001))
    throw new JevScreeningError('invalid_jev_answer');
  return answer.choice;
}

export function readJevArticleAnswer(response, storyKey) {
  if (!object(response) || response.model !== JEV_SCREENING_MODEL || !object(response.answers))
    throw new JevScreeningError('invalid_jev_answer');
  const association = response.answers.subject_association;
  if (!object(association) || association.type !== 'noul'
    || !Number.isFinite(association.noul) || association.noul < 0 || association.noul > 1)
    throw new JevScreeningError('invalid_jev_answer');
  const adverseness = choice(response.answers.adverseness, JEV_ADVERSENESS);
  const relationship = choice(response.answers.relationship, JEV_RELATIONSHIP);
  if (association.noul <= 0.3) return { redundant: { story_key: storyKey, tag: 'redundant' } };
  return { screened: { story_key: storyKey, adverseness,
    relationship: association.noul < 0.7 ? 'inconclusive' : relationship } };
}

export async function screenJevEventRegister(input, { apiKey, fetchImpl = fetch } = {}) {
  const { subject, articles } = validateJevEventRegister(input);
  if (!apiKey) throw new JevScreeningError('jev_key_unavailable');
  const screened = [];
  const redundant = [];
  for (const article of articles) {
    // A headline alone cannot settle either classification; retain it for review.
    if (!article.text && !article.excerpt) {
      screened.push({ story_key: article.story_key, adverseness: 'inconclusive', relationship: 'inconclusive' });
      continue;
    }
    let result;
    try {
      const response = await fetchImpl(API_URL, {
        method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(jevArticleRequest(subject, article)),
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new JevScreeningError(`jev_http_${response.status}`);
      result = readJevArticleAnswer(await response.json(), article.story_key);
    } catch (error) {
      if (error instanceof JevScreeningError) throw error;
      throw new JevScreeningError('jev_provider_unavailable');
    }
    if (result.redundant) redundant.push(result.redundant);
    else screened.push(result.screened);
  }
  return { contract: JEV_SCREENING_CONTRACT, model: JEV_SCREENING_MODEL,
    event_register: { articles: screened }, redundant };
}
