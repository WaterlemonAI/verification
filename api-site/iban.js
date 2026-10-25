const samples = {
  curl: `curl --request POST 'https://api.ai7uae.com/service/iban_verification' \\
  --header 'Authorization: Bearer YOUR_AI7_API_KEY' \\
  --header 'Content-Type: application/json' \\
  --data '{
    "source": "API",
    "transID": "YOUR-UNIQUE-ID",
    "docType": 610,
    "requestCategory": "business",
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
      requestCategory: 'business',
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
        "requestCategory": "business",
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

const countryCodes = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ
VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`.trim().split(/\s+/);

const countrySelect = byId('country');
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countries = countryCodes
  .map((code) => ({ code, name: regionNames.of(code) || code }))
  .sort((a, b) => a.name.localeCompare(b.name));
countrySelect.replaceChildren(...countries.map(({ code, name }) => {
  const option = document.createElement('option');
  option.value = code;
  option.textContent = `${name} (${code})`;
  option.selected = code === 'AE';
  return option;
}));

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

function createTransactionId() {
  if (globalThis.crypto.randomUUID) return `AI7-${globalThis.crypto.randomUUID()}`;
  const random = globalThis.crypto.getRandomValues(new Uint32Array(2));
  return `AI7-${Date.now()}-${random[0].toString(16)}${random[1].toString(16)}`;
}

function requestBody() {
  const values = {
    source: byId('source').value.trim(),
    transID: createTransactionId(),
    docType: 610,
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
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
}

byId('iban-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = byId('api-key').value.trim();
  const body = requestBody();
  formError.textContent = '';
  if (!key) { formError.textContent = 'Enter your AI7 API key.'; byId('api-key').focus(); return; }
  for (const [name, id] of [['country', 'country'], ['requestCategory', 'request-category']]) {
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
