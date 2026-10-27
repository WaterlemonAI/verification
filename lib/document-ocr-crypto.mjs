import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('OCR1');

function key() {
  const value = process.env.DOCUMENT_OCR_DATA_KEY_HEX || '';
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('document_ocr_encryption_unavailable');
  return Buffer.from(value, 'hex');
}

export function encryptDocumentOcr(bytes) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const payload = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), payload]);
}

export function decryptDocumentOcr(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || !bytes.subarray(0, 4).equals(MAGIC)) {
    throw new Error('document_ocr_encryption_required');
  }
  const iv = bytes.subarray(4, 16);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(bytes.subarray(16, 32));
  return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
}
