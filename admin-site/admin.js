let adminKey = '';
let integrationCatalog = [];
const byId = (id) => document.getElementById(id);

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${adminKey}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({ status: 'Error', error: 'Invalid server response.' }));
  if (!response.ok) throw new Error(body.error || `Request failed with ${response.status}.`);
  return body;
}

function setView(name) {
  document.querySelectorAll('aside nav button').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  byId('integrations-view').hidden = name !== 'integrations';
  byId('clients-view').hidden = name !== 'clients';
  byId('forms-view').hidden = name !== 'forms';
  byId('page-title').textContent = name === 'clients' ? 'Customer keys' : name === 'forms' ? 'Forms' : 'Integrations';
  name === 'clients' ? loadClients() : name === 'forms' ? loadForms() : loadIntegrations();
}

async function loadIntegrations() {
  const data = await request('/admin/api/integrations');
  integrationCatalog = data.integrations.filter((item) => item.enabled && item.id !== 'adverse-media-ai');
  const list = byId('integration-list');
  list.replaceChildren();
  byId('integration-empty').hidden = data.integrations.length > 0;
  byId('integration-count').textContent = data.integrations.length;
  byId('active-count').textContent = data.integrations.filter((item) => item.enabled).length;
  data.integrations.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'route';
    row.innerHTML = `<span class="method"></span><div><strong></strong><small></small></div><code></code><span class="pill"></span><button class="set-credential"></button>`;
    row.querySelector('.method').textContent = item.method;
    row.querySelector('strong').textContent = item.name;
    row.querySelector('small').textContent = item.id;
    row.querySelector('code').textContent = item.publicPath;
    const pill = row.querySelector('.pill');
    pill.textContent = item.enabled ? 'Active' : 'Disabled';
    pill.classList.toggle('off', !item.enabled);
    const credentialButton = row.querySelector('.set-credential');
    credentialButton.hidden = item.id === 'merchant-screening';
    credentialButton.textContent = item.masterAuthKeyConfigured ? 'Replace credential' : 'Set credential';
    credentialButton.addEventListener('click', () => {
      const form = byId('supplier-credential-form');
      form.reset();
      form.elements.id.value = item.id;
      byId('supplier-credential-name').textContent = item.name;
      byId('supplier-credential-error').textContent = '';
      const isIban = item.id === 'iban-verification';
      const isEntitySearch = item.id === 'entity-search';
      const isAdverseMedia = item.id === 'adverse-media';
      const isAdverseMediaAi = item.id === 'adverse-media-ai';
      byId('supplier-credential-label').firstChild.textContent = isIban ? 'Supplier username' : (isEntitySearch || isAdverseMedia || isAdverseMediaAi) ? 'Private API key' : 'Supplier credential';
      form.elements.credential.placeholder = isIban ? 'Enter the supplier username' : (isEntitySearch || isAdverseMedia || isAdverseMediaAi) ? 'Enter the private API key' : 'Enter the private credential';
      byId('supplier-credential-help').textContent = isIban
        ? 'The supplied IBAN collection authenticates each internal request with this username header; it does not transmit a password.'
        : isEntitySearch
          ? 'This write-only API key is applied internally to comprehensive entity-search requests.'
          : isAdverseMedia
            ? 'This write-only search credential is applied only to adverse-media screening requests.'
          : isAdverseMediaAi
            ? 'This write-only Google AI API key enables bounded AI classification for adverse-media results. The key is never returned or shown again.'
        : 'The existing value cannot be viewed and will be replaced only after you save.';
      byId('supplier-credential-dialog').showModal();
    });
    list.append(row);
  });
}

function formExamples() {
  const preferred = integrationCatalog.find((item) => item.id === 'uae-trade-licence') || integrationCatalog[0];
  const service = preferred
    ? [{
      service_id: preferred.id,
      input_template: preferred.id === 'adverse-media'
        ? { entity_type: 'business', name: '{{company_name}}' }
        : { company_name: '{{company_name}}' }
    }]
    : [];
  return {
    fields: [{ key: 'company_name', label: 'Company name', type: 'text', required: true, description: 'Registered legal or trading name.' }],
    services: service
  };
}

function openFormDialog(item) {
  const form = byId('form-form');
  form.reset();
  const examples = formExamples();
  form.elements.id.value = item?.id || '';
  form.elements.id.readOnly = Boolean(item);
  form.elements.name.value = item?.name || '';
  form.elements.description.value = item?.description || '';
  form.elements.default_logo_url.value = item?.default_logo_url || '';
  form.elements.fields.value = JSON.stringify(item?.fields || examples.fields, null, 2);
  form.elements.services.value = JSON.stringify(item?.services || examples.services, null, 2);
  form.elements.enabled.checked = item?.enabled !== false;
  byId('form-error').textContent = '';
  byId('form-dialog').showModal();
}

async function loadForms() {
  if (!integrationCatalog.length) {
    const catalog = await request('/admin/api/integrations');
    integrationCatalog = catalog.integrations.filter((item) => item.enabled && item.id !== 'adverse-media-ai');
  }
  const data = await request('/admin/api/forms');
  const list = byId('form-list');
  list.replaceChildren();
  byId('form-empty').hidden = data.forms.length > 0;
  byId('form-count').textContent = data.forms.length;
  byId('active-form-count').textContent = data.forms.filter((item) => item.enabled).length;
  data.forms.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'form-row';
    row.innerHTML = '<div><strong></strong><small></small></div><code></code><span class="pill"></span><button class="secondary edit-form">Edit</button><a class="open-form" target="_blank" rel="noopener">Open</a>';
    row.querySelector('strong').textContent = item.name;
    row.querySelector('small').textContent = `${item.services.length} APIs · ${item.fields.length} fields · version ${item.version}`;
    row.querySelector('code').textContent = `/forms/${item.id}/submissions`;
    const pill = row.querySelector('.pill');
    pill.textContent = item.enabled ? 'Active' : 'Disabled';
    pill.classList.toggle('off', !item.enabled);
    row.querySelector('.edit-form').addEventListener('click', () => openFormDialog(item));
    const open = row.querySelector('.open-form');
    open.href = `/forms/${item.id}`;
    open.textContent = 'Open Form';
    list.append(row);
  });
}

