const samples = {
  curl: `curl --request POST 'https://api.ai7uae.com/service/iban_verification' \\
  --header 'Authorization: Bearer YOUR_AI7_API_KEY' \\
  --header 'Content-Type: application/json' \\
  --data '{
    "source": "API",
    "transID": "YOUR-UNIQUE-ID",
    "docType": 610,
    "country": "AE",
    "firstName": "FIRST",
    "lastName": "LAST",
    "bankCode": "BANKCODE",
    "bankAccountNumber": "ACCOUNTNUMBER",
    "bic": "",
    "iban": "",
    "id": "",
    "idType": ""
  }'`,
  javascript: `const response = await fetch(
  'https://api.ai7uae.com/service/iban_verification',
  {
    method: 'POST',
    headers: {
      Authorization: 'Bearer YOUR_AI7_API_KEY',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      source: 'API',
      transID: 'YOUR-UNIQUE-ID',
      docType: 610,
      country: 'AE',
      iban: 'YOUR-IBAN'
    })
  }
);

const result = await response.json();`,
  python: `import requests

response = requests.post(
    "https://api.ai7uae.com/service/iban_verification",
    headers={"Authorization": "Bearer YOUR_AI7_API_KEY"},
    json={
        "source": "API",
        "transID": "YOUR-UNIQUE-ID",
        "docType": 610,
        "country": "AE",
        "iban": "YOUR-IBAN",
    },
)

result = response.json()`
};

const byId = (id) => document.getElementById(id);
const sampleCode = byId('sample-code');
const responseJson = byId('response-json');
const responseStatus = byId('response-status');
const sendButton = byId('send-request');
const formError = byId('form-error');

sampleCode.textContent = samples.curl;

async function copyText(value, button) {
  await navigator.clipboard.writeText(value);
  const original = button.textContent;
  button.textContent = 'Copied';
  window.setTimeout(() => { button.textContent = original; }, 1200);
}

document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', () => copyText(button.dataset.copy, button)));
document.querySelectorAll('[data-sample]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-sample]').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    sampleCode.textContent = samples[button.dataset.sample];
  });
});
byId('copy-sample').addEventListener('click', (event) => copyText(sampleCode.textContent, event.currentTarget));

function requestBody() {
  const values = {
    source: byId('source').value.trim(),
    transID: byId('trans-id').value.trim(),
    docType: byId('doc-type').value.trim(),
    country: byId('country').value.trim(),
    firstName: byId('first-name').value.trim(),
    lastName: byId('last-name').value.trim(),
    completeName: byId('complete-name').value.trim(),
    requestCategory: byId('request-category').value.trim(),
    bankCode: byId('bank-code').value.trim(),
    bankAccountNumber: byId('bank-account-number').value.trim(),
    bic: byId('bic').value.trim(),
    iban: byId('iban').value.trim(),
    id: byId('identity-id').value.trim(),
    idType: byId('id-type').value.trim()
  };
  if (/^\d+$/.test(values.docType)) values.docType = Number(values.docType);
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
}

byId('iban-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = byId('api-key').value.trim();
  const body = requestBody();
  formError.textContent = '';
  if (!key) { formError.textContent = 'Enter your AI7 API key.'; byId('api-key').focus(); return; }
  for (const [name, id] of [['transID', 'trans-id'], ['docType', 'doc-type'], ['country', 'country']]) {
    if (body[name] === undefined) { formError.textContent = `${name} is required.`; byId(id).focus(); return; }
  }

  sendButton.disabled = true;
  responseStatus.className = '';
  responseStatus.textContent = 'Sending…';
  responseJson.textContent = '{\n  "message": "Request in progress…"\n}';
  try {
    const response = await fetch('/service/iban_verification', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let formatted = text;
    try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch { /* retain exact non-JSON response */ }
    responseJson.textContent = formatted;
    responseStatus.className = response.ok ? 'success' : 'error';
    responseStatus.textContent = `${response.status} ${response.statusText}`;
  } catch {
    responseStatus.className = 'error';
    responseStatus.textContent = 'Request error';
    responseJson.textContent = JSON.stringify({ status: 'Error', error: 'The request could not be sent.' }, null, 2);
  } finally {
    sendButton.disabled = false;
  }
});
