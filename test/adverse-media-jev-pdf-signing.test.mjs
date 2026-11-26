import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadJevPdfSigningFromKeyVault } from '../lib/adverse-media-jev-pdf-signing.mjs';

test('loads an exportable Key Vault P12 into memory without writing a file', async () => {
  const p12 = Buffer.alloc(120, 7);
  const calls = [];
  const identity = await loadJevPdfSigningFromKeyVault({ secretName: 'document-signer',
    store: { getSecretDocument: async (...args) => {
      calls.push(args);
      return { contentType: 'application/x-pkcs12', value: p12.toString('base64') };
    } } });
  assert.deepEqual(identity.p12Bytes, p12);
  assert.equal(identity.passphrase, '');
  assert.deepEqual(calls, [['document-signer', { fresh: true }]]);
});

test('rejects missing, wrong-format, and malformed Key Vault signing secrets', async () => {
  const get = (document) => loadJevPdfSigningFromKeyVault({ secretName: 'document-signer',
    store: { getSecretDocument: async () => document } });
  await assert.rejects(get(null), { message: 'pdf_signing_key_vault_secret_missing' });
  await assert.rejects(get({ value: 'abc', contentType: 'application/x-pem-file' }),
    { message: 'pdf_signing_key_vault_p12_required' });
  await assert.rejects(get({ value: '%%%', contentType: 'application/x-pkcs12' }),
    { message: 'pdf_signing_key_vault_p12_invalid' });
});
