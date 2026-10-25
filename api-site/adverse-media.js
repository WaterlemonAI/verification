const samples = {
  curl: `curl --request POST \\
  --url https://api.ai7uae.com/service/adverse_media \\
  --header 'Authorization: Bearer YOUR_AI7_API_KEY' \\
  --header 'Content-Type: application/json' \\
  --data '{
    "entity_type": "individual",
    "name": "ENTITY NAME",
    "aliases": ["ALTERNATE NAME"],
    "countries": ["AE"],
    "languages": ["en", "ar"],
    "date_from": "2023-01-01",
    "max_results": 25
  }'`,
  javascript: `const response = await fetch(
  'https://api.ai7uae.com/service/adverse_media',
  {
    method: 'POST',
    headers: {
      Authorization: 'Bearer YOUR_AI7_API_KEY',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      entity_type: 'individual',
      name: 'ENTITY NAME',
      aliases: ['ALTERNATE NAME'],
      countries: ['AE'],
      languages: ['en', 'ar'],
      date_from: '2023-01-01',
      max_results: 25
    })
  }
);

const result = await response.json();`,
  python: `import requests

response = requests.post(
    "https://api.ai7uae.com/service/adverse_media",
    headers={"Authorization": "Bearer YOUR_AI7_API_KEY"},
    json={
        "entity_type": "individual",
        "name": "ENTITY NAME",
        "aliases": ["ALTERNATE NAME"],
        "countries": ["AE"],
        "languages": ["en", "ar"],
        "date_from": "2023-01-01",
        "max_results": 25,
    },
)

result = response.json()`
};

const byId = (id) => document.getElementById(id);
const sampleCode = byId('sample-code');
const responseJson = byId('response-json');
const responseStatus = byId('response-status');
const copyResponse = byId('copy-response');
const sendButton = byId('send-request');
const formError = byId('form-error');

const regionPresets = {
  gulf: { countries: ['AE', 'SA', 'QA', 'KW', 'BH', 'OM'], languages: ['en', 'ar'] },
  india: { countries: ['IN'], languages: ['en', 'hi'] },
  usa: { countries: ['US'], languages: ['en'] },
  anz: { countries: ['AU', 'NZ'], languages: ['en'] },
  china: { countries: ['CN'], languages: ['zh'] },
  russia: { countries: ['RU'], languages: ['ru'] }
};
const autoRegionCountries = new Set();
const autoRegionLanguages = new Set();

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
copyResponse.addEventListener('click', (event) => copyText(responseJson.textContent, event.currentTarget));

function commaList(value) {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function applyRegionPresets(changedInput) {
  const selected = [...document.querySelectorAll('#regions input:checked')]
    .map((input) => regionPresets[input.value]);
  const requiredLanguages = new Set(selected.flatMap((preset) => preset.languages));
  const checkedLanguages = new Set([...document.querySelectorAll('#languages input:checked')].map((input) => input.value));
  const manualLanguages = new Set([...checkedLanguages].filter((language) => !autoRegionLanguages.has(language)));
  const nextLanguages = new Set([...manualLanguages, ...requiredLanguages]);
  if (nextLanguages.size > 5 && changedInput) {
    changedInput.checked = false;
    formError.textContent = 'That preset would exceed the five-language limit. Uncheck another language first.';
    applyRegionPresets();
    return;
  }

  document.querySelectorAll('#languages input').forEach((input) => { input.checked = nextLanguages.has(input.value); });
  autoRegionLanguages.clear();
  requiredLanguages.forEach((language) => {
    if (!manualLanguages.has(language)) autoRegionLanguages.add(language);
  });

  const currentCountries = commaList(byId('countries').value).map((country) => country.toUpperCase());
  const manualCountries = currentCountries.filter((country) => !autoRegionCountries.has(country));
  const requiredCountries = [...new Set(selected.flatMap((preset) => preset.countries))];
  byId('countries').value = [...new Set([...manualCountries, ...requiredCountries])].join(', ');
  autoRegionCountries.clear();
  requiredCountries.forEach((country) => autoRegionCountries.add(country));
}

function requestBody() {
  const languages = [...document.querySelectorAll('#languages input:checked')].map((input) => input.value);
  if (!languages.length) throw new Error('Select at least one language.');
  if (languages.length > 5) throw new Error('Select no more than five languages.');
  const countries = commaList(byId('countries').value).map((value) => value.toUpperCase());
  if (countries.some((value) => !/^[A-Z]{2}$/.test(value))) throw new Error('Countries must use two-letter ISO codes such as AE or GB.');
  if (countries.length > 20) throw new Error('Select no more than 20 countries.');
  const maxResults = Number(byId('max-results').value);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) throw new Error('Maximum results must be from 1 to 50.');

  const body = {
    entity_type: byId('entity-type').value,
    name: byId('name').value.trim(),
    aliases: commaList(byId('aliases').value),
    countries,
    languages,
    date_from: byId('date-from').value,
    date_to: byId('date-to').value,
    max_results: maxResults
  };
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== '' && (!Array.isArray(value) || value.length)));
}

byId('regions').addEventListener('change', (event) => {
  formError.textContent = '';
  applyRegionPresets(event.target);
});

byId('languages').addEventListener('change', (event) => {
  if (!event.target.checked && autoRegionLanguages.has(event.target.value)) {
    event.target.checked = true;
    formError.textContent = 'That language is required by a selected regional preset.';
    return;
  }
  const checked = [...document.querySelectorAll('#languages input:checked')];
  if (checked.length > 5) {
    event.target.checked = false;
    formError.textContent = 'A maximum of five languages can be searched per check.';
  } else {
    formError.textContent = '';
  }
});

byId('adverse-media-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = byId('api-key').value.trim();
  formError.textContent = '';
  if (!key) { formError.textContent = 'Enter your AI7 API key.'; byId('api-key').focus(); return; }
  if (byId('name').value.trim().length < 2) { formError.textContent = 'Enter the full individual or business name.'; byId('name').focus(); return; }

  let body;
  try { body = requestBody(); }
  catch (error) { formError.textContent = error.message; return; }

  sendButton.disabled = true;
  copyResponse.disabled = true;
  responseStatus.className = '';
  responseStatus.textContent = 'Searching…';
  responseJson.textContent = JSON.stringify({ status: 'pending', request: body }, null, 2);
  responseJson.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const response = await fetch('/service/adverse_media', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let formatted = text;
    try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch { /* display raw response */ }
    responseJson.textContent = formatted;
    copyResponse.disabled = false;
    responseStatus.className = response.ok ? 'success' : 'error';
    responseStatus.textContent = `${response.status} ${response.statusText}`;
  } catch {
    responseStatus.className = 'error';
    responseStatus.textContent = 'Request error';
    responseJson.textContent = JSON.stringify({ status: 'Error', error: 'The request could not be sent.' }, null, 2);
    copyResponse.disabled = false;
  } finally {
    sendButton.disabled = false;
  }
});
