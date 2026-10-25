const authorisingBodies = [
  'abu_dhabi_department_of_economic_development',
  'abu_dhabi_tourism_authority',
  'abu_dhabi_industrial_development',
  'moe_industrial_licensing_department',
  'khalifa_industrial_zone_abu_dhabi',
  'kizad',
  'abu_dhabi_global_market',
  'abu_dhabi_airports_free_zone',
  'masdar_city',
  'dubai_department_of_economy_and_tourism',
  'dubai_municipality',
  'dubai_airport_free_zone_authority',
  'dubai_development_authority',
  'dubai_healthcare_city',
  'dubai_international_financial_centre',
  'difc',
  'dubai_multi_commodities_centre',
  'dubai_silicon_oasis',
  'international_humanitarian_city',
  'jabel_ali_freezone_authority',
  'dubai_south',
  'dubai_world_trade_centre',
  'dwtc',
  'meydan',
  'dubai_internet_city',
  'dubai_media_city',
  'dubai_knowledge_park',
  'ports_customs_and_free_zone_corporation',
  'trakhees',
  'dubai_maritime_city_authority',
  'dubai_science_park',
  'dubai_industrial_city',
  'dubai_commercity',
  'international_free_zone_authority',
  'ifza',
  'dubai_auto_zone',
  'dubai_flower_centre',
  'dubai_logistics_city',
  'dubai_outsource_zone',
  'gold_and_diamond_park',
  'dubai_cars_and_automotive_zone',
  'ducamz',
  'national_industries_park',
  'dubai_textile_city',
  'dibba_municipality',
  'fujairah_municipality',
  'fujairah_free_zone_authority',
  'creative_city_free_zone_authority',
  'ccfz',
  'fujairah_culture_and_media_authority',
  'ras_al_khaimah_tourism_development_authority',
  'ras_al_khaimah_economic_zone',
  'rakez',
  'rak_international_corporate_centre',
  'rakicc',
  'ras_al_khaimah_department_of_economic_development',
  'ras_al_khaimah_maritime_city',
  'umm_al_quwain_department_of_economic_development',
  'umm_al_quwain_free_trade_zone',
  'ajman_municipality',
  'ajman_department_of_economic_development',
  'ajman_free_zone',
  'ajman_media_city_free_zone',
  'sharjah_economic_development_department',
  'sharjah_airport_international_free_zone_authority',
  'hamriyah_free_zone_authority',
  'sharjah_media_city',
  'sharjah_publishing_free_zone',
  'sharjah_research_technology_and_innovation_park',
  'sharjah_oasis_technology_and_innovation_free_zone_authority',
  'abu_dhabi_media_freezone_twofour54'
];

const samples = {
  curl: `curl --request POST \\
  --url https://api.ai7uae.com/service/uae_tlv \\
  --header 'Authorization: Bearer YOUR_AI7_API_KEY' \\
  --header 'Content-Type: application/json' \\
  --data '{
    "license_number": "123456",
    "company_name": "Example Trading LLC",
    "emirate": "dubai",
    "authorising_body": "dubai_department_of_economy_and_tourism"
  }'`,
  upload: `curl --request POST \\
  --url https://api.ai7uae.com/service/uae_tlv \\
  --header 'Authorization: Bearer YOUR_AI7_API_KEY' \\
  --form 'license_document=@/path/to/trade-licence.pdf' \\
  --form 'emirate=dubai' \\
  --form 'authorising_body=dubai_department_of_economy_and_tourism'`,
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
      company_name: 'Example Trading LLC',
      emirate: 'dubai',
      authorising_body: 'dubai_department_of_economy_and_tourism'
    })
  }
);

const result = await response.json();`,
  python: `import requests

response = requests.post(
    "https://api.ai7uae.com/service/uae_tlv",
    headers={"Authorization": "Bearer YOUR_AI7_API_KEY"},
    json={
        "license_number": "123456",
        "company_name": "Example Trading LLC",
        "emirate": "dubai",
        "authorising_body": "dubai_department_of_economy_and_tourism",
    },
)

result = response.json()`
};

const sampleCode = document.querySelector('#sample-code');
const responseJson = document.querySelector('#response-json');
const responseStatus = document.querySelector('#response-status');
const form = document.querySelector('#api-form');
const sendButton = document.querySelector('#send-request');
const formError = document.querySelector('#form-error');
const requestFormat = document.querySelector('#request-format');
const documentHelp = document.querySelector('#document-help');

const humanise = (value) => value.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
const authoritySelect = document.querySelector('#authorising-body');
const authorityReference = document.querySelector('#authorising-values');

authorisingBodies.forEach((value) => {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = humanise(value);
  authoritySelect.append(option);

  const code = document.createElement('code');
  code.textContent = value;
  authorityReference.append(code);
});

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

requestFormat.addEventListener('change', () => {
  documentHelp.textContent = requestFormat.value === 'application/json'
    ? 'For JSON, the selected document is encoded as a data URI.'
    : 'For multipart, the selected document is uploaded as its original binary file.';
});

function readDocumentAsDataUri(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(new Error('document_read_failed')));
    reader.readAsDataURL(file);
  });
}

function requestValues() {
  return {
    license_number: document.querySelector('#license-number').value.trim(),
    licence_number: document.querySelector('#licence-number').value.trim(),
    company_name: document.querySelector('#company-name').value.trim(),
    emirate: document.querySelector('#emirate').value,
    authorising_body: authoritySelect.value
  };
}

async function buildRequest(format, values, documentFile) {
  if (format === 'multipart/form-data') {
    const body = new FormData();
    Object.entries(values).forEach(([name, value]) => { if (value) body.append(name, value); });
    if (documentFile) body.append('license_document', documentFile, documentFile.name);
    return { body, headers: {} };
  }

  const body = Object.fromEntries(Object.entries(values).filter(([, value]) => value));
  if (documentFile) body.license_document = await readDocumentAsDataUri(documentFile);
  return { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = document.querySelector('#api-key').value.trim();
  const documentFile = document.querySelector('#license-document').files[0];
  const values = requestValues();
  formError.textContent = '';

  if (!key) {
    formError.textContent = 'Enter your AI7 API key.';
    document.querySelector('#api-key').focus();
    return;
  }
  if (!values.license_number && !values.licence_number && !values.company_name && !documentFile) {
    formError.textContent = 'Provide at least one of license_number, licence_number, company_name, or license_document.';
    document.querySelector('#license-number').focus();
    return;
  }

  sendButton.disabled = true;
  responseStatus.className = '';
  responseStatus.textContent = 'Sending…';
  responseJson.textContent = '{\n  "message": "Request in progress…"\n}';

  try {
    const request = await buildRequest(requestFormat.value, values, documentFile);
    const response = await fetch('/service/uae_tlv', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, ...request.headers },
      body: request.body
    });
    const text = await response.text();
    let formatted = text;
    try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show raw response */ }
    responseJson.textContent = formatted;
    responseStatus.className = response.ok ? 'success' : 'error';
    responseStatus.textContent = `${response.status} ${response.statusText}`;
  } catch (error) {
    responseStatus.className = 'error';
    responseStatus.textContent = 'Request error';
    responseJson.textContent = JSON.stringify({
      status: 'Error',
      error: error.message === 'document_read_failed' ? 'The selected document could not be read.' : 'The request could not be sent.'
    }, null, 2);
  } finally {
    sendButton.disabled = false;
  }
});
