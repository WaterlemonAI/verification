import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { encryptDocumentOcr, decryptDocumentOcr } from '../lib/document-ocr-crypto.mjs';

test('OCR artifacts are encrypted and tampering fails closed', () => {
  process.env.DOCUMENT_OCR_DATA_KEY_HEX = randomBytes(32).toString('hex');
  const privateDocument = Buffer.from('synthetic identity document');
  const encrypted = encryptDocumentOcr(privateDocument);
  assert.equal(encrypted.includes(privateDocument), false);
  assert.deepEqual(decryptDocumentOcr(encrypted), privateDocument);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decryptDocumentOcr(encrypted));
  delete process.env.DOCUMENT_OCR_DATA_KEY_HEX;
});
