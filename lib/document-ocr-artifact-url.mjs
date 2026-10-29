import { createHmac, timingSafeEqual } from 'node:crypto';

function signature(workspaceId, jobId, name, expires) {
  const key = process.env.DOCUMENT_OCR_DOWNLOAD_SIGNING_KEY_HEX;
  if (!/^[a-f0-9]{64}$/i.test(key || '')) throw new Error('document_ocr_download_signing_unavailable');
  return createHmac('sha256', Buffer.from(key, 'hex')).update(`${workspaceId}\n${jobId}\n${name}\n${expires}`).digest('hex');
}

export function documentOcrArtifactUrl(definition, workspaceId, jobId, name) {
  const expires = Math.floor(Date.now() / 1000) + 300;
  const signed = signature(workspaceId, jobId, name, expires);
  const origin = process.env.API_PUBLIC_BASE_URL || 'https://api.ai7uae.com';
  return `${origin}${definition.publicPath}/jobs/${jobId}/artifacts/${name}?workspace_id=${encodeURIComponent(workspaceId)}&expires=${expires}&signature=${signed}`;
}

export function documentOcrSignedAccess(url, jobId, name) {
  const workspaceId = url.searchParams.get('workspace_id') || '';
  const expires = Number(url.searchParams.get('expires'));
  const signed = url.searchParams.get('signature') || '';
  if (!/^[a-f0-9]{64}$/i.test(signed) || !Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)
    || expires > Math.floor(Date.now() / 1000) + 300 || !/^[A-Za-z0-9._:-]{8,128}$/.test(workspaceId)) return null;
  const expected = signature(workspaceId, jobId, name, expires);
  return timingSafeEqual(Buffer.from(signed, 'hex'), Buffer.from(expected, 'hex')) ? workspaceId : null;
}
