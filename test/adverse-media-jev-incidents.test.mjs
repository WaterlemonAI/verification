import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { JEV_SCREENING_MODEL } from '../lib/adverse-media-jev-screening.mjs';

process.env.NODE_ENV = 'test';
process.env.ADVERSE_MEDIA_JEV_API_ENABLED = 'true';
process.env.ADVERSE_MEDIA_JEV_SCREENING_TOKEN = 'incident-grouping-test-token-with-32-chars';
const { createAppServer } = await import('../server.mjs');

const store = new EnvironmentStore();
let queue = [];
const calls = [];
const fetchImpl = async (url, options) => {
  calls.push({ url, request: JSON.parse(options.body) });
  const next = queue.shift();
  if (!next) throw new Error('unexpected_jev_call');
  if (next instanceof Error) throw next;
  return { ok: true, json: async () => next };
};
let server;
let base;
before(async () => {
  await store.setMasterKey('adverse-media-jev', 'fake-jev-key');
  server = createAppServer({ store, fetchImpl, startWorker: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise((resolve) => server.close(resolve)));

const articles = [
  { story_key: 'a', title: 'Example Trading fraud case', excerpt: 'The first report of a specific fraud case.' },
  { story_key: 'b', title: 'Charges in Example Trading fraud case', excerpt: 'Charges in the same fraud case.' },
  { story_key: 'c', title: 'Example Trading land dispute', excerpt: 'A different land dispute.' },
  { story_key: 'd', title: 'Example Trading second fraud case', excerpt: 'A separate fraud from another year.' }
];
const input = { subject: { name: 'Example Trading LLC', entity_type: 'business' }, articles };
const eligibility = (p) => ({ model: JEV_SCREENING_MODEL,
  answers: { specific_incident: { type: 'noul', noul: p } } });
const pair = (choice, p = 0.98) => ({ model: JEV_SCREENING_MODEL,
  answers: { same_incident: { type: 'choice', choice, probabilities: {
    same: choice === 'same' ? p : (1 - p) / 2,
    different: choice === 'different' ? p : (1 - p) / 2,
    inconclusive: choice === 'inconclusive' ? p : (1 - p) / 2
  } } } });
const post = (body, token = process.env.ADVERSE_MEDIA_JEV_SCREENING_TOKEN) =>
  fetch(`${base}/internal/adverse-media-jev/group-events`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

test('groups follow-up articles while keeping distinct fraud and land cases separate', async () => {
  queue = [eligibility(.99), eligibility(.99), eligibility(.99), eligibility(.99),
    pair('same'), pair('different'), pair('different'), pair('different'), pair('different'), pair('different')];
  const beforeCalls = calls.length;
  const response = await post(input);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.incidents.map((item) => [item.incident_label, item.story_keys]), [
    ['Incident 1', ['a', 'b']], ['Incident 2', ['c']], ['Incident 3', ['d']]
  ]);
  assert.deepEqual(result.assignments.map((item) => item.group_status),
    ['grouped', 'grouped', 'single_article', 'single_article']);
  assert.deepEqual(result.event_register.articles.map((item) => item.incident_label),
    ['Incident 1', 'Incident 1', 'Incident 2', 'Incident 3']);
  assert.equal(result.pair_reviews.length, 6);
  assert.equal(calls.length - beforeCalls, 10);
  assert.equal(calls[beforeCalls].request.questions.specific_incident.type, 'noul');
  assert.deepEqual(Object.keys(calls[beforeCalls + 4].request.questions.same_incident.criteria),
    ['same', 'different', 'inconclusive']);
});

test('conflicting pair judgments do not chain three incidents into one', async () => {
  queue = [eligibility(.99), eligibility(.99), eligibility(.99),
    pair('same', .99), pair('different', .99), pair('same', .90)];
  const response = await post({ ...input, articles: articles.slice(0, 3) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.incidents.map((item) => item.story_keys), [['a', 'b'], ['c']]);
  assert.deepEqual(result.unmerged_same_pairs, [{ first_story_key: 'b', second_story_key: 'c' }]);
});

test('incident identifiers do not depend on input article order', async () => {
  queue = [eligibility(.99), eligibility(.99), pair('same')];
  const first = await (await post({ ...input, articles: [articles[0], articles[1]] })).json();
  queue = [eligibility(.99), eligibility(.99), pair('same')];
  const second = await (await post({ ...input, articles: [articles[1], articles[0]] })).json();
  assert.equal(first.incidents[0].incident_id, second.incidents[0].incident_id);
  assert.deepEqual(first.incidents[0].story_keys, second.incidents[0].story_keys);
  assert.deepEqual(second.event_register.articles.map((item) => item.story_key), ['b', 'a']);
});

test('large subject registers use representative comparisons across all articles', async () => {
  const many = Array.from({ length: 21 }, (_, index) => ({
    story_key: `story-${String(index).padStart(2, '0')}`,
    title: `Report ${index} on Example Trading invoice fraud`,
    excerpt: 'The same specific invoice fraud investigation is described.'
  }));
  queue = [...many.map(() => eligibility(.99)),
    ...Array.from({ length: 1 + 2 * (many.length - 2) }, () => pair('same'))];
  const response = await post({ ...input, articles: many });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.grouping_method, 'representative_pairs');
  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].story_keys.length, 21);
  assert.equal(result.pair_reviews.length, 39);
});

test('an ambiguous article is not given a new incident marker', async () => {
  const many = Array.from({ length: 21 }, (_, index) => ({
    story_key: `case-${String(index).padStart(2, '0')}`,
    title: `Report ${index} on one fraud case`,
    excerpt: 'A specific fraud case is described.'
  }));
  queue = [...many.map(() => eligibility(.99)),
    ...Array.from({ length: 37 }, () => pair('same')),
    pair('inconclusive', .80), pair('inconclusive', .80)];
  const response = await post({ ...input, articles: many });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].story_keys.length, 20);
  assert.equal(result.event_register.articles[20].incident_id, null);
  assert.equal(result.event_register.articles[20].reason, 'incident_match_inconclusive');
});

