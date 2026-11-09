import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

export function activeFlowKeyVersion() {
  const version = Number(process.env.FLO_ACTIVE_KEY_VERSION || 1);
  if (!Number.isInteger(version) || version < 1 || version > 255) throw new Error('flo_key_version_invalid');
  return version;
}

export function flowKey(version = activeFlowKeyVersion()) {
  const value = process.env[`FLO_DATA_KEY_V${version}_HEX`] || (version === 1 ? process.env.FLO_DATA_KEY_HEX : '') || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('flo_data_key_unavailable');
  return Buffer.from(value, 'hex');
}

export function encryptBytes(bytes, key) {
  const version = activeFlowKeyVersion();
  key ||= flowKey(version);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([Buffer.from([version]), iv, cipher.getAuthTag(), body]);
}

export function decryptBytes(bytes, key) {
  if (!bytes[0] || bytes.length < 30) throw new Error('flo_envelope_invalid');
  key ||= flowKey(bytes[0]);
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
  decipher.setAuthTag(bytes.subarray(13, 29));
  return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]);
}

export function encryptJson(value, key) { return encryptBytes(Buffer.from(JSON.stringify(value)), key); }
export function decryptJson(bytes, key) { return JSON.parse(decryptBytes(bytes, key).toString('utf8')); }
