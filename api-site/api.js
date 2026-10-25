const samples = {
  curl: `curl --request POST \\
  --url https://api.ai7uae.com/service/uae_tlv \\
  --header 'Authorization: Bearer YOUR_AI7_API_KEY' \\
  --header 'Content-Type: application/json' \\
  --data '{"license_number":"123456","emirate":"dubai"}'`,
  javascript: `const response = await fetch(
  'https://api.ai7uae.com/service/uae_tlv',
  {
    method: 'POST',
    headers: {
      Authorization: 'Bearer YOUR_AI7_API_KEY',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      license_number: '123456',
      emirate: 'dubai'
    })
  }
);

const result = await response.json();`,
  python: `import requests

response = requests.post(
    "https://api.ai7uae.com/service/uae_tlv",
    headers={"Authorization": "Bearer YOUR_AI7_API_KEY"},
    json={"license_number": "123456", "emirate": "dubai"},
)

result = response.json()`
};

const sampleCode = document.querySelector('#sample-code');
const responseJson = document.querySelector('#response-json');
const responseStatus = document.querySelector('#response-status');
const form = document.querySelector('#api-form');
const sendButton = document.querySelector('#send-request');

sampleCode.textContent = samples.curl;

document.querySelectorAll('[data-sample]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-sample]').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    sampleCode.textContent = samples[button.dataset.sample];
  });
});

async function copyText(value, button) {
  await navigator.clipboard.writeText(value);
  const original = button.textContent;
  button.textContent = 'Copied';
  window.setTimeout(() => { button.textContent = original; }, 1200);
}

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', () => copyText(button.dataset.copy, button));
});

document.querySelector('#copy-sample').addEventListener('click', (event) => {
  copyText(sampleCode.textContent, event.currentTarget);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = document.querySelector('#api-key').value.trim();
  const licenseNumber = document.querySelector('#license-number').value.trim();
  const emirate = document.querySelector('#emirate').value;
  const body = { license_number: licenseNumber };
  if (emirate) body.emirate = emirate;

  sendButton.disabled = true;
  responseStatus.className = '';
  responseStatus.textContent = 'Sending…';
  responseJson.textContent = '{\n  "message": "Request in progress…"\n}';

  try {
    const response = await fetch('/service/uae_tlv', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let formatted = text;
    try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show raw response */ }
    responseJson.textContent = formatted;
    responseStatus.className = response.ok ? 'success' : 'error';
    responseStatus.textContent = `${response.status} ${response.statusText}`;
  } catch {
    responseStatus.className = 'error';
    responseStatus.textContent = 'Network error';
    responseJson.textContent = JSON.stringify({ status: 'Error', error: 'The request could not be sent.' }, null, 2);
  } finally {
    sendButton.disabled = false;
  }
});
