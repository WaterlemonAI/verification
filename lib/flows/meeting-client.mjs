// Flo uses the same configured private integrations as the customer meeting APIs.
// Supplier sessions never receive either the AI7 client key or the Work bearer token.
export const KYS_CALENDAR_EMAIL = 'kys@ai7uae.com';

export async function callProcurementMeeting(kind, payload, { platformStore, fetchImpl = fetch, idempotencyKey } = {}) {
  const id = kind === 'availability' ? 'meeting-availability' : kind === 'book' ? 'setup-video-call' : null;
  if (!id || !platformStore) return { status: 503, error: 'meeting_unavailable' };
  const integration = await platformStore.getIntegrationById(id);
  const token = await platformStore.getMasterKey(id);
  if (!integration?.enabled || !token) return { status: 503, error: 'meeting_unavailable' };
  const target = new URL(integration.upstreamUrl);
  if (target.protocol !== 'https:' || target.hostname !== 'work.ai7uae.com')
    return { status: 503, error: 'meeting_unavailable' };
  try {
    const response = await fetchImpl(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(id === 'setup-video-call' ? { 'idempotency-key': idempotencyKey } : {}) },
      body: JSON.stringify(payload) });
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 64 * 1024) return { status: 502, error: 'meeting_response_too_large' };
    const data = JSON.parse(Buffer.from(bytes).toString());
    if (!response.ok) return { status: response.status, error: typeof data.error === 'string'
      ? data.error.slice(0, 240) : 'meeting_provider_error' };
    return { status: response.status, data };
  } catch {
    return { status: 503, error: 'meeting_unavailable' };
  }
}
