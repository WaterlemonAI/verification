import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { JEV_SCREENING_MODEL, jevArticleRequest, validateJevEventRegister } from '../lib/adverse-media-jev-screening.mjs';

process.env.NODE_ENV = 'test';
process.env.ADVERSE_MEDIA_JEV_API_ENABLED = 'true';
process.env.ADVERSE_MEDIA_JEV_SCREENING_TOKEN = 'jev-screening-test-token-with-32-characters';
const { createAppServer } = await import('../server.mjs');

const store = new EnvironmentStore();
const calls = [];
let answers = [];
const fetchImpl = async (url, options) => {
  calls.push({ url, options });
  const next = answers.shift();
  if (next instanceof Error) throw next;
  return { ok: true, json: async () => next };
};
let app;
let base;
before(async () => {
  await store.setMasterKey('adverse-media-jev', 'fake-jev-key');
  app = createAppServer({ store, fetchImpl, startWorker: false });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => new Promise((resolve) => app.close(resolve)));

const input = {
  subject: { name: 'Example Trading LLC', entity_type: 'business', aliases: ['Example Trading'] },
  articles: [
    { story_key: 'a-1', title: 'Example Trading investigation', excerpt: 'Authorities opened an investigation into Example Trading LLC.' },
    { story_key: 'a-2', title: 'Different company investigation', excerpt: 'Another company, with an unrelated name, was investigated.' },
    { story_key: 'a-3', title: 'Example Trading annual meeting' }
  ]
};
const answer = (association, adverseness, relationship) => ({
  model: JEV_SCREENING_MODEL,
  answers: {
    subject_association: { type: 'noul', noul: association },
    adverseness: { type: 'choice', choice: adverseness, probabilities: {
      adverse: adverseness === 'adverse' ? 1 : 0,
      'non-adverse': adverseness === 'non-adverse' ? 1 : 0,
      inconclusive: adverseness === 'inconclusive' ? 1 : 0
    } },
    relationship: { type: 'choice', choice: relationship, probabilities: {
      direct: relationship === 'direct' ? 1 : 0,
      indirect: relationship === 'indirect' ? 1 : 0,
      inconclusive: relationship === 'inconclusive' ? 1 : 0
    } }
  }
});
const post = (body, token = process.env.ADVERSE_MEDIA_JEV_SCREENING_TOKEN) => fetch(`${base}/internal/adverse-media-jev/screen`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

test('screening accepts 40 articles and rejects 41', () => {
  const articles = Array.from({ length: 41 }, (_, index) => ({
    story_key: `article-${index}`, title: `Article ${index}` }));
  assert.equal(validateJevEventRegister({ ...input, articles: articles.slice(0, 40) }).articles.length, 40);
  assert.throws(() => validateJevEventRegister({ ...input, articles }),
    { message: 'invalid_event_register' });
});

test('screens each article, removes unrelated articles and retains no-text articles as inconclusive', async () => {
  answers = [answer(0.99, 'adverse', 'direct'), answer(0.04, 'non-adverse', 'indirect')];
  const response = await post(input);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.event_register.articles, [
    { story_key: 'a-1', adverseness: 'adverse', relationship: 'direct' },
    { story_key: 'a-3', adverseness: 'inconclusive', relationship: 'inconclusive' }
  ]);
  assert.deepEqual(result.redundant, [{ story_key: 'a-2', tag: 'redundant' }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].options.headers.authorization, 'Bearer fake-jev-key');
  const request = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(request.questions).sort(), ['adverseness', 'relationship', 'subject_association']);
  assert.deepEqual(Object.keys(request.questions.adverseness.criteria).sort(), ['adverse', 'inconclusive', 'non-adverse']);
  assert.deepEqual(Object.keys(request.questions.relationship.criteria).sort(), ['direct', 'inconclusive', 'indirect']);
});

test('ambiguous association stays in the register with inconclusive relationship', async () => {
  answers = [answer(0.5, 'non-adverse', 'direct')];
  const response = await post({ ...input, articles: [input.articles[0]] });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).event_register.articles,
    [{ story_key: 'a-1', adverseness: 'non-adverse', relationship: 'inconclusive' }]);
});

test('invalid Jev labels fail closed, with no screened result', async () => {
  const invalid = answer(0.9, 'adverse', 'direct');
  invalid.answers.relationship.choice = 'no_association';
  answers = [invalid];
  const response = await post({ ...input, articles: [input.articles[0]] });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'invalid_jev_answer' });
});

test('a later provider failure returns no partial screened register', async () => {
  answers = [answer(0.9, 'adverse', 'direct'), new Error('network failed')];
  const response = await post({ ...input, articles: input.articles.slice(0, 2) });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'jev_provider_unavailable' });
});

test('authentication and register validation happen before any Jev call', async () => {
  const beforeCalls = calls.length;
  assert.equal((await post(input, 'wrong')).status, 401);
  assert.equal((await post({ ...input, articles: [input.articles[0], input.articles[0]] })).status, 400);
  assert.equal(calls.length, beforeCalls);
});

test('question contract includes the subject and one article only', () => {
  const request = jevArticleRequest(input.subject, input.articles[0]);
  assert.equal(request.model, JEV_SCREENING_MODEL);
  assert.equal(request.state.article.story_key, 'a-1');
  assert.equal(request.state.subject.name, 'Example Trading LLC');
});
