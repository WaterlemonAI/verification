const byId = (id) => document.getElementById(id);
const serviceId = location.pathname.split('/').filter(Boolean).at(-1);
const apiOrigin = 'https://api.ai7uae.com';
let service;
let latestJson = '';
let pollTimer;
let pollController;
let currentResultUrl = '';

function safeResultUrl(value) {
  if (typeof value !== 'string' || !service?.publicPath) return '';
  try {
    const url = new URL(value, location.origin);
    const prefix = `${service.publicPath}/jobs/`;
    if (url.origin !== location.origin || url.username || url.password || url.search || url.hash
      || !url.pathname.startsWith(prefix)
      || !/^ocr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/result$/i.test(url.pathname.slice(prefix.length))) return '';
    return url.href;
  } catch { return ''; }
}

function show(value, label) {
  latestJson = JSON.stringify(value, null, 2);
  byId('response-json').textContent = latestJson;
  byId('response-status').textContent = label;
  byId('copy-response').disabled = false;
}

function fieldType(field) {
  if (field.type === 'array') return 'array';
  return Array.isArray(field.type) ? field.type.join(' / ') : field.type;
}

async function load() {
  const response = await fetch('/document-extraction-catalog.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Documentation is unavailable.');
  service = (await response.json()).find((item) => item.id === serviceId);
  if (!service) throw new Error('Unknown extraction service.');
  document.title = `KYCProbe — ${service.name}`;
  byId('service-title').textContent = service.name;
  byId('endpoint-path').textContent = service.publicPath;
  byId('limits').textContent = `Maximum ${service.maxFiles} file${service.maxFiles > 1 ? 's' : ''} and ${service.maxPages} page${service.maxPages > 1 ? 's' : ''}.`;
  byId('additional-file-wrap').hidden = service.maxFiles === 1;
  byId('peppol-check-wrap').hidden = service.id !== 'uae-trade-license-ocr';
  byId('fields').replaceChildren(...Object.entries(service.fields).map(([name, field]) => {
    const box = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = name;
    const type = document.createElement('span'); type.textContent = fieldType(field);
    const description = document.createElement('p'); description.textContent = field.description || '';
    box.append(title, type, description);
    return box;
  }));
  byId('sample-code').textContent = `curl -X POST '${apiOrigin}${service.publicPath}' \\\n  -H 'Authorization: Bearer YOUR_AI7_API_KEY' \\\n  -H "Idempotency-Key: $(uuidgen)" \\\n  -F 'file=@/path/to/document.pdf'${service.maxFiles > 1 ? ` \\\n  -F 'additional_file=@/path/to/back.jpg'` : ''}`;
  byId('copy-endpoint').addEventListener('click', () => navigator.clipboard.writeText(`${apiOrigin}${service.publicPath}`));
}

async function poll(resultUrl, key, attempts = 0) {
  if (attempts >= 40) { byId('response-status').textContent = 'Still processing — use the result URL later';
    byId('ocr-progress').textContent = 'Polling paused after 40 checks. Copy the result URL and use your API key later.';
    byId('send-request').disabled = false; return; }
  pollController = new AbortController();
  const response = await fetch(resultUrl, { headers: { authorization: `Bearer ${key}` }, cache: 'no-store', redirect: 'error',
    signal: pollController.signal });
  const data = await response.json();
  const state = String(data.status || '').toLowerCase();
  const label = response.status === 202 ? state === 'queued' ? 'Queued' : 'Processing…'
    : response.ok ? state === 'expired' ? 'Expired' : state === 'failed' ? 'Failed' : 'Completed extraction'
      : `HTTP ${response.status}`;
  show(data, label);
  byId('ocr-progress').textContent = response.status === 202
    ? `Job ${state || 'processing'} · check ${attempts + 1} of 40` : `Final job state: ${state || label.toLowerCase()}.`;
  if (response.status === 202) pollTimer = setTimeout(() => poll(resultUrl, key, attempts + 1).catch((error) => {
    if (error.name !== 'AbortError') byId('form-error').textContent = 'Polling paused. Copy the result URL and try again later.';
    byId('send-request').disabled = false;
  }), 3000);
  else byId('send-request').disabled = false;
}

byId('ocr-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearTimeout(pollTimer);
  pollController?.abort();
  currentResultUrl = '';
  byId('ocr-progress').textContent = '';
  byId('ocr-result-reference').hidden = true;
  byId('ocr-result-url').textContent = '';
  byId('form-error').textContent = '';
  const key = byId('api-key').value.trim();
  const file = byId('file').files[0];
  const additional = byId('additional-file').files[0];
  if (!service || !key || !file) return;
  if (file.size + (additional?.size || 0) > 25 * 1024 * 1024) {
    byId('form-error').textContent = 'The combined upload must be no more than 25 MiB.';
    return;
  }
  const form = new FormData();
  form.set('file', file);
  if (additional) form.set('additional_file', additional);
  byId('send-request').disabled = true;
  byId('response-status').textContent = 'Submitting…';
  try {
    const response = await fetch(service.publicPath, { method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': crypto.randomUUID(),
        ...(service.id === 'uae-trade-license-ocr' && byId('peppol-check').checked
          ? { 'X-AI7-Peppol-Check': 'true' } : {}) }, body: form });
    const data = await response.json();
    show(data, response.status === 202 ? 'Queued' : response.ok ? 'Completed extraction' : `HTTP ${response.status}`);
    if (data.result_url) {
      currentResultUrl = safeResultUrl(data.result_url);
      if (currentResultUrl) {
        byId('ocr-result-url').textContent = currentResultUrl;
        byId('ocr-result-reference').hidden = false;
      } else byId('form-error').textContent = 'The result URL was rejected. Polling did not start; use the receipt to contact support.';
    }
    if (response.status === 202 && currentResultUrl) await poll(currentResultUrl, key);
    else byId('send-request').disabled = false;
  } catch (error) {
    byId('form-error').textContent = 'The request could not be completed. Check your connection and try again.';
    byId('response-status').textContent = 'Connection error';
    byId('send-request').disabled = false;
  }
});
byId('copy-sample').addEventListener('click', () => navigator.clipboard.writeText(byId('sample-code').textContent));
byId('copy-response').addEventListener('click', () => navigator.clipboard.writeText(latestJson));
byId('copy-ocr-result').addEventListener('click', () => navigator.clipboard.writeText(currentResultUrl));
window.addEventListener('pagehide', () => { clearTimeout(pollTimer); pollController?.abort(); });
window.KYCStatusView?.attach('ocr');
load().catch((error) => { byId('form-error').textContent = error.message; });
