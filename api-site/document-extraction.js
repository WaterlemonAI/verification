const byId = (id) => document.getElementById(id);
const serviceId = location.pathname.split('/').filter(Boolean).at(-1);
const apiOrigin = 'https://api.ai7uae.com';
let service;
let latestJson = '';
let pollTimer;

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
  byId('fields').replaceChildren(...Object.entries(service.fields).map(([name, field]) => {
    const box = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = name;
    const type = document.createElement('span'); type.textContent = fieldType(field);
    const description = document.createElement('p'); description.textContent = field.description || '';
    box.append(title, type, description);
    return box;
  }));
  byId('sample-code').textContent = `curl -X POST '${apiOrigin}${service.publicPath}' \\\n  -H 'Authorization: Bearer YOUR_AI7_API_KEY' \\\n  -H 'Idempotency-Key: $(uuidgen)' \\\n  -F 'file=@/path/to/document.pdf'${service.maxFiles > 1 ? ` \\\n  -F 'additional_file=@/path/to/back.jpg'` : ''}`;
  byId('copy-endpoint').addEventListener('click', () => navigator.clipboard.writeText(`${apiOrigin}${service.publicPath}`));
}

async function poll(resultUrl, key, attempts = 0) {
  if (attempts >= 60) { byId('response-status').textContent = 'Still processing — use the result URL later'; return; }
  const response = await fetch(resultUrl, { headers: { authorization: `Bearer ${key}` }, cache: 'no-store' });
  const data = await response.json();
  show(data, response.status === 202 ? 'Processing…' : `HTTP ${response.status}`);
  if (response.status === 202) pollTimer = setTimeout(() => poll(resultUrl, key, attempts + 1).catch((error) => {
    byId('form-error').textContent = error.message;
  }), 3000);
  else byId('send-request').disabled = false;
}

byId('ocr-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearTimeout(pollTimer);
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
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': crypto.randomUUID() }, body: form });
    const data = await response.json();
    show(data, `HTTP ${response.status}`);
    if (response.status === 202 && data.result_url) await poll(data.result_url, key);
    else byId('send-request').disabled = false;
  } catch (error) {
    byId('form-error').textContent = 'The request could not be completed. Check your connection and try again.';
    byId('response-status').textContent = 'Connection error';
    byId('send-request').disabled = false;
  }
});
byId('copy-sample').addEventListener('click', () => navigator.clipboard.writeText(byId('sample-code').textContent));
byId('copy-response').addEventListener('click', () => navigator.clipboard.writeText(latestJson));
load().catch((error) => { byId('form-error').textContent = error.message; });
