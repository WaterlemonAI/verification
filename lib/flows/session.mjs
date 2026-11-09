import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256 } from './crypto.mjs';

export const FLO_COOKIE = '__Host-flo_session';
export const newSecret = () => randomBytes(32).toString('base64url');
export function hashSecret(value) {
  const key = process.env.FLO_SESSION_HASH_KEY_HEX;
  if (!/^[a-f0-9]{64}$/i.test(key || '')) {
    if (process.env.FLO_ENABLED === 'true') throw new Error('flo_session_key_unavailable');
    return sha256(String(value || ''));
  }
  return createHmac('sha256', Buffer.from(key, 'hex')).update(String(value || '')).digest('hex');
}

export function sameHash(a, b) {
  if (!/^[a-f0-9]{64}$/.test(a || '') || !/^[a-f0-9]{64}$/.test(b || '')) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function floSessionCookie(token) {
  return `${FLO_COOKIE}=${token}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax`;
}

export function clearFloSessionCookie() {
  return `${FLO_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

export function cookieValue(req) {
  const raw = String(req.headers.cookie || '');
  const match = raw.match(/(?:^|;\s*)__Host-flo_session=([^;]+)/);
  return match?.[1] || '';
}
