const ENDPOINT = 'https://www.taed.dev/api/v1/extract';
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const API_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);

export const TAED_DOCUMENT_API_IDS = Object.freeze({
  'moa-analysis': '5070ccf6-a243-4e5e-8fb1-e5360ffb3ab0'
});

export async function extractDocumentWithTaed({ apiId, bytes, mediaType, apiKey,
  fetchImpl = fetch, timeoutMs = 120_000 }) {
  if (!API_ID.test(String(apiId || ''))) throw new Error('document_ocr_taed_api_id_invalid');
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_DOCUMENT_BYTES)
    throw new Error('document_ocr_file_limit');
  if (!MEDIA_TYPES.has(mediaType)) throw new Error('document_ocr_media_type_unsupported');
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('document_ocr_taed_credential_unavailable');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new Error('document_ocr_taed_timeout_invalid');

  const form = new FormData();
  form.set('api_id', apiId);
  const extension = mediaType === 'application/pdf' ? 'pdf' : mediaType === 'image/png' ? 'png' : 'jpg';
  form.set('file', new Blob([bytes], { type: mediaType }), `document.${extension}`);
  const response = await fetchImpl(ENDPOINT, { method: 'POST',
    headers: { 'X-API-Key': apiKey }, body: form, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`document_ocr_taed_http_${response.status}`);
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_RESPONSE_BYTES) throw new Error('document_ocr_taed_response_limit');
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_RESPONSE_BYTES) throw new Error('document_ocr_taed_response_limit');
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { throw new Error('document_ocr_taed_response_invalid'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('document_ocr_taed_response_invalid');
  return payload;
}
