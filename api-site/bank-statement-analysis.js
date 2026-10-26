const endpoint = 'https://api.ai7uae.com/service/bank_statement_analysis';
const samples = {
  curl: `curl --request POST \\
  --url ${endpoint} \\
  --header 'Authorization: Bearer YOUR_AI7_API_KEY' \\
  --header 'Idempotency-Key: YOUR_UNIQUE_REQUEST_ID' \\
  --form 'statement_file=@statement.pdf;type=application/pdf' \\
  --form 'country_code=AE' \\
  --form 'entity_type=company' \\
  --form 'get_pdf=true'`,
  javascript: `const form = new FormData();
form.append('statement_file', file);
form.append('country_code', 'AE');
form.append('entity_type', 'company');
form.append('get_pdf', 'true');

const accepted = await fetch('${endpoint}', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer YOUR_AI7_API_KEY',
    'Idempotency-Key': crypto.randomUUID()
  },
  body: form
});
console.log(await accepted.json());`,
  python: `import uuid
import requests

with open("statement.pdf", "rb") as statement:
    response = requests.post(
        "${endpoint}",
        headers={
            "Authorization": "Bearer YOUR_AI7_API_KEY",
            "Idempotency-Key": str(uuid.uuid4()),
        },
        files={"statement_file": ("statement.pdf", statement, "application/pdf")},
        data={"country_code": "AE", "entity_type": "company", "get_pdf": "true"},
        timeout=60,
    )
print(response.status_code, response.json())`
};

const byId = (id) => document.getElementById(id);
const responseJson = byId('response-json');
const responseStatus = byId('response-status');
const copyResponse = byId('copy-response');
const sendButton = byId('send-request');
const formError = byId('form-error');
const artifactActions = byId('artifact-actions');
let currentKey = '';

function showSample(name) {
  byId('sample-code').textContent = samples[name];
  document.querySelectorAll('[data-sample]').forEach((button) => button.classList.toggle('active', button.dataset.sample === name));
}

async function copyText(value, button) {
  await navigator.clipboard.writeText(value);
  const original = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = original; }, 1200);
}

document.querySelectorAll('[data-sample]').forEach((button) => button.addEventListener('click', () => showSample(button.dataset.sample)));
document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', () => copyText(button.dataset.copy, button)));
byId('copy-sample').addEventListener('click', () => copyText(byId('sample-code').textContent, byId('copy-sample')));
copyResponse.addEventListener('click', () => copyText(responseJson.textContent, copyResponse));
showSample('curl');

function fields() {
  const files = Array.from(byId('statement-file').files || []);
  if (!files.length) throw new Error('Select one PDF or one or more statement images.');
  if (files.length > 100) throw new Error('A maximum of 100 image pages can be uploaded.');
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > 25 * 1024 * 1024) throw new Error('The combined upload must not exceed 25 MiB.');
  if (files.length > 1 && files.some((file) => file.type === 'application/pdf')) throw new Error('Upload one PDF or an image bundle, not both.');
  const income = byId('declared-income').value.trim();
  const currency = byId('income-currency').value.trim().toUpperCase();
  if (income && !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,3})?$/.test(income)) throw new Error('Declared income must be a positive decimal value.');
  if (income && !/^[A-Z]{3}$/.test(currency)) throw new Error('Income currency must use a three-letter code.');
  return { files, income, currency };
}

function formData(values) {
  const body = new FormData();
  values.files.forEach((file) => body.append('statement_file', file, file.name));
  body.append('country_code', 'AE');
  body.append('entity_type', byId('entity-type').value);
  const names = byId('declared-names').value.split('\n').map((name) => name.trim()).filter(Boolean);
  if (names.length) body.append('declared_names', JSON.stringify(names));
  if (byId('declared-employer').value.trim()) body.append('declared_employer', byId('declared-employer').value.trim());
  if (values.income) {
    body.append('declared_monthly_income', values.income);
    body.append('declared_income_currency', values.currency);
  }
  if (byId('customer-reference').value.trim()) body.append('customer_reference', byId('customer-reference').value.trim());
  body.append('get_pdf', String(byId('get-pdf').checked));
  body.append('get_xlsx', String(byId('get-xlsx').checked));
  body.append('credit_models', JSON.stringify(Array.from(document.querySelectorAll('[name="credit-model"]:checked'), (input) => input.value)));
  return body;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function downloadArtifact(url, filename) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${currentKey}` } });
  if (!response.ok) throw new Error('Artifact download failed.');
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function renderArtifacts(result) {
  artifactActions.replaceChildren();
  for (const artifact of result.artifacts || []) {
    if (!artifact.downloadUrl) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = `Download ${artifact.filename}`;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await downloadArtifact(artifact.downloadUrl, artifact.filename); }
      catch (error) { formError.textContent = error.message; }
      finally { button.disabled = false; }
    });
    artifactActions.append(button);
  }
}

async function poll(resultUrl) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await wait(2000);
    const response = await fetch(resultUrl, { headers: { Authorization: `Bearer ${currentKey}`, accept: 'application/json' } });
    const result = await response.json();
    responseJson.textContent = JSON.stringify(result, null, 2);
    copyResponse.disabled = false;
    if (response.status === 202) {
      responseStatus.textContent = `${result.status || 'processing'}…`;
      continue;
    }
    responseStatus.className = response.ok && result.status === 'completed' ? 'success' : 'error';
    responseStatus.textContent = `${response.status} ${result.status || response.statusText}`;
    if (response.ok) renderArtifacts(result);
    return;
  }
  throw new Error('The analysis is still running. Use the returned resultUrl to continue polling.');
}

byId('bsa-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  currentKey = byId('api-key').value.trim();
  formError.textContent = '';
  artifactActions.replaceChildren();
  if (!currentKey) { formError.textContent = 'Enter your AI7 API key.'; return; }
  let values;
  try { values = fields(); } catch (error) { formError.textContent = error.message; return; }
  sendButton.disabled = true;
  copyResponse.disabled = true;
  responseStatus.className = '';
  responseStatus.textContent = 'Uploading…';
  try {
    const response = await fetch('/service/bank_statement_analysis', {
      method: 'POST',
      headers: { Authorization: `Bearer ${currentKey}`, 'Idempotency-Key': crypto.randomUUID() },
      body: formData(values)
    });
    const result = await response.json();
    responseJson.textContent = JSON.stringify(result, null, 2);
    copyResponse.disabled = false;
    responseStatus.textContent = `${response.status} ${result.status || response.statusText}`;
    if (!response.ok) { responseStatus.className = 'error'; return; }
    await poll(result.resultUrl);
  } catch (error) {
    responseStatus.className = 'error';
    responseStatus.textContent = 'Request error';
    formError.textContent = error.message || 'The request could not be completed.';
  } finally {
    sendButton.disabled = false;
  }
});
