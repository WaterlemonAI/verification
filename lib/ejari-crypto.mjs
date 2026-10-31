import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('EJA1');

function key() {
  const value = process.env.EJARI_DATA_ROOT_KEY_HEX || '';
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('ejari_encryption_unavailable');
  return Buffer.from(hkdfSync('sha256', Buffer.from(value, 'hex'), Buffer.alloc(0), 'KYCProbe-Ejari-v1', 32));
}

export function encryptEjari(bytes) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptEjari(bytes) {
  if (bytes.length < 32 || !bytes.subarray(0, 4).equals(MAGIC)) throw new Error('ejari_encryption_required');
  const cipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(4, 16));
  cipher.setAuthTag(bytes.subarray(16, 32));
  return Buffer.concat([cipher.update(bytes.subarray(32)), cipher.final()]);
}
