import assert from 'node:assert/strict';
import test from 'node:test';
import { adjudicateGptPartyFacts } from '../lib/ai7uae-gpt-party-facts.mjs';

const subject = { name: 'Cedar Dune Trading LLC' };
const evidence = [
  { id: 'company', title: 'Company fine', excerpt: 'Cedar Dune Trading LLC was fined for recordkeeping failures.' },
  { id: 'director', title: 'Director fine', excerpt: 'Mira Vale, a director, received a personal penalty; the company was not fined.' },
  { id: 'routine', title: 'Workforce news', excerpt: 'Cedar Dune Trading LLC announced routine layoffs.' }
];

test('party facts produce subject-specific legal stages', () => {
  const result = adjudicateGptPartyFacts({ subject, evidence, facts: [
    { result_id: 'company', party_relation: 'screened_subject', event_kind: 'legal_action',
      acted_party: 'Cedar Dune Trading LLC', reported_stage: 'regulatory_action',
      supporting_quote: 'Cedar Dune Trading LLC was fined for recordkeeping failures.' },
    { result_id: 'director', party_relation: 'related_party', event_kind: 'legal_action',
      acted_party: 'Mira Vale', reported_stage: 'regulatory_action',
      supporting_quote: 'Mira Vale, a director, received a personal penalty' },
    { result_id: 'routine', party_relation: 'screened_subject', event_kind: 'ordinary_event',
      acted_party: 'Cedar Dune Trading LLC', reported_stage: 'media_mention',
      supporting_quote: 'Cedar Dune Trading LLC announced routine layoffs.' }
  ] });
  assert.deepEqual(result.review, []);
  assert.deepEqual(result.results.map(({ media_bucket, subject_role, legal_stage }) =>
    [media_bucket, subject_role, legal_stage]), [
    ['adverse_media', 'direct_actor', 'regulatory_action'],
    ['general_news_mentions', 'related_party', 'media_mention'],
    ['general_news_mentions', 'context_only', 'media_mention']
  ]);
});

test('an omitted fact does not discard a separately supported source', () => {
  const result = adjudicateGptPartyFacts({ subject, evidence: evidence.slice(0, 2), facts: [
    { result_id: 'company', party_relation: 'screened_subject', event_kind: 'legal_action',
      acted_party: 'Cedar Dune Trading LLC', reported_stage: 'regulatory_action',
      supporting_quote: 'Cedar Dune Trading LLC was fined for recordkeeping failures.' }
  ] });
  assert.deepEqual(result.results.map((item) => item.result_id), ['company']);
  assert.deepEqual(result.review, [{ result_id: 'director', reasons: ['missing_party_fact'] }]);
});

test('unsupported quotes are withheld instead of becoming a decision', () => {
  const result = adjudicateGptPartyFacts({ subject, evidence: evidence.slice(0, 1), facts: [
    { result_id: 'company', party_relation: 'screened_subject', event_kind: 'legal_action',
      acted_party: 'Cedar Dune Trading LLC', reported_stage: 'convicted',
      supporting_quote: 'Cedar Dune Trading LLC was convicted of fraud.' }
  ] });
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.review, [{ result_id: 'company', reasons: ['unsupported_quote'] }]);
});

test('a real quote cannot support a different legal stage', () => {
  const result = adjudicateGptPartyFacts({ subject, evidence: evidence.slice(0, 1), facts: [
    { result_id: 'company', party_relation: 'screened_subject', event_kind: 'legal_action',
      acted_party: 'Cedar Dune Trading LLC', reported_stage: 'convicted',
      supporting_quote: 'Cedar Dune Trading LLC was fined for recordkeeping failures.' }
  ] });
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.review, [{ result_id: 'company', reasons: ['stage_not_in_quote'] }]);
});

test('same-name namesake and ordinary-news pronoun remain eligible', () => {
  const result = adjudicateGptPartyFacts({ subject: { name: 'Lena Shore' }, evidence: [
    { id: 'namesake', title: 'Lena Shore convicted',
      excerpt: 'The convicted Lena Shore is a different person with a different birth year.' },
    { id: 'appointment', title: 'Lena Shore appointed', excerpt: 'She joined the board.' }
  ], facts: [
    { result_id: 'namesake', party_relation: 'different_entity', acted_party: 'Lena Shore',
      event_kind: 'legal_action', reported_stage: 'convicted',
      supporting_quote: 'The convicted Lena Shore is a different person with a different birth year.' },
    { result_id: 'appointment', party_relation: 'screened_subject', acted_party: 'Lena Shore',
      event_kind: 'ordinary_event', reported_stage: 'media_mention',
      supporting_quote: 'She joined the board.' }
  ] });
  assert.deepEqual(result.review, []);
  assert.deepEqual(result.results.map((item) => [item.media_bucket, item.subject_role, item.legal_stage]), [
    ['no_impact_media', 'namesake', 'media_mention'],
    ['general_news_mentions', 'context_only', 'media_mention']
  ]);
});

