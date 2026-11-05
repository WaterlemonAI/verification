import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TEAM_INVITATION_HOURS = 48;

export function emailDomain(email) {
  return String(email || '').trim().toLowerCase().split('@')[1] || '';
}

export function createTeamInvitation(workspaceId, email, invitedBy, now = Date.now()) {
  const id = randomBytes(8).toString('hex');
  const token = `ai7_team_${id}_${randomBytes(32).toString('base64url')}`;
  return {
    record: { id, workspaceId, email, invitedBy, status: 'pending', tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(now + TEAM_INVITATION_HOURS * 60 * 60 * 1000).toISOString(), createdAt: new Date(now).toISOString() },
    token
  };
}

export function teamInvitationId(token) {
  return /^ai7_team_([a-f0-9]{16})_[A-Za-z0-9_-]{40,}$/.exec(String(token || ''))?.[1] || '';
}

export function validTeamInvitation(invitation, token, now = Date.now()) {
  if (!invitation || invitation.status !== 'pending' || invitation.id !== teamInvitationId(token)
    || Date.parse(invitation.expiresAt) <= now || !Number.isFinite(Date.parse(invitation.expiresAt))) return false;
  const given = Buffer.from(createHash('sha256').update(token).digest('hex'));
  const expected = Buffer.from(String(invitation.tokenHash || ''));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function publicTeamInvitation({ tokenHash: _tokenHash, ...invitation }) {
  return invitation;
}
