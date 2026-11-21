import test from 'node:test';
import assert from 'node:assert/strict';
import { compareV2Parity, countV1, countV2 } from '../scripts/gdelt-v2-parity.mjs';
import { summaryKey } from '../lib/gdelt-summary-v2.mjs';

const sourceState = { coverage_start: '2026-11-20T01:00:00.000Z',
  coverage_end: '2026-11-20T01:15:00.000Z' };
const v2State = { index_version: 2, coverage_start: '20261120010000',
  coverage_end: '20261120011500', committed_intervals: 2 };
const options = { sourceState, v2State, minimumSubjects: 2,
  clock: () => Date.parse('2026-11-20T02:00:00.000Z'),
  countV1Impl: async (subject) => ({ count: subject.name === 'Entity One' ? 1 : 0, pages: 1 }),
  countV2Impl: async (subject) => subject.name === 'Entity One' ? 1 : 0 };

test('parity gate requires a fresh contiguous V2 snapshot and distinct controlled subjects', async () => {
  const subjects = ['Entity One', 'Entity Two'];
  const result = await compareV2Parity(subjects, options);
  assert.equal(result.checked, 2);
  assert.equal(result.mismatches, 0);
  assert.equal(result.results[0].v1_count, 1);
  assert.equal(result.results[0].v2_count, 1);
  assert.equal(JSON.stringify(result).includes('Entity One'), false);
  await assert.rejects(() => compareV2Parity(subjects, { ...options,
    v2State: { ...v2State, committed_intervals: 1 } }), /snapshot_does_not_cover/);
  await assert.rejects(() => compareV2Parity(['Entity One', 'entity one'], options), /duplicate_parity_subject/);
  await assert.rejects(() => compareV2Parity(subjects, { ...options,
    clock: () => Date.parse('2026-11-22T02:00:00.000Z') }), /snapshot_does_not_cover/);
});

test('parity gate reports a count mismatch and never marks it as a pass', async () => {
  const result = await compareV2Parity(['Entity One', 'Entity Two'], { ...options,
    countV2Impl: async () => 0 });
  assert.equal(result.mismatches, 1);
  assert.equal(result.results[0].match, false);
  assert.equal(result.results[1].match, true);
});

test('parity counts every V1 page and both V2 entity kinds', async () => {
  let call = 0;
  const v1Table = { listEntities: () => ({ byPage: () => ({ next: async () => {
    call += 1;
    return call === 1 ? { done: false, value: [{ recordId: 'one' }, { recordId: 'two' }] }
      : { done: true, value: [] };
  } }) }) };
  const v1 = await countV1({ name: 'Entity One', entity_type: 'business' }, sourceState, v1Table);
  assert.equal(v1.count, 2);
  const organization = summaryKey('organization', 'Entity One');
  const alias = summaryKey('organization', 'Alternate One');
  const v2Table = { getEntity: async (partitionKey, rowKey) => {
    if (!([organization.partitionKey, alias.partitionKey].includes(partitionKey) && rowKey === 'summary')) {
      throw Object.assign(new Error('missing'), { statusCode: 404 });
    }
    return { indexVersion: 2, mentionCount: partitionKey === organization.partitionKey ? 2 : 1,
      firstInterval: v2State.coverage_start,
      lastInterval: v2State.coverage_end };
  } };
  assert.equal(await countV2({ name: 'Entity One' }, v2State, v2Table), 2);
  assert.equal(await countV2({ name: 'Entity One', aliases: ['Alternate One'] }, v2State, v2Table), 3);
});
