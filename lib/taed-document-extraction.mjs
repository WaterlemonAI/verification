const ENDPOINT = 'https://www.taed.dev/api/v1/extract';
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const API_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const ERROR_CODES = Object.freeze({
  EXTRACTION_PIPELINE_FAILURE: 500,
  MODEL_COMPLIANCE_REFUSAL: 403,
  SCHEMA_MISMATCH_EMPTY_OUTPUT: 422,
  UNREADABLE_IMAGE_CONTENT: 422
});

export const TAED_DOCUMENT_API_IDS = Object.freeze({
  'moa-analysis': '5070ccf6-a243-4e5e-8fb1-e5360ffb3ab0',
  'uae-trade-license-ocr': '0e6e2e97-e185-4933-85d8-6344b004ca99'
});

async function readBounded(response) {
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_RESPONSE_BYTES) throw new Error('document_ocr_taed_response_limit');
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('document_ocr_taed_response_limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function safeProviderError(status, body) {
  try {
    const payload = JSON.parse(body.toString('utf8'));
    const code = payload?.code || payload?.error_code || payload?.error?.code || payload?.detail?.code;
    if (Object.hasOwn(ERROR_CODES, code) && ERROR_CODES[code] === status)
      return `document_ocr_taed_${code.toLowerCase()}`;
  } catch { /* Unknown provider body is never included in the error. */ }
  return `document_ocr_taed_http_${status}`;
}

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
  const extension = { 'application/pdf': 'pdf', 'image/png': 'png',
    'image/jpeg': 'jpg', 'image/webp': 'webp' }[mediaType];
  form.set('file', new Blob([bytes], { type: mediaType }), `document.${extension}`);
  const response = await fetchImpl(ENDPOINT, { method: 'POST',
    headers: { 'X-API-Key': apiKey }, body: form, signal: AbortSignal.timeout(timeoutMs) });
  const body = await readBounded(response);
  if (!response.ok) throw new Error(safeProviderError(response.status, body));
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { throw new Error('document_ocr_taed_response_invalid'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('document_ocr_taed_response_invalid');
  return payload;
}
