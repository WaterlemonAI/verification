export class ContainerAppsManagedIdentityCredential {
  async getToken(scopes) {
    const endpoint = process.env.IDENTITY_ENDPOINT;
    const identityHeader = process.env.IDENTITY_HEADER;
    if (!endpoint || !identityHeader) throw new Error('managed_identity_unavailable');
    const requested = Array.isArray(scopes) ? scopes[0] : scopes;
    const resource = String(requested).replace(/\.default$/, '');
    const url = new URL(endpoint);
    url.searchParams.set('api-version', '2019-08-01');
    url.searchParams.set('resource', resource);
    if (process.env.RUNTIME_IDENTITY_CLIENT_ID) url.searchParams.set('client_id', process.env.RUNTIME_IDENTITY_CLIENT_ID);
    const response = await fetch(url, {
      headers: { 'x-identity-header': identityHeader, metadata: 'true' },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`managed_identity_failed_${response.status}`);
    const payload = await response.json();
    const expires = Number(payload.expires_on);
    return {
      token: payload.access_token,
      expiresOnTimestamp: Number.isFinite(expires) ? expires * 1_000 : Date.now() + 45 * 60 * 1_000
    };
  }
}