test('personal allegation stays visible when employer separately settles', () => {
  const result = adjudicateGptPartyFacts({ subject: { name: 'Lena Shore' }, evidence: [
    { id: 'mixed', title: 'Bank settles case', excerpt: 'A complaint alleges Lena Shore personally made misleading statements. Fictional Blue Harbor Bank settled the case about those statements.' }
  ], facts: [
    { result_id: 'mixed', party_relation: 'screened_subject', acted_party: 'Lena Shore',
      event_kind: 'adverse_allegation', reported_stage: 'allegation',
      supporting_quote: 'A complaint alleges Lena Shore personally made misleading statements.' },
    { result_id: 'mixed', party_relation: 'related_party', acted_party: 'Fictional Blue Harbor Bank',
      event_kind: 'legal_action', reported_stage: 'settled',
      supporting_quote: 'Fictional Blue Harbor Bank settled the case about those statements.' }
  ] });
  assert.deepEqual(result.review, []);
  assert.deepEqual(result.results.map((item) => [item.media_bucket, item.subject_role, item.legal_stage]), [
    ['adverse_media', 'direct_actor', 'allegation']
  ]);
});

test('broker trading in subject securities remains related context', () => {
  const result = adjudicateGptPartyFacts({ subject, evidence: [
    { id: 'brokers', title: 'Brokers fined',
      excerpt: 'The regulator fined two brokers for trading in Cedar Dune Trading LLC shares.' }
  ], facts: [
    { result_id: 'brokers', party_relation: 'different_entity', acted_party: 'two brokers',
      event_kind: 'legal_action', reported_stage: 'regulatory_action',
      supporting_quote: 'The regulator fined two brokers for trading in Cedar Dune Trading LLC shares.' }
  ] });
  assert.deepEqual(result.results.map((item) => [item.media_bucket, item.subject_role, item.legal_stage]), [
    ['general_news_mentions', 'related_party', 'media_mention']
  ]);
  assert.deepEqual(result.review, [{ result_id: 'brokers', reasons: ['broker_share_relation_normalized'] }]);
});

test('a related-party fact cannot hide an explicit subject allegation', () => {
  const result = adjudicateGptPartyFacts({ subject: { name: 'Lena Shore' }, evidence: [
    { id: 'mixed', title: 'Bank settles case',
      excerpt: 'A complaint alleges Lena Shore made misleading statements. Fictional Blue Harbor Bank settled the case.' }
  ], facts: [
    { result_id: 'mixed', party_relation: 'related_party', acted_party: 'Fictional Blue Harbor Bank',
      event_kind: 'legal_action', reported_stage: 'settled',
      supporting_quote: 'Fictional Blue Harbor Bank settled the case.' }
  ] });
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.review, [{ result_id: 'mixed', reasons: ['subject_allegation_not_extracted'] }]);
});

test('a negated accusation and an anonymous claim do not trigger sourced-allegation review', () => {
  const result = adjudicateGptPartyFacts({ subject: { name: 'Blue Gulf Devices LLC' }, evidence: [
    { id: 'brokers', title: 'Brokers fined', publisher: 'Fictional Regulator',
      excerpt: 'Two brokers were fined. The notice does not accuse Blue Gulf Devices LLC.' },
    { id: 'forum', title: 'Anonymous allegation about Blue Gulf Devices LLC', publisher: 'Anonymous Forum',
      excerpt: 'An anonymous user calls Blue Gulf Devices LLC a scam without evidence.' }
  ], facts: [
    { result_id: 'brokers', party_relation: 'related_party', acted_party: 'Two brokers',
      event_kind: 'legal_action', reported_stage: 'regulatory_action',
      supporting_quote: 'Two brokers were fined.' },
    { result_id: 'forum', party_relation: 'screened_subject', acted_party: 'Blue Gulf Devices LLC',
      event_kind: 'unsupported_claim', reported_stage: 'media_mention',
      supporting_quote: 'An anonymous user calls Blue Gulf Devices LLC a scam without evidence.' }
  ] });
  assert.deepEqual(result.review, []);
  assert.deepEqual(result.results.map((item) => [item.media_bucket, item.subject_role]), [
    ['general_news_mentions', 'related_party'], ['general_news_mentions', 'unclear']
  ]);
});

