import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AzureLoginOtpStore, LOGIN_OTP_SECONDS, MemoryLoginOtpStore, loginOtpHash, newLoginOtp } from '../lib/login-otp.mjs';

const identity = { kind: 'portal', email: 'person@example.test', version: 2, signingKey: 'test-signing-key' };
const make = (code = '01234567', challengeId = 'a'.repeat(32)) => ({ ...identity, code, challengeId,
  codeHash: loginOtpHash({ ...identity, code, challengeId }) });

test('email codes expire, lock after five mistakes, and cannot be replayed or reused after replacement', async () => {
  const store = new MemoryLoginOtpStore();
  const first = make();
  assert.deepEqual(await store.issue({ ...first, now: 1000 }), { issued: true });
  assert.equal((await store.issue({ ...make('12345678', 'b'.repeat(32)), now: 2000 })).issued, false);
  assert.equal(await store.consume({ ...first, codeHash: make('99999999').codeHash, now: 3000 }), false);
  assert.equal(await store.consume({ ...first, now: 4000 }), true);
  assert.equal(await store.consume({ ...first, now: 5000 }), false);
  const second = make('12345678', 'b'.repeat(32));
  assert.deepEqual(await store.issue({ ...second, now: 6000 }), { issued: true });
  assert.equal(await store.consume({ ...first, now: 7000 }), false);
  assert.equal(await store.consume({ ...second, version: 3, now: 7000 }), false);
  assert.equal(await store.consume({ ...second, now: 6000 + LOGIN_OTP_SECONDS * 1000 }), false);
  const third = make('87654321', 'c'.repeat(32));
  assert.deepEqual(await store.issue({ ...third, now: 67_000 }), { issued: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(await store.consume({ ...third, codeHash: first.codeHash, now: 68_000 + attempt }), false);
  }
  assert.equal(await store.consume({ ...third, now: 69_000 }), false);
  assert.deepEqual(await store.issue({ ...make('11112222', 'd'.repeat(32)), version: 3, now: 70_000 }), { issued: true });
  assert.match(newLoginOtp().code, /^\d{8}$/);
});

class FakeTable {
  constructor() { this.rows = new Map(); this.version = 0; }
  key(partitionKey, rowKey) { return `${partitionKey}:${rowKey}`; }
  async getEntity(partitionKey, rowKey) {
    const row = this.rows.get(this.key(partitionKey, rowKey));
    if (!row) throw Object.assign(new Error('missing'), { statusCode: 404 });
    return { ...row };
  }
  async createEntity(row) {
    const key = this.key(row.partitionKey, row.rowKey);
    if (this.rows.has(key)) throw Object.assign(new Error('conflict'), { statusCode: 409 });
    this.rows.set(key, { ...row, etag: String(++this.version) });
  }
  async updateEntity(row, mode, { etag }) {
    const key = this.key(row.partitionKey, row.rowKey);
    const previous = this.rows.get(key);
    if (!previous || previous.etag !== etag) throw Object.assign(new Error('conflict'), { statusCode: 412 });
    this.rows.set(key, { ...(mode === 'Replace' ? {} : previous), ...row, etag: String(++this.version) });
  }
}

test('Azure challenge consumption uses an ETag so concurrent verification issues one session', async () => {
  const store = new AzureLoginOtpStore({ table: new FakeTable() });
  const challenge = make();
  assert.deepEqual(await store.issue({ ...challenge, now: 1000 }), { issued: true });
  const results = await Promise.all(Array.from({ length: 8 }, () => store.consume({ ...challenge, now: 2000 })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await store.consume({ ...challenge, now: 3000 }), false);
});
