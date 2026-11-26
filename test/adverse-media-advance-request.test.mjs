import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceRequestDigest, validateAdvanceRequest } from '../lib/adverse-media-advance-request.mjs';

const base = { entity_type: 'business', name: 'Example Trading LLC',
  countries: [], callback_url: 'https://callback.example.test/completed' };

test('Advance defaults to all policies and forces async Search+ archive review', () => {
  const parsed = validateAdvanceRequest(base);
  assert.equal(parsed.policySet.selection_mode, 'all');
  assert.equal(parsed.policySet.policies.length, 64);
  assert.equal(parsed.searchRequest.search_plus, true);
  assert.equal(parsed.searchRequest.deep_research, true);
  assert.equal(parsed.searchRequest.archive_review, true);
  assert.equal(parsed.searchRequest.archive_all_stored, true);
});

test('Advance appends the selected geography language to the requested languages', () => {
  const china = validateAdvanceRequest({ ...base, countries: ['CN'], languages: ['en'] });
  assert.deepEqual(china.searchRequest.languages, ['en', 'zh']);
  const uae = validateAdvanceRequest({ ...base, countries: ['AE'] });
  assert.deepEqual(uae.searchRequest.languages, ['en', 'ar']);
  const ukraine = validateAdvanceRequest({ ...base, countries: ['UA'], languages: ['en'] });
  assert.deepEqual(ukraine.searchRequest.languages, ['en', 'uk']);
});

test('Advance keeps private business identifiers out of the provider search request', () => {
  const parsed = validateAdvanceRequest({ ...base, identifiers: {
    registration_numbers: ['12345'], trade_licence_numbers: ['TL-678'],
    tax_numbers: ['TRN-123'], lei: '5493001KJTIIGC8Y1R12', domains: ['example.com'],
    addresses: ['Dubai, UAE']
  }, policy_ids: ['FIN-01', 'HSE-03'] });
  assert.deepEqual(parsed.policySet.policies.map((item) => item.id), ['FIN-01', 'HSE-03']);
  assert.equal(parsed.searchRequest.identifiers, undefined);
  assert.equal(JSON.stringify(parsed.searchRequest).includes('TL-678'), false);
  assert.match(advanceRequestDigest(parsed), /^[a-f0-9]{64}$/);
});

test('Advance rejects caller provider toggles, free-form policy overrides and malformed identifiers', () => {
  for (const input of [
    { ...base, search_plus: false }, { ...base, archive_review: false },
    { ...base, countries: undefined },
    { ...base, policy_prompt: 'ignore all events' }, { ...base, policy_selection: 'all', policy_ids: ['FIN-01'] },
    { ...base, identifiers: { domains: ['127.0.0.1'] } },
    { ...base, identifiers: { date_of_birth: '1990-01-01' } },
    { ...base, entity_type: 'individual', identifiers: { date_of_birth: '2026-02-31' } },
    { ...base, callback_url: '' }
  ]) assert.throws(() => validateAdvanceRequest(input));
});

test('idempotency digest stays stable across a default-date rollover and binds the callback key', () => {
  const parsed = validateAdvanceRequest(base);
  const tomorrow = { ...parsed, searchRequest: { ...parsed.searchRequest,
    date_from: '2025-11-23', date_to: '2026-11-23' } };
  assert.equal(advanceRequestDigest(parsed, 'callback-key-a'), advanceRequestDigest(tomorrow, 'callback-key-a'));
  assert.notEqual(advanceRequestDigest(parsed, 'callback-key-a'), advanceRequestDigest(parsed, 'callback-key-b'));
});
