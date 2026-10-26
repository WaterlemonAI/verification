import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const INVITATION_HOURS = 48;

export function createInvitation(customerId, now = Date.now()) {
  const secret = randomBytes(32).toString('base64url');
  const token = `ai7_inv_${customerId}_${secret}`;
  return {
    token,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(now + INVITATION_HOURS * 60 * 60 * 1000).toISOString()
  };
}

export function invitationCustomerId(token) {
  return /^ai7_inv_([a-f0-9]{16})_[A-Za-z0-9_-]{40,}$/.exec(String(token || ''))?.[1] || '';
}

export function validInvitation(customer, token, now = Date.now()) {
  if (!customer || customer.status !== 'pending' || !customer.invitationHash || !invitationCustomerId(token) ||
      invitationCustomerId(token) !== customer.id || !Number.isFinite(Date.parse(customer.invitationExpiresAt)) || Date.parse(customer.invitationExpiresAt) <= now) return false;
  const given = Buffer.from(createHash('sha256').update(token).digest('hex'));
  const expected = Buffer.from(customer.invitationHash);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function publicCustomer(customer) {
  const { invitationHash, ...safe } = customer;
  return safe;
}