async function loadClients() {
  const data = await request('/admin/api/clients');
  const list = byId('client-list');
  list.replaceChildren();
  byId('client-empty').hidden = data.clients.length > 0;
  byId('client-count').textContent = data.clients.length;
  byId('active-client-count').textContent = data.clients.filter((item) => item.status === 'active').length;
  data.clients.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'client';
    row.innerHTML = `<div><strong></strong><small></small></div><span class="pill"></span><small></small><button class="revoke">Revoke</button>`;
    row.querySelector('strong').textContent = item.name;
    row.querySelector('div small').textContent = `•••• ${item.lastFour}`;
    const pill = row.querySelector('.pill');
    pill.textContent = item.status;
    pill.classList.toggle('off', item.status !== 'active');
    row.querySelector(':scope > small').textContent = new Date(item.createdAt).toLocaleDateString();
    const revoke = row.querySelector('.revoke');
    revoke.hidden = item.status !== 'active';
    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      try { await request(`/admin/api/clients/${item.id}/revoke`, { method: 'POST' }); await loadClients(); }
      catch (error) { revoke.disabled = false; window.alert(error.message); }
    });
    list.append(row);
  });
}

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  byId('login-error').textContent = '';
  adminKey = byId('admin-key').value.trim();
  try {
    await loadIntegrations();
    byId('admin-key').value = '';
    byId('login-view').hidden = true;
    byId('app-view').hidden = false;
  } catch {
    adminKey = '';
    byId('login-error').textContent = 'The admin key is missing or incorrect.';
  }
});

document.querySelectorAll('aside nav button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
document.querySelectorAll('[data-refresh]').forEach((button) => button.addEventListener('click', () => button.dataset.refresh === 'clients' ? loadClients() : button.dataset.refresh === 'forms' ? loadForms() : loadIntegrations()));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => byId(button.dataset.close).close()));
byId('new-integration').addEventListener('click', () => byId('integration-dialog').showModal());
byId('new-form').addEventListener('click', () => openFormDialog());
byId('new-client').addEventListener('click', () => byId('client-dialog').showModal());
byId('sign-out').addEventListener('click', () => { adminKey = ''; byId('app-view').hidden = true; byId('login-view').hidden = false; });

byId('integration-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  values.acceptedContentTypes = values.acceptedContentTypes.split(',').map((item) => item.trim()).filter(Boolean);
  values.documentedStatuses = values.documentedStatuses.split(',').map((item) => Number(item.trim())).filter(Boolean);
  values.enabled = form.elements.enabled.checked;
  byId('integration-error').textContent = '';
  try {
    await request(`/admin/api/integrations/${values.id}`, { method: 'PUT', body: JSON.stringify(values) });
    form.reset();
    form.elements.publicPath.value = '/service/';
    form.elements.authHeader.value = 'authorization';
    form.elements.authPrefix.value = 'Bearer ';
    form.elements.adapter.value = 'passthrough';
    form.elements.acceptedContentTypes.value = 'application/json';
    form.elements.documentedStatuses.value = '200,400,401,422,500';
    form.elements.enabled.checked = true;
    byId('integration-dialog').close();
    await loadIntegrations();
  } catch (error) { byId('integration-error').textContent = error.message; }
});

byId('supplier-credential-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  byId('supplier-credential-error').textContent = '';
  try {
    await request(`/admin/api/integrations/${id}/credential`, {
      method: 'PUT', body: JSON.stringify({ credential: form.elements.credential.value })
    });
    form.reset();
    byId('supplier-credential-dialog').close();
    await loadIntegrations();
  } catch (error) { byId('supplier-credential-error').textContent = error.message; }
});

byId('client-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  byId('client-error').textContent = '';
  try {
    const result = await request('/admin/api/clients', { method: 'POST', body: JSON.stringify({ name: form.elements.name.value }) });
    form.reset();
    byId('client-dialog').close();
    byId('new-credential').textContent = result.apiKey;
    byId('credential-dialog').showModal();
    await loadClients();
  } catch (error) { byId('client-error').textContent = error.message; }
});

byId('form-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  byId('form-error').textContent = '';
  try {
    const body = {
      name: form.elements.name.value,
      description: form.elements.description.value,
      default_logo_url: form.elements.default_logo_url.value,
      fields: JSON.parse(form.elements.fields.value),
      services: JSON.parse(form.elements.services.value),
      enabled: form.elements.enabled.checked
    };
    await request(`/admin/api/forms/${form.elements.id.value}`, { method: 'PUT', body: JSON.stringify(body) });
    byId('form-dialog').close();
    await loadForms();
  } catch (error) {
    byId('form-error').textContent = error instanceof SyntaxError ? 'Fields and APIs must contain valid JSON.' : error.message;
  }
});

byId('copy-credential').addEventListener('click', async () => {
  await navigator.clipboard.writeText(byId('new-credential').textContent);
  byId('copy-credential').textContent = 'Copied';
});
byId('close-credential').addEventListener('click', () => { byId('new-credential').textContent = ''; byId('copy-credential').textContent = 'Copy'; byId('credential-dialog').close(); });
