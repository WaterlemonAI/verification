const samples = {
  curl: `curl --request POST 'https://api.ai7uae.com/service/entity_search' \\
  --header 'Authorization: Bearer YOUR_AI7_API_KEY' \\
  --header 'Content-Type: application/json' \\
  --data '{
    "name": "ENTITY NAME",
    "type": "Individual",
    "alias": [],
    "country": "AE",
    "identifier": [],
    "search_type": ["pep", "sanction", "watchlist"],
    "fields_weightage": [
      {"field": "name", "weightage": 1.0},
      {"field": "alias", "weightage": 0.0},
      {"field": "country", "weightage": 0.0},
      {"field": "dob", "weightage": 0.0},
      {"field": "address", "weightage": 0.0},
      {"field": "gender", "weightage": 0.0},
      {"field": "identifier", "weightage": 0.0}
    ],
    "fuzziness": 0.8
  }'`,
  javascript: `const response = await fetch(
  'https://api.ai7uae.com/service/entity_search',
  {
    method: 'POST',
    headers: {
      Authorization: 'Bearer YOUR_AI7_API_KEY',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'ENTITY NAME',
      type: 'Individual',
      alias: [],
      country: 'AE',
      identifier: [],
      search_type: ['pep', 'sanction', 'watchlist'],
      fields_weightage: [
        { field: 'name', weightage: 1.0 },
        { field: 'alias', weightage: 0.0 },
        { field: 'country', weightage: 0.0 },
        { field: 'dob', weightage: 0.0 },
        { field: 'address', weightage: 0.0 },
        { field: 'gender', weightage: 0.0 },
        { field: 'identifier', weightage: 0.0 }
      ],
      fuzziness: 0.8
    })
  }
);

const result = await response.json();`,
  python: `import requests

response = requests.post(
    "https://api.ai7uae.com/service/entity_search",
    headers={"Authorization": "Bearer YOUR_AI7_API_KEY"},
    json={
        "name": "ENTITY NAME",
        "type": "Individual",
        "alias": [],
        "country": "AE",
        "identifier": [],
        "search_type": ["pep", "sanction", "watchlist"],
        "fields_weightage": [
            {"field": "name", "weightage": 1.0},
            {"field": "alias", "weightage": 0.0},
            {"field": "country", "weightage": 0.0},
            {"field": "dob", "weightage": 0.0},
            {"field": "address", "weightage": 0.0},
            {"field": "gender", "weightage": 0.0},
            {"field": "identifier", "weightage": 0.0},
        ],
        "fuzziness": 0.8,
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
const responseFields = globalThis.ENTITY_SEARCH_RESPONSE_FIELDS || [];

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

function renderResponseFields(filter = '') {
  const query = filter.trim().toLowerCase();
  const filtered = responseFields.filter((field) => `${field.path} ${field.type} ${field.description}`.toLowerCase().includes(query));
  const table = byId('response-fields');
  table.querySelectorAll(':scope > div:not(.schema-head)').forEach((row) => row.remove());
  const fragment = document.createDocumentFragment();
  filtered.forEach((field) => {
    const row = document.createElement('div');
    const path = document.createElement('code');
    const type = document.createElement('span');
    const description = document.createElement('span');
    path.textContent = field.path;
    type.textContent = field.type;
    description.textContent = field.description || 'Documented response field or container.';
    row.append(path, type, description);
    fragment.append(row);
  });
  table.append(fragment);
  byId('schema-count').textContent = `${filtered.length} of ${responseFields.length} fields`;
}

renderResponseFields();
byId('schema-filter').addEventListener('input', (event) => renderResponseFields(event.currentTarget.value));

function commaStrings(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function integerList(value, label) {
  if (!value.trim()) return [];
  const values = commaStrings(value).map(Number);
  if (values.some((item) => !Number.isInteger(item))) throw new Error(`${label} must contain comma-separated integers.`);
  return values;
}

function optionalNumber(id) {
  const value = byId(id).value.trim();
  return value === '' ? undefined : Number(value);
}

function requestBody() {
  let identifiers;
  try { identifiers = JSON.parse(byId('identifier').value.trim() || '[]'); }
  catch { throw new Error('identifier must be a valid JSON array.'); }
  if (!Array.isArray(identifiers) || identifiers.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('identifier must be an array of objects containing type and value.');
  }

  const searchType = [...document.querySelectorAll('#search-types input:checked')].map((input) => input.value);
  if (!searchType.length) throw new Error('Select at least one search type.');
  if (searchType.includes('apc') && searchType.length !== 1) throw new Error('APC must be searched alone without additional checks.');
  if (searchType.includes('er_apc') && !searchType.some((value) => ['pep', 'sanction', 'watchlist'].includes(value))) {
    throw new Error('ER-APC requires PEP, sanction, or watchlist in the same search.');
  }

  const fieldsWeightage = [...document.querySelectorAll('.weight')].map((input) => ({
    field: input.dataset.field,
    weightage: Number(input.value)
  }));
  if (fieldsWeightage.some(({ weightage }) => !Number.isFinite(weightage) || weightage < 0 || weightage > 1)) {
    throw new Error('Every field weight must be between 0 and 1.');
  }
  const total = fieldsWeightage.reduce((sum, item) => sum + item.weightage, 0);
  if (Math.abs(total - 1) > 0.000001) throw new Error(`Field weights must total 1. Current total: ${total.toFixed(2)}.`);

  const fuzziness = Number(byId('fuzziness').value);
  if (!Number.isFinite(fuzziness) || fuzziness < 0 || fuzziness > 1) throw new Error('fuzziness must be between 0 and 1.');
  const apcDuration = optionalNumber('apc-duration');
  if (searchType.length === 1 && searchType[0] === 'apc' && (!Number.isInteger(apcDuration) || apcDuration < 1)) {
    throw new Error('apc_duration is required for an APC search and must be a positive integer.');
  }

  const body = {
    name: byId('name').value.trim(),
    type: byId('type').value,
    alias: commaStrings(byId('alias').value),
    country: byId('country').value.trim(),
    city: byId('city').value.trim(),
    state: byId('state').value.trim(),
    designation: byId('designation').value.trim(),
    gender: byId('gender').value.trim(),
    dob: byId('dob').value.trim(),
    identifier: identifiers,
    watchlist_list_ids: integerList(byId('watchlist-list-ids').value, 'watchlist_list_ids'),
    sanction_list_ids: integerList(byId('sanction-list-ids').value, 'sanction_list_ids'),
    search_type: searchType,
    fields_weightage: fieldsWeightage,
    fuzziness,
    event_stage_score: optionalNumber('event-stage-score'),
    sentiment_confidence: optionalNumber('sentiment-confidence'),
    apc_duration: apcDuration,
    apc_countries: byId('apc-countries').value.trim(),
    apc_sort_by: byId('apc-sort-by').value
  };

  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== '' && value !== undefined && (!Array.isArray(value) || value.length > 0)));
}

byId('entity-search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = byId('api-key').value.trim();
  formError.textContent = '';
  if (!key) { formError.textContent = 'Enter your AI7 API key.'; byId('api-key').focus(); return; }
  if (!byId('name').value.trim()) { formError.textContent = 'name is required.'; byId('name').focus(); return; }

  let body;
  try { body = requestBody(); }
  catch (error) { formError.textContent = error.message; return; }

  sendButton.disabled = true;
  responseStatus.className = '';
  responseStatus.textContent = 'Sending…';
  responseJson.textContent = '{\n  "message": "Request in progress…"\n}';
  try {
    const response = await fetch('/service/entity_search', {
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
