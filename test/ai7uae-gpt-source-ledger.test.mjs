import assert from 'node:assert/strict';
import test from 'node:test';
import { validateGptSourceLedger } from '../lib/ai7uae-gpt-source-ledger.mjs';

test('only trusted event references link separate source observations', () => {
  const sources = [
    { id: 'a', title: 'Company notice', excerpt: 'Cedar Dune Trading LLC received a penalty.', event_ref: 'MODEL-CLAIMED-SAME' },
    { id: 'b', title: 'Broker notice', excerpt: 'Two brokers received a penalty.', event_ref: 'MODEL-CLAIMED-SAME' },
    { id: 'c', title: 'Broker report', excerpt: 'Two brokers received a penalty.', event_ref: 'MODEL-CLAIMED-SAME' }
  ];
  const observations = [
    { source_id: 'a', acted_party: 'Cedar Dune Trading LLC', action_kind: 'formal_action',
      supporting_quote: 'Cedar Dune Trading LLC received a penalty.', headline_disputed: false },
    { source_id: 'b', acted_party: 'Two brokers', action_kind: 'formal_action',
      supporting_quote: 'Two brokers received a penalty.', headline_disputed: false },
    { source_id: 'c', acted_party: 'Two brokers', action_kind: 'formal_action',
      supporting_quote: 'Two brokers received a penalty.', headline_disputed: false }
  ];
  const result = validateGptSourceLedger({ sources, observations, verifiedEventRefs: {
    a: 'COMPANY', b: 'BROKERS', c: 'BROKERS'
  } });
  assert.deepEqual(result.review, []);
  assert.deepEqual(result.linked_events, [{ event_ref: 'BROKERS', source_ids: ['b', 'c'] }]);
});

test('unsupported source quote is withheld', () => {
  const result = validateGptSourceLedger({ sources: [
    { id: 'a', title: 'Company notice', excerpt: 'Cedar Dune Trading LLC received a penalty.' }
  ], observations: [
    { source_id: 'a', acted_party: 'Cedar Dune Trading LLC', action_kind: 'formal_action',
      supporting_quote: 'Cedar Dune Trading LLC was convicted.', headline_disputed: false }
  ] });
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.review, [{ source_id: 'a', reasons: ['unsupported_quote'] }]);
});

test('formal action wording cannot be accepted as ordinary news', () => {
  const result = validateGptSourceLedger({ sources: [
    { id: 'broker', title: 'Broker notice', excerpt: 'Two brokers were fined for trading violations.' }
  ], observations: [
    { source_id: 'broker', acted_party: 'Two brokers', action_kind: 'ordinary_news',
      supporting_quote: 'Two brokers were fined for trading violations.', headline_disputed: false }
  ] });
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.review, [{ source_id: 'broker', reasons: ['formal_action_in_ordinary_quote'] }]);
});

test('an explicit fine against the named party is not an allegation', () => {
  const result = validateGptSourceLedger({ sources: [
    { id: 'broker', title: 'Secondary article',
      excerpt: 'The cited notice fines two brokers for their own trades.' }
  ], observations: [
    { source_id: 'broker', acted_party: 'two brokers', action_kind: 'allegation',
      supporting_quote: 'The cited notice fines two brokers for their own trades.', headline_disputed: true }
  ] });
  assert.deepEqual(result.observations.map((item) => item.action_kind), ['formal_action']);
  assert.deepEqual(result.review, [{ source_id: 'broker', reasons: ['formal_action_normalized'] }]);
});

test('matching namesake headline and excerpt are not a source conflict', () => {
  const result = validateGptSourceLedger({ sources: [
    { id: 'namesake', title: 'Marina Quartz Logistics Ltd convicted abroad',
      excerpt: 'The court convicted Marina Quartz Logistics Ltd, not Marina Quartz Services LLC.' }
  ], observations: [
    { source_id: 'namesake', acted_party: 'Marina Quartz Logistics Ltd', action_kind: 'formal_action',
      supporting_quote: 'The court convicted Marina Quartz Logistics Ltd, not Marina Quartz Services LLC.',
      headline_disputed: true }
  ] });
  assert.equal(result.observations[0].headline_disputed, false);
  assert.deepEqual(result.review, [{ source_id: 'namesake', reasons: ['matching_headline_normalized'] }]);
});
