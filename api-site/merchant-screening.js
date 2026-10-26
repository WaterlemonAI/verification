const sampleBody = {
  website_url: 'https://merchant.example',
  country_code: 'AE',
  declared_merchant_name: 'Example Merchant LLC',
  declared_mcc: '5734',
  max_pages: 12
};

const samples = {
  curl: `curl --request POST \\
  --url https://api.ai7uae.com/service/merchant_screening \\
  --header 'Authorization: Bearer YOUR_AI7_API_KEY' \\
  --header 'Content-Type: application/json' \\
  --data '${JSON.stringify(sampleBody, null, 2)}'`,
  javascript: `const response = await fetch(
  'https://api.ai7uae.com/service/merchant_screening',
  {
    method: 'POST',
    headers: {
      Authorization: 'Bearer YOUR_AI7_API_KEY',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(${JSON.stringify(sampleBody, null, 4)})
  }
);

console.log(await response.json());`,
  python: `import requests

response = requests.post(
    "https://api.ai7uae.com/service/merchant_screening",
    headers={
        "Authorization": "Bearer YOUR_AI7_API_KEY",
        "Content-Type": "application/json",
    },
    json=${JSON.stringify(sampleBody, null, 4)},
    timeout=240,
)

print(response.status_code)
print(response.json())`
};

const byId = (id) => document.getElementById(id);
const sampleCode = byId('sample-code');
const copySample = byId('copy-sample');
const copyResponse = byId('copy-response');
const responseJson = byId('response-json');
const responseStatus = byId('response-status');
const formError = byId('form-error');
const sendButton = byId('send-request');

function showSample(name) {
  sampleCode.textContent = samples[name];
  document.querySelectorAll('[data-sample]').forEach((button) => {
    button.classList.toggle('active', button.dataset.sample === name);
  });
}

async function copyText(value, button) {
  await navigator.clipboard.writeText(value);
  const original = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = original; }, 1200);
}

document.querySelectorAll('[data-sample]').forEach((button) => {
  button.addEventListener('click', () => showSample(button.dataset.sample));
});

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', () => copyText(button.dataset.copy, button));
});

copySample.addEventListener('click', () => copyText(sampleCode.textContent, copySample));
copyResponse.addEventListener('click', () => copyText(responseJson.textContent, copyResponse));
showSample('curl');

function requestBody() {
  const rawUrl = byId('website-url').value.trim();
  let websiteUrl;
  try { websiteUrl = new URL(rawUrl); } catch { throw new Error('Enter a valid public HTTPS website URL.'); }
  if (websiteUrl.protocol !== 'https:' || websiteUrl.username || websiteUrl.password) {
    throw new Error('Website URL must use HTTPS and must not contain credentials.');
  }

  const countryCode = byId('country-code').value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error('Country code must contain two letters, such as AE or GB.');
  const declaredMcc = byId('declared-mcc').value.trim();
  if (declaredMcc && !/^\d{4}$/.test(declaredMcc)) throw new Error('Declared MCC must contain exactly four digits.');
  const maxPages = Number(byId('max-pages').value);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error('Maximum pages must be from 1 to 20.');

  const body = {
    website_url: websiteUrl.href,
    country_code: countryCode,
    declared_merchant_name: byId('declared-merchant-name').value.trim(),
    declared_mcc: declaredMcc,
    max_pages: maxPages
  };
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== ''));
}

byId('merchant-screening-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = byId('api-key').value.trim();
  formError.textContent = '';
  if (!key) {
    formError.textContent = 'Enter your AI7 API key.';
    byId('api-key').focus();
    return;
  }

  let body;
  try { body = requestBody(); } catch (error) {
    formError.textContent = error.message;
    return;
  }

  sendButton.disabled = true;
  copyResponse.disabled = true;
  responseStatus.className = '';
  responseStatus.textContent = 'Collecting…';
  responseJson.textContent = JSON.stringify({ status: 'pending', request: body }, null, 2);
  responseJson.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const response = await fetch('/service/merchant_screening', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); responseJson.textContent = JSON.stringify(parsed, null, 2); }
    catch { responseJson.textContent = text; }
    copyResponse.disabled = false;
    const isPartial = response.ok && parsed?.status === 'partial';
    responseStatus.className = response.ok && !isPartial ? 'success' : 'error';
    responseStatus.textContent = isPartial
      ? `${response.status} Partial — review coverage`
      : `${response.status} ${response.statusText}`;
  } catch {
    responseStatus.className = 'error';
    responseStatus.textContent = 'Request error';
    responseJson.textContent = JSON.stringify({ status: 'Error', error: 'The request could not be sent.' }, null, 2);
    copyResponse.disabled = false;
  } finally {
    sendButton.disabled = false;
  }
});