test('generic or evidence-poor articles receive no incident marker', async () => {
  queue = [eligibility(.03)];
  const response = await post({ ...input, articles: [articles[0],
    { story_key: 'z', title: 'Example Trading overview' },
    { ...articles[1], tag: 'redundant' }] });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.incidents, []);
  assert.deepEqual(result.unassigned, [
    { story_key: 'a', reason: 'no_specific_incident' },
    { story_key: 'b', reason: 'redundant' },
    { story_key: 'z', reason: 'insufficient_article_evidence' }
  ]);
  assert.deepEqual(result.event_register.articles.map((item) => item.group_status),
    ['unassigned', 'unassigned', 'unassigned']);
});

test('a transient incident call is retried once', async () => {
  queue = [new Error('temporary connection reset'), eligibility(.99)];
  const beforeCalls = calls.length;
  const response = await post({ ...input, articles: [articles[0]] });
  assert.equal(response.status, 200);
  assert.equal(calls.length - beforeCalls, 2);
});

test('invalid Jev pair response fails without a partial incident map', async () => {
  const invalid = pair('same');
  invalid.answers.same_incident.choice = 'same_topic';
  queue = [eligibility(.99), eligibility(.99), invalid];
  const response = await post({ ...input, articles: articles.slice(0, 2) });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'invalid_jev_incident_answer' });
});

test('internal token and duplicate story keys are checked before calling Jev', async () => {
  const beforeCalls = calls.length;
  assert.equal((await post(input, 'wrong')).status, 401);
  assert.equal((await post({ ...input, articles: [articles[0], articles[0]] })).status, 400);
  assert.equal(calls.length, beforeCalls);
});