test('ordinary news about the subject can correct an accidental related-party label', () => {
  const result = adjudicateGptPartyFacts({ subject: { name: 'Lena Shore' }, evidence: [
    { id: 'appointment', title: 'Appointment', excerpt: 'Fictional Blue Harbor Bank appointed Lena Shore to its board.' }
  ], facts: [
    { result_id: 'appointment', party_relation: 'related_party', acted_party: 'Lena Shore',
      event_kind: 'ordinary_event', reported_stage: 'media_mention',
      supporting_quote: 'Fictional Blue Harbor Bank appointed Lena Shore to its board.' }
  ] });
  assert.deepEqual(result.results.map((item) => [item.media_bucket, item.subject_role]), [
    ['general_news_mentions', 'context_only']
  ]);
  assert.deepEqual(result.review, [{ result_id: 'appointment', reasons: ['ordinary_self_relation_normalized'] }]);
});

test('a source-backed victim keeps a neutral subject legal stage', () => {
  const result = adjudicateGptPartyFacts({ subject: { name: 'Cobalt Palm Holdings LLC' }, evidence: [
    { id: 'victim', title: 'Supplier diversion',
      excerpt: 'A supplier diverted payments from Cobalt Palm Holdings LLC. The company was the victim.' }
  ], facts: [
    { result_id: 'victim', party_relation: 'victim', acted_party: 'Cobalt Palm Holdings LLC',
      event_kind: 'legal_action', reported_stage: 'allegation',
      supporting_quote: 'A supplier diverted payments from Cobalt Palm Holdings LLC.' }
  ] });
  assert.deepEqual(result.results.map((item) => [item.media_bucket, item.subject_role, item.legal_stage]), [
    ['no_impact_media', 'victim', 'media_mention']
  ]);
  assert.deepEqual(result.review, [{ result_id: 'victim', reasons: ['victim_stage_neutralized'] }]);
});

test('Arabic fine quote supports a subject-specific regulatory stage', () => {
  const arabicSubject = 'شركة واحة اللؤلؤ للتجارة';
  const quote = 'فرضت الهيئة التجارية الخيالية غرامة على شركة واحة اللؤلؤ للتجارة بسبب مخالفات في حفظ السجلات.';
  const result = adjudicateGptPartyFacts({ subject: { name: arabicSubject }, evidence: [
    { id: 'arabic', title: 'غرامة على الشركة', excerpt: quote }
  ], facts: [
    { result_id: 'arabic', party_relation: 'screened_subject', acted_party: arabicSubject,
      event_kind: 'legal_action', reported_stage: 'regulatory_action', supporting_quote: quote }
  ] });
  assert.deepEqual(result.review, []);
  assert.deepEqual(result.results.map((item) => [item.media_bucket, item.subject_role, item.legal_stage]), [
    ['adverse_media', 'direct_actor', 'regulatory_action']
  ]);
});

test('uncertain namesake source stage does not become subject stage', () => {
  const result = adjudicateGptPartyFacts({ subject: { name: 'شركة واحة اللؤلؤ للتجارة' }, evidence: [
    { id: 'namesake', title: 'قضية شركة أخرى',
      excerpt: 'وجهت المحكمة اتهاما إلى شركة واحة اللؤلؤ للخدمات، وهي شركة أخرى برقم تسجيل مختلف.' }
  ], facts: [
    { result_id: 'namesake', party_relation: 'different_entity', acted_party: 'شركة واحة اللؤلؤ للخدمات',
      event_kind: 'legal_action', reported_stage: 'allegation',
      supporting_quote: 'وجهت المحكمة اتهاما إلى شركة واحة اللؤلؤ للخدمات، وهي شركة أخرى برقم تسجيل مختلف.' }
  ] });
  assert.deepEqual(result.results.map((item) => [item.media_bucket, item.subject_role, item.legal_stage]), [
    ['no_impact_media', 'namesake', 'media_mention']
  ]);
  assert.deepEqual(result.review, [{ result_id: 'namesake', reasons: ['other_party_stage_unverified'] }]);
});
