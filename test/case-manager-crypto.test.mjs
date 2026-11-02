import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptCasePayload, encryptCasePayload } from '../lib/case-manager-crypto.mjs';

const keys = { 1: 'a'.repeat(64), 2: 'b'.repeat(64) };

test('full nested payload survives encryption, secrets are redacted, tenant binding is authenticated', () => {
  const payload = { final_response: { rows: Array.from({ length: 500 }, (_, index) => ({ index, text: '<script>test</script>' })),
    callback_signing_secret: 'one-time', nested: { Authorization: 'Bearer secret', ordinary: 'visible' } } };
  const encrypted = encryptCasePayload(payload, { workspaceId: 'a', caseId: 'case-id', keys, keyVersion: 2 });
  assert.equal(encrypted.includes(Buffer.from('one-time')), false);
  const decoded = decryptCasePayload(encrypted, { workspaceId: 'a', caseId: 'case-id', keys });
  assert.equal(decoded.final_response.rows.length, 500);
  assert.equal(decoded.final_response.rows[0].text, '<script>test</script>');
  assert.equal(decoded.final_response.callback_signing_secret, '[REDACTED]');
  assert.equal(decoded.final_response.nested.Authorization, '[REDACTED]');
  assert.equal(decoded.final_response.nested.ordinary, 'visible');
  assert.throws(() => decryptCasePayload(encrypted, { workspaceId: 'b', caseId: 'case-id', keys }));
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptCasePayload(tampered, { workspaceId: 'a', caseId: 'case-id', keys }));
});

test('key rotation writes a new version while retaining access to older case copies', () => {
  const oldCase = encryptCasePayload({ final_response: { value: 'old' } },
    { workspaceId: 'a', caseId: 'old-case', keys, keyVersion: 1 });
  const newCase = encryptCasePayload({ final_response: { value: 'new' } },
    { workspaceId: 'a', caseId: 'new-case', keys, keyVersion: 2 });
  assert.equal(oldCase[4], 1);
  assert.equal(newCase[4], 2);
  assert.equal(decryptCasePayload(oldCase, { workspaceId: 'a', caseId: 'old-case', keys }).final_response.value, 'old');
  assert.equal(decryptCasePayload(newCase, { workspaceId: 'a', caseId: 'new-case', keys }).final_response.value, 'new');
});
