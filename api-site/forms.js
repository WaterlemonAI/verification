const byId = (id) => document.getElementById(id);
const formId = location.pathname.match(/^\/forms\/([a-z0-9-]+)\/?$/)?.[1] || '';
let formDefinition;

function inputFor(field) {
  const label = document.createElement('label');
  label.append(`${field.label} `);
  const code = document.createElement('code');
  code.textContent = field.key;
  label.append(code);
  let input;
  if (field.type === 'textarea') input = document.createElement('textarea');
  else if (field.type === 'select') {
    input = document.createElement('select');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Select an option';
    input.append(blank, ...field.options.map((option) => {
      const item = document.createElement('option');
      item.value = option;
      item.textContent = option;
      return item;
    }));
  } else if (field.type === 'boolean') {
    input = document.createElement('select');
    for (const [value, title] of [['', 'Select an option'], ['true', 'Yes'], ['false', 'No']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = title;
      input.append(option);
    }
  } else {
    input = document.createElement('input');
    input.type = field.type === 'country' ? 'text' : field.type;
    if (field.type === 'country') input.maxLength = 2;
  }
  input.id = `field-${field.key}`;
  input.name = field.key;
  input.required = field.required;
  input.placeholder = field.placeholder || '';
  label.append(input);
  if (field.description) {
    const help = document.createElement('small');
    help.className = 'field-help';
    help.textContent = field.description;
    label.append(help);
  }
  return label;
}

async function loadIndex() {
  const response = await fetch('/forms.json');
  const { forms } = await response.json();
  const list = byId('forms-list');
  if (!forms.length) {
    list.textContent = 'No public Forms are available yet.';
    return;
  }
  forms.forEach((form) => {
    const link = document.createElement('a');
    link.className = 'form-card';
    link.href = `/forms/${form.id}`;
    const eyebrow = document.createElement('span');
    eyebrow.textContent = `${form.services.length} API${form.services.length === 1 ? '' : 'S'}`;
    const title = document.createElement('strong');
    title.textContent = form.name;
    const description = document.createElement('p');
    description.textContent = form.description || 'Consolidated verification workflow.';
    const endpoint = document.createElement('code');
    endpoint.textContent = `/forms/${form.id}/submissions`;
    link.append(eyebrow, title, description, endpoint);
    list.append(link);
  });
}

async function loadForm() {
  const response = await fetch(`/forms/${formId}/schema`);
  if (!response.ok) throw new Error('This Form is unavailable or disabled.');
  const body = await response.json();
  formDefinition = body.form;
  byId('forms-index').hidden = true;
  byId('form-detail').hidden = false;
  byId('form-title').innerHTML = '';
  byId('form-title').append(document.createTextNode(formDefinition.name));
  byId('form-description').textContent = formDefinition.description || 'Consolidated verification workflow.';
  const endpoint = `${location.origin}/forms/${formDefinition.id}/submissions`;
  byId('endpoint').textContent = endpoint;
  byId('endpoint-meta').hidden = false;
  byId('copy-endpoint').addEventListener('click', () => navigator.clipboard.writeText(endpoint));
  const services = byId('service-list');
  formDefinition.services.forEach((service) => {
    const chip = document.createElement('span');
    chip.textContent = service.name;
    services.append(chip);
  });
  const sampleData = Object.fromEntries(formDefinition.fields.map((field) => [field.key,
    field.type === 'number' ? 1 : field.type === 'boolean' ? true : field.type === 'country' ? 'AE' : field.options?.[0] || `YOUR_${field.key.toUpperCase()}`
  ]));
  const sampleBody = JSON.stringify({ data: sampleData, callback_url: 'https://your-system.example/webhooks/ai7', customer_logo_url: 'https://your-domain.example/logo.png' }, null, 2);
  byId('form-curl').textContent = `curl -X POST '${endpoint}' \\\n  -H 'Authorization: Bearer YOUR_AI7_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  --data '${sampleBody}'`;
  byId('copy-form-curl').addEventListener('click', async () => {
    await navigator.clipboard.writeText(byId('form-curl').textContent);
    byId('copy-form-curl').textContent = 'Copied';
  });
  byId('dynamic-fields').append(...formDefinition.fields.map(inputFor));
}

byId('submission-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!formDefinition) return;
  byId('form-error').textContent = '';
  const button = byId('send-request');
  button.disabled = true;
  byId('response-status').className = '';
  byId('response-status').textContent = 'Submitting';
  const data = {};
  for (const field of formDefinition.fields) {
    const input = byId(`field-${field.key}`);
    if (input.value === '') continue;
    data[field.key] = field.type === 'number' ? Number(input.value) : field.type === 'boolean' ? input.value === 'true' : input.value;
  }
  try {
    const response = await fetch(`/forms/${formDefinition.id}/submissions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${byId('api-key').value.trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ data, callback_url: byId('callback-url').value.trim(), customer_logo_url: byId('logo-url').value.trim() })
    });
    const body = await response.json();
    byId('response-json').textContent = JSON.stringify(body, null, 2);
    byId('copy-response').disabled = false;
    byId('response-status').textContent = response.ok ? `Queued · HTTP ${response.status}` : `HTTP ${response.status}`;
    byId('response-status').className = response.ok ? 'success' : 'error';
    if (!response.ok) byId('form-error').textContent = body.error || 'The Form could not be submitted.';
  } catch {
    byId('form-error').textContent = 'The API could not be reached.';
    byId('response-status').textContent = 'Network error';
    byId('response-status').className = 'error';
  } finally { button.disabled = false; }
});

byId('copy-response').addEventListener('click', async () => {
  await navigator.clipboard.writeText(byId('response-json').textContent);
  byId('copy-response').textContent = 'Copied';
  setTimeout(() => { byId('copy-response').textContent = 'Copy JSON'; }, 1200);
});

(formId ? loadForm() : loadIndex()).catch((error) => {
  byId('forms-index').innerHTML = `<p class="form-error"></p>`;
  byId('forms-index').querySelector('p').textContent = error.message;
});
