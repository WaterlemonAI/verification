let csrfToken = '';
let pendingAdminLogin = null;
let integrationCatalog = [];
const byId = (id) => document.getElementById(id);

function confirmExternalLink(event) {
  const link = event.target.closest?.('a[href]');
  if (!link || event.defaultPrevented) return;
  const destination = new URL(link.href);
  if (!['http:', 'https:'].includes(destination.protocol) || destination.origin === location.origin) return;
  if (!window.confirm(`You will be redirected to ${destination.hostname} website. Continue?`)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
document.addEventListener('click', confirmExternalLink, true);
document.addEventListener('auxclick', confirmExternalLink, true);

for (const input of document.querySelectorAll('#login-view input[type="password"]')) {
  const field = document.createElement('span');
  field.className = 'password-field';
  input.before(field);
  field.append(input);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'password-toggle';
  toggle.textContent = 'Show';
  toggle.setAttribute('aria-label', 'Show password');
  toggle.addEventListener('click', () => {
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    toggle.textContent = visible ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} password`);
  });
  field.append(toggle);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(!['GET', 'HEAD'].includes(options.method || 'GET') && csrfToken ? { 'x-ai7-csrf': csrfToken } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({ status: 'Error', error: 'Invalid server response.' }));
  if (response.status === 401 && !path.includes('/auth/')) showSignedOut();
  if (!response.ok) throw new Error(body.error || `Request failed with ${response.status}.`);
  return body;
}

function showSignedOut() {
  csrfToken = '';
  byId('app-view').hidden = true;
  byId('login-view').hidden = false;
  byId('signin-card').hidden = false;
  byId('code-card').hidden = true;
  byId('setup-card').hidden = true;
  byId('forgot-card').hidden = true;
  byId('reset-card').hidden = true;
}

async function showApp(auth) {
  csrfToken = auth.csrf_token;
  byId('account-email').textContent = auth.account.email;
  byId('login-view').hidden = true;
  byId('app-view').hidden = false;
  await loadIntegrations();
  const linkedAnalysis = new URLSearchParams(location.search).get('analysis');
  if (/^bsa_[0-9a-fA-F-]{36}$/.test(linkedAnalysis || '')) {
    setView('analysis');
    byId('bsa-lookup-id').value = linkedAnalysis;
    pollBsaResult(`/admin/api/bsa/${linkedAnalysis}/result`).catch(error => {
      byId('bsa-message').textContent = error.message || 'Unable to open analysis.';
    });
  }
}

async function bootstrapAuth() {
  try {
    const status = await request('/admin/api/auth/status');
    byId('setup-card').hidden = status.configured;
    byId('signin-card').hidden = !status.configured;
    if (!status.configured) return;
    if (new URLSearchParams(location.search).has('reset')) {
      byId('signin-card').hidden = true;
      byId('reset-card').hidden = false;
      return;
    }
    const session = await request('/admin/api/auth/session');
    if (session.account) await showApp(session);
  } catch {
    showSignedOut();
  }
}

function setView(name) {
  document.querySelectorAll('aside nav button').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  byId('integrations-view').hidden = name !== 'integrations';
  byId('clients-view').hidden = name !== 'clients';
  byId('forms-view').hidden = name !== 'forms';
  byId('analysis-view').hidden = name !== 'analysis';
  byId('page-title').textContent = name === 'clients' ? 'Customer keys' : name === 'forms' ? 'Forms' : name === 'analysis' ? 'Analysis' : 'Integrations';
  if (name === 'clients') loadClients();
  else if (name === 'forms') loadForms();
  else if (name === 'analysis') loadBsaAvailability();
  else if (name === 'integrations') loadIntegrations();
}

async function loadBsaAvailability() {
  const container = byId('bsa-capabilities');
  container.replaceChildren();
  try {
    const config = await request('/admin/api/bsa/config');
    const engines = config.engines || {};
    for (const [key, label] of [['native', 'Native PDF'], ['rapidocr', 'Private OCR'], ['paddleocr', 'PaddleOCR'], ['azureLayout', 'Azure Layout']]) {
      const state = engines[key] || 'unavailable';
      const card = bsaElement('div', '', `bsa-engine ${state}`);
      card.append(bsaElement('strong', label), bsaElement('span', state.replaceAll('_', ' ')));
      container.append(card);
    }
    byId('bsa-form').querySelector('button[type=submit]').disabled = !config.enabled;
    byId('bsa-message').textContent = config.enabled
      ? 'Ready to analyze. Pages that cannot be reliably read will be flagged for review.'
      : 'Analysis worker is unavailable.';
  } catch (error) {
    byId('bsa-form').querySelector('button[type=submit]').disabled = true;
    byId('bsa-message').textContent = error.message || 'Unable to check analysis engines.';
  }
}

async function bsaRequest(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers: { ...(!['GET', 'HEAD'].includes(options.method || 'GET') && csrfToken ? { 'x-ai7-csrf': csrfToken } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.reasonCode || body.error || `Request failed with ${response.status}.`);
  return { body, status: response.status };
}

function bsaElement(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = String(value);
  if (className) element.className = className;
  return element;
}

function bsaCard(containerId, title, details) {
  const card = bsaElement('article', '', 'bsa-data-card');
  card.append(bsaElement('strong', title));
  for (const detail of details) if (detail) card.append(bsaElement('p', detail));
  byId(containerId).append(card);
}

function bsaItems(containerId, title, items) {
  if (!items?.length) return;
  bsaCard(containerId, title, items.map(item => typeof item === 'string' ? item : JSON.stringify(item)));
}

function bsaMoney(value, currency = '') {
  const amount = Number(value?.value ?? value);
  return Number.isFinite(amount) ? `${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency || value?.currency || ''}`.trim() : '—';
}

function bsaTable(containerId, headers, rows) {
  const wrap = bsaElement('div', '', 'bsa-table-wrap');
  const table = document.createElement('table'); table.className = 'bsa-table';
  const head = document.createElement('thead'); const heading = document.createElement('tr');
  headers.forEach(label => heading.append(bsaElement('th', label))); head.append(heading); table.append(head);
  const body = document.createElement('tbody');
  rows.forEach(values => { const tr = document.createElement('tr'); values.forEach(value => tr.append(bsaElement('td', value ?? '—'))); body.append(tr); });
  table.append(body); wrap.append(table); byId(containerId).append(wrap);
}

function renderBsa(result) {
  byId('bsa-result').hidden = false;
  for (const id of ['bsa-summary', 'bsa-coverage', 'bsa-reasons', 'bsa-ledgers', 'bsa-transactions', 'bsa-features', 'bsa-liquidity', 'bsa-signals', 'bsa-models', 'bsa-artifacts']) byId(id).replaceChildren();
  byId('bsa-result-title').textContent = `Analysis ${result.status}`;
  byId('bsa-result-id').textContent = result.analysisId || '';
  for (const [value, label] of [[result.status, 'Processing status'], [result.coverage?.pageCount || 0, 'Pages'],
    [result.coverage?.transactionCount || 0, 'Unique transactions'], [result.transfers?.length || 0, 'Paired transfers'],
    [result.observedObligations?.length || 0, 'Observed obligations'],
    [result.decisionEligible ? 'Yes' : 'No', 'Decision eligible'],
    [`${(result.segments || []).filter(segment => segment.reconciliation?.status === 'fully_reconciled').length}/${result.segments?.length || 0}`, 'Reconciled ledgers']]) {
    const card = bsaElement('div', '');
    card.append(bsaElement('strong', value), bsaElement('span', label));
    byId('bsa-summary').append(card);
  }
  for (const reason of result.reasonCodes || []) byId('bsa-reasons').append(bsaElement('span', reason, 'bsa-reason'));
  if (!result.reasonCodes?.length) byId('bsa-reasons').append(bsaElement('span', 'No blocking reason codes'));
  bsaCard('bsa-coverage', 'Coverage', [`${result.coverage?.pageCount || 0} pages inspected; ${result.coverage?.transactionCount || 0} unique transactions extracted.`, `${result.coverage?.unsupportedPages?.length || 0} pages need manual review.`, `Extractor: ${result.versions?.extractor || result.extractorVersion || 'see source evidence'}`]);
  bsaCard('bsa-coverage', 'Quality', [`${result.quality?.reconciledSegments || 0} of ${result.segments?.length || 0} ledgers reconcile.`, ...(result.limitations || [])]);
  for (const segment of result.segments || []) {
    const ledger = bsaElement('div', '', 'bsa-ledger');
    const left = bsaElement('div', `${segment.bankId} · ${segment.accountNumberMasked} · ${segment.currency}`);
    left.append(bsaElement('small', `${segment.periodStart} to ${segment.periodEnd} · ${segment.productType} · ${segment.ownershipType}`));
    const right = bsaElement('div', `${bsaMoney(segment.openingBalance, segment.currency)} → ${bsaMoney(segment.closingBalance, segment.currency)}`);
    right.append(bsaElement('small', `Ledger: ${segment.reconciliation?.status?.replaceAll('_', ' ') || 'unknown'} · ${segment.transactions?.length || 0} rows`));
    ledger.append(left, right);
    byId('bsa-ledgers').append(ledger);
  }
  for (const stream of result.features?.salaryStreams || []) {
    byId('bsa-features').append(bsaElement('p', `${stream.observedPayer}: ${stream.candidateMonthlyAmount.value} ${stream.currency} · ${stream.months.length} months · ${stream.stable ? 'stable candidate' : 'insufficient history'}`));
  }
  byId('bsa-features').append(bsaElement('p', `${result.transfers?.length || 0} paired transfers excluded from income; ${result.duplicates?.length || 0} duplicate rows removed.`));
  const accountLabels = new Map((result.accounts || []).map(item => [item.accountId, `${item.bankId} · ${item.accountNumberMasked}`]));
  bsaCard('bsa-features', 'How to read cash flow', ['Candidate external credits are observed deposits, not verified income. Non-transfer debits subtract paired transfers. Residual is credits minus non-transfer debits. A savings account funded by internal transfers can show a negative residual without a borrower-wide deficit. Each row stays within one account and currency.']);
  bsaTable('bsa-features', ['Account', 'Month', 'Currency', 'Candidate credits', 'Non-transfer debits', 'Residual'], (result.monthlyCashFlow || []).map(row => {
    const credit = Number(row.candidateExternalCredits?.value || 0);
    const debit = Number(row.grossDebits?.value || 0) - Number(row.selfTransferDebits?.value || 0);
    return [accountLabels.get(row.accountId) || row.accountId, row.month, row.currency, bsaMoney(credit), bsaMoney(debit), bsaMoney(credit - debit)];
  }));
  for (const item of result.liquidity || []) byId('bsa-liquidity').append(bsaElement('p', `${accountLabels.get(item.accountId) || 'Account'} · ${item.currency}: average ${item.averageDailyBalance.value}, minimum ${item.minimumDailyBalance.value}, negative days ${item.negativeBalanceDays}`));
  bsaCard('bsa-liquidity', 'Observed obligations', (result.observedObligations || []).map(item => `${item.category?.replaceAll('_', ' ')}: ${bsaMoney(item.typicalAmount, item.currency)} typical payment; ${item.paymentCount} observed payments.`));
  bsaCard('bsa-signals', 'Review rules', ['Priorities order manual review; they do not determine fraud or eligibility. Each pattern gives a recommended check and source IDs in the JSON.']);
  for (const item of result.creditAssessment?.riskHighlights || []) {
    const card = bsaElement('article', '', `bsa-data-card bsa-risk ${item.reviewPriority || 'info'}`);
    card.append(bsaElement('span', (item.reviewPriority || 'info').toUpperCase(), 'bsa-risk-priority'),
      bsaElement('strong', item.title), bsaElement('p', item.explanation),
      bsaElement('p', `Check: ${item.suggestedReview}`));
    if (item.accountId) card.append(bsaElement('small', `${accountLabels.get(item.accountId) || item.accountId} · ${item.currency || ''}`));
    byId('bsa-signals').append(card);
  }
  if (result.transfers?.length) bsaCard('bsa-signals', 'Excluded paired transfers', [`${result.transfers.length} matching transfers were kept in the ledger and excluded from candidate income.`]);
  for (const model of result.creditAssessment?.models || []) {
    const observations = model.observations || [];
    const details = [`Formula: ${model.formula}`, `Status: ${model.status.replaceAll('_', ' ')}`];
    for (const item of observations) {
      const observed = !item.value ? 'Not calculable' : item.value.unit === 'ratio'
        ? `${(Number(item.value.value) * 100).toFixed(1)}%` : bsaMoney(item.value.value, item.value.unit);
      details.push(`${accountLabels.get(item.accountId) || item.accountId} · ${item.currency}: ${observed} · ${item.months?.length || 0} complete months`);
    }
    details.push(`Limit: ${model.limitation}`);
    bsaCard('bsa-models', model.name, details);
  }
  const transactions = (result.segments || []).flatMap(segment => segment.transactions || []);
  for (const item of transactions.slice(0, 200)) bsaCard('bsa-transactions', `${item.bookingDate} · ${item.creditDebitIndicator} ${item.ledgerAmount?.value} ${item.ledgerCurrency}`, [item.descriptionRaw, `Balance ${item.runningBalance?.value}`, item.referenceRaw]);
  if (transactions.length > 200) byId('bsa-transactions').append(bsaElement('p', `Showing 200 of ${transactions.length} transactions. Download the workbook or Parquet export for all rows.`));
  for (const item of result.artifacts || []) {
    const button = bsaElement('button', `Download ${item.filename}`, 'bsa-export');
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const response = await fetch(item.downloadUrl, { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Export download failed.');
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a'); link.href = url; link.download = item.filename; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (error) { byId('bsa-message').textContent = error.message; }
      finally { button.disabled = false; }
    });
    byId('bsa-artifacts').append(button);
  }
  if (result.artifacts?.some(item => item.filename === 'analysis.xlsx')) {
    const linkButton = bsaElement('button', 'Copy private analysis link', 'bsa-export');
    linkButton.type = 'button';
    linkButton.addEventListener('click', async () => {
      await navigator.clipboard.writeText(`${location.origin}/admin?analysis=${encodeURIComponent(result.analysisId)}`);
      linkButton.textContent = 'Private link copied';
    });
    byId('bsa-artifacts').append(linkButton);
  }
  byId('bsa-raw').textContent = JSON.stringify(result, null, 2);
}

async function loadIntegrations() {
  const data = await request('/admin/api/integrations');
  integrationCatalog = data.integrations.filter((item) => item.enabled && item.formsCompatible !== false && item.id !== 'adverse-media-ai');
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
    credentialButton.hidden = item.id === 'merchant-screening' || (item.id !== 'document-ocr-ai' && item.id.endsWith('-ocr')) || item.id === 'moa-analysis';
    credentialButton.textContent = item.id === 'ejari-verification' ? 'Configure Ejari'
      : item.masterAuthKeyConfigured ? 'Replace credential' : 'Set credential';
    credentialButton.addEventListener('click', () => {
      if (item.id === 'ejari-verification') {
        byId('ejari-setup-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
        byId('ejari-config-form').elements.openai_key.focus({ preventScroll: true });
        return;
      }
      const form = byId('supplier-credential-form');
      form.reset();
      form.elements.id.value = item.id;
      byId('supplier-credential-name').textContent = item.name;
      byId('supplier-credential-error').textContent = '';
      const isIban = item.id === 'iban-verification';
      const isEntitySearch = item.id === 'entity-search';
      const isAdverseMedia = item.id === 'adverse-media';
      const isAdverseMediaAi = item.id === 'adverse-media-ai';
      const isDocumentOcrAi = item.id === 'document-ocr-ai';
      byId('supplier-credential-label').firstChild.textContent = isIban ? 'Supplier username' : (isEntitySearch || isAdverseMedia || isAdverseMediaAi || isDocumentOcrAi) ? 'Private API key' : 'Supplier credential';
      form.elements.credential.placeholder = isIban ? 'Enter the supplier username' : (isEntitySearch || isAdverseMedia || isAdverseMediaAi || isDocumentOcrAi) ? 'Enter the private API key' : 'Enter the private credential';
      byId('supplier-credential-help').textContent = isIban
        ? 'The supplied IBAN collection authenticates each internal request with this username header; it does not transmit a password.'
        : isEntitySearch
          ? 'This write-only API key is applied internally to comprehensive entity-search requests.'
          : isAdverseMedia
            ? 'This write-only search credential is applied only to adverse-media screening requests.'
          : isAdverseMediaAi
            ? 'This write-only Google AI API key enables bounded AI classification for adverse-media results. The key is never returned or shown again.'
          : isDocumentOcrAi
            ? 'Use the dedicated document OCR ai7edd model key. It is applied only after malware scanning and Azure OCR complete, and is never shown again.'
        : 'The existing value cannot be viewed and will be replaced only after you save.';
      byId('supplier-credential-dialog').showModal();
    });
    list.append(row);
  });
  await loadEjariConfig();
}

async function loadEjariConfig() {
  const form = byId('ejari-config-form');
  const status = byId('ejari-config-status');
  try {
    const data = await request('/admin/api/ejari/config');
    form.elements.ocr_model.value = data.config.ocr_model || 'gpt-6-luna';
    form.elements.ocr_detail.value = data.config.ocr_detail || 'high';
    form.elements.enabled.checked = data.config.enabled === true;
    form.elements.enabled.disabled = !data.platformAvailable;
    status.textContent = `Azure worker: ${data.platformAvailable ? 'ready' : 'not deployed'} · OpenAI key: ${data.config.openaiKeyConfigured ? 'saved' : 'needed'} · CapSolver key: ${data.config.capsolverKeyConfigured ? 'saved' : 'needed'}`;
  } catch (error) { status.textContent = error.message || 'Ejari setup could not be loaded.'; }
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

function parseTierLines(value) {
  const lines = value.split(/\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  return lines.map((line) => {
    const match = /^(\*|[1-9]\d*)\s*:\s*((?:0|[1-9]\d*)(?:\.\d{1,6})?)$/.exec(line);
    if (!match) throw new Error('Use tiers like 10000:0.10, then *:0.06 on the final line.');
    return { up_to: match[1] === '*' ? null : Number(match[1]), price: match[2] };
  });
}

async function openUsageDialog(customer) {
  const [data, catalog] = await Promise.all([
    request(`/admin/api/customers/${customer.id}/usage`), request('/admin/api/modules')
  ]);
  const form = byId('usage-form');
  form.elements.workspace_id.value = customer.id;
  form.elements.mode.value = data.account.mode;
  form.elements.currency.value = data.account.currency;
  byId('usage-title').textContent = `${customer.name} · access and rates`;
  byId('usage-error').textContent = '';
  byId('credit-message').textContent = '';
  byId('usage-summary').textContent = `${data.account.mode === 'postpay' ? 'Unlimited postpay' : `Credit ${data.account.currency} ${data.account.balance}`} · ${data.account.charged_calls} charged calls · total cost ${data.account.currency} ${data.account.spent}`;
  const list = byId('usage-modules'); list.replaceChildren();
  for (const module of catalog.modules) {
    const row = document.createElement('div'); row.className = 'usage-module'; row.dataset.module = module.id;
    const inheritsAdverseRate = module.id === 'adverse-media-search-plus';
    const label = document.createElement('label'); label.className = 'check';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = inheritsAdverseRate
      ? data.account.allowed_modules.includes(module.id)
      : data.account.allowed_modules.includes('*') || data.account.allowed_modules.includes(module.id);
    const name = document.createElement('span'); name.textContent = `${module.name}${module.available ? '' : ' (unavailable)'}`;
    label.append(checkbox, name);
    const tiers = document.createElement('textarea'); tiers.rows = 2; tiers.spellcheck = false;
    tiers.placeholder = '*:0.00'; tiers.setAttribute('aria-label', `Rate tiers for ${module.name}`);
    tiers.value = (data.account.rates[inheritsAdverseRate ? 'adverse-media' : module.id] || [])
      .map((tier) => `${tier.up_to ?? '*'}:${tier.price}`).join('\n');
    if (inheritsAdverseRate) {
      tiers.disabled = true;
      const note = document.createElement('small');
      note.textContent = 'Uses this workspace’s Adverse Media rate tiers; Search+ access must be selected explicitly.';
      row.append(label, tiers, note);
    } else row.append(label, tiers);
    list.append(row);
  }
  const body = byId('admin-usage-logs'); body.replaceChildren();
  for (const log of data.logs) {
    const tr = document.createElement('tr');
    const cost = `${data.account.currency} ${log.cost}${log.refund_amount && log.refund_amount !== '0.000000' ? ` · refunded ${log.refund_amount}` : ''}`;
    for (const value of [log.date_time, log.transaction_id, log.modules.join(', ') || 'Utility', log.response_code ?? 'Pending', cost]) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    body.append(tr);
  }
  if (!data.logs.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 5; td.textContent = 'No API calls logged yet.'; tr.append(td); body.append(tr); }
  renderCreditLogs(data.credits || []);
  byId('usage-dialog').showModal();
}

function renderCreditLogs(credits) {
  const body = byId('admin-credit-logs'); body.replaceChildren();
  for (const credit of credits) {
    const tr = document.createElement('tr');
    for (const value of [credit.credited_at, credit.id, `${credit.currency} ${credit.amount}`, credit.actor || 'Unknown',
      credit.kind === 'refund' ? `${credit.reason || 'Refund'} · ${credit.related_transaction_id || ''}` : 'Manual credit']) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    body.append(tr);
  }
  if (!credits.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 5; td.textContent = 'No credit adjustments yet.'; tr.append(td); body.append(tr);
  }
}

let pendingCreditRequest = null;
byId('usage-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  byId('usage-error').textContent = '';
  try {
    const rows = [...byId('usage-modules').children];
    const allowed_modules = rows.filter((row) => row.querySelector('input').checked).map((row) => row.dataset.module);
    const rates = {};
    for (const row of rows) {
      if (row.dataset.module === 'adverse-media-search-plus') continue;
      const tiers = parseTierLines(row.querySelector('textarea').value);
      if (tiers.length) rates[row.dataset.module] = tiers;
    }
    await request(`/admin/api/customers/${form.elements.workspace_id.value}/usage`, { method: 'PUT', body: JSON.stringify({ mode: form.elements.mode.value, currency: form.elements.currency.value, allowed_modules, rates }) });
    byId('usage-dialog').close(); await loadClients();
  } catch (error) { byId('usage-error').textContent = error.message; }
});

byId('credit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  byId('credit-message').textContent = '';
  try {
    const id = byId('usage-form').elements.workspace_id.value;
    const amount = form.elements.amount.value;
    if (!pendingCreditRequest || pendingCreditRequest.workspaceId !== id || pendingCreditRequest.amount !== amount) {
      pendingCreditRequest = { workspaceId: id, amount, idempotencyKey: crypto.randomUUID() };
    }
    const data = await request(`/admin/api/customers/${id}/credit`, { method: 'POST', headers: { 'Idempotency-Key': pendingCreditRequest.idempotencyKey }, body: JSON.stringify({ amount }) });
    pendingCreditRequest = null;
    byId('usage-summary').textContent = `${data.account.mode === 'postpay' ? 'Unlimited postpay' : `Credit ${data.account.currency} ${data.account.balance}`} · ${data.account.charged_calls} charged calls · total cost ${data.account.currency} ${data.account.spent}`;
    byId('credit-message').textContent = `Credit added. New balance: ${data.account.currency} ${data.account.balance}`;
    form.reset();
    try {
      const latest = await request(`/admin/api/customers/${id}/usage`);
      renderCreditLogs(latest.credits || []);
    } catch {
      byId('credit-message').textContent += ' Audit history could not refresh; reopen this dialog to review it.';
    }
  } catch (error) { byId('credit-message').textContent = error.message; }
  finally { button.disabled = false; }
});

async function loadClients() {
  const data = await request('/admin/api/customers');
  const list = byId('client-list');
  list.replaceChildren();
  byId('client-empty').hidden = data.customers.length > 0;
  byId('client-count').textContent = data.keys.length;
  byId('active-client-count').textContent = data.keys.filter((item) => item.status === 'active').length;
  data.customers.forEach((customer) => {
    const heading = document.createElement('div');
    heading.className = 'client';
    heading.innerHTML = '<div><strong></strong><small></small></div><span class="pill"></span><button class="usage-open" type="button">Usage & rates</button><button class="resend" type="button"></button>';
    heading.querySelector('strong').textContent = customer.name;
    heading.querySelector('small').textContent = customer.adminEmail || 'Existing workspace';
    heading.querySelector('.pill').textContent = customer.status;
    heading.querySelector('.usage-open').addEventListener('click', () => openUsageDialog(customer).catch((error) => window.alert(error.message)));
    const resend = heading.querySelector('.resend');
    resend.hidden = !['pending', 'legacy'].includes(customer.status);
    resend.textContent = customer.status === 'legacy' ? 'Invite admin' : 'Resend invite';
    resend.addEventListener('click', async () => {
      if (customer.status === 'legacy') {
        const form = byId('client-form');
        form.reset(); form.elements.workspace_id.value = customer.id;
        form.elements.name.value = customer.name; form.elements.name.readOnly = true;
        byId('client-dialog').showModal();
        return;
      }
      resend.disabled = true;
      try { await request(`/admin/api/customers/${customer.id}/resend`, { method: 'POST' }); await loadClients(); byId('client-notice').hidden = false; byId('client-notice').textContent = 'A new invitation link was sent. The previous link is invalid.'; }
      catch (error) { resend.disabled = false; window.alert(error.message); }
    });
    list.append(heading);
    data.keys.filter((item) => item.workspaceId === customer.id).forEach((item) => {
    const row = document.createElement('div');
    row.className = 'client';
    row.innerHTML = `<div><strong></strong><small></small></div><span class="pill"></span><small></small><button class="revoke">Revoke</button>`;
    row.querySelector('strong').textContent = item.label || 'Default key';
    row.querySelector('div small').textContent = `•••• ${item.lastFour} · ${item.id}${item.ownerEmail ? ` · ${item.ownerEmail}` : ''}`;
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
  });
}

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  byId('login-error').textContent = '';
  try {
    const auth = await request('/admin/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: byId('admin-email').value, password: byId('admin-password').value })
    });
    byId('admin-password').value = '';
    pendingAdminLogin = { email: byId('admin-email').value.trim(), challengeId: auth.challenge_id };
    byId('admin-code-intro').textContent = `Enter the eight digit code sent to ${pendingAdminLogin.email}.`;
    byId('signin-card').hidden = true;
    byId('code-card').hidden = false;
    byId('admin-code').focus();
  } catch (error) {
    byId('login-error').textContent = error.message;
  }
});
byId('code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  byId('admin-code-error').textContent = '';
  const code = byId('admin-code').value.trim();
  if (!pendingAdminLogin || !/^\d{8}$/.test(code)) {
    byId('admin-code-error').textContent = 'Enter the eight digit code from your email.'; return;
  }
  const button = event.currentTarget.querySelector('button[type=submit]'); button.disabled = true;
  try {
    const auth = await request('/admin/api/auth/verify-code', { method: 'POST',
      body: JSON.stringify({ email: pendingAdminLogin.email, challenge_id: pendingAdminLogin.challengeId, code }) });
    pendingAdminLogin = null; byId('code-form').reset(); await showApp(auth);
  } catch (error) { byId('admin-code-error').textContent = error.message; }
  finally { button.disabled = false; }
});
byId('back-from-code').addEventListener('click', () => {
  pendingAdminLogin = null; byId('code-form').reset();
  byId('code-card').hidden = true; byId('signin-card').hidden = false;
});

byId('show-admin-forgot').addEventListener('click', () => {
  byId('signin-card').hidden = true;
  byId('forgot-card').hidden = false;
});
document.querySelectorAll('[data-back-to-admin-login]').forEach(button => button.addEventListener('click', () => {
  history.replaceState(null, '', '/admin');
  byId('forgot-card').hidden = true;
  byId('reset-card').hidden = true;
  byId('signin-card').hidden = false;
}));
byId('forgot-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const result = await request('/admin/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: byId('forgot-admin-email').value }) });
    byId('forgot-admin-message').textContent = result.message;
  } catch (error) { byId('forgot-admin-message').textContent = error.message; }
  finally { button.disabled = false; }
});
byId('reset-admin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = byId('reset-admin-password').value;
  if (password !== byId('reset-admin-confirm').value) { byId('reset-admin-message').textContent = 'Passwords do not match.'; return; }
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const token = new URLSearchParams(location.search).get('reset');
    const result = await request('/admin/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });
    form.reset();
    history.replaceState(null, '', '/admin');
    byId('reset-card').hidden = true;
    byId('signin-card').hidden = false;
    byId('login-error').textContent = result.message;
  } catch (error) { byId('reset-admin-message').textContent = error.message; }
  finally { button.disabled = false; }
});

byId('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  byId('setup-error').textContent = '';
  const password = byId('setup-password').value;
  if (password !== byId('setup-password-confirm').value) {
    byId('setup-error').textContent = 'Passwords do not match.';
    return;
  }
  try {
    const created = await request('/admin/api/auth/setup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${byId('setup-key').value.trim()}` },
      body: JSON.stringify({ email: byId('setup-email').value, password })
    });
    form.reset();
    byId('setup-card').hidden = true;
    byId('signin-card').hidden = false;
    byId('admin-email').value = created.account.email;
    byId('login-error').textContent = created.message;
  } catch (error) {
    byId('setup-error').textContent = error.message;

  }
});

document.querySelectorAll('aside nav button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
document.querySelectorAll('[data-refresh]').forEach((button) => button.addEventListener('click', () => button.dataset.refresh === 'clients' ? loadClients() : button.dataset.refresh === 'forms' ? loadForms() : loadIntegrations()));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => byId(button.dataset.close).close()));
byId('new-integration').addEventListener('click', () => byId('integration-dialog').showModal());
byId('new-form').addEventListener('click', () => openFormDialog());
byId('new-client').addEventListener('click', () => { const form = byId('client-form'); form.reset(); form.elements.name.readOnly = false; byId('client-dialog').showModal(); });
byId('sign-out').addEventListener('click', async () => {
  try { await request('/admin/api/auth/logout', { method: 'POST' }); } catch {}
  showSignedOut();
});
byId('change-password').addEventListener('click', () => {
  byId('password-form').reset();
  byId('password-error').textContent = '';
  byId('password-dialog').showModal();
});
byId('bsa-refresh').addEventListener('click', loadBsaAvailability);
document.querySelectorAll('[data-bsa-tab]').forEach(button => button.addEventListener('click', () => {
  const active = button.dataset.bsaTab;
  document.querySelectorAll('[data-bsa-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
  document.querySelectorAll('.bsa-tab').forEach(panel => { panel.hidden = panel.id !== `bsa-tab-${active}`; });
}));

async function pollBsaResult(resultUrl) {
  const message = byId('bsa-message');
  for (let attempt = 0; attempt < 360; attempt++) {
    const { body: result, status } = await bsaRequest(resultUrl);
    if (status === 200) {
      renderBsa(result);
      const ledgers = result.segments || [];
      const allReconciled = ledgers.length > 0 && ledgers.every(segment => segment.reconciliation?.status === 'fully_reconciled');
      message.textContent = allReconciled
        ? `Statement processed. All ${ledgers.length} ledgers reconciled. Review the reason codes and ownership evidence.`
        : ledgers.length ? 'Statement processed with review items. Check the reconciliation details below.'
          : 'No ledger could be reconciled from this upload. It may still be a bank statement; check the reason codes below.';
      return;
    }
    message.textContent = `Analysis ${result.analysisId || ''} ${result.status}…`;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Analysis is still processing. Keep the analysis ID and check the result again later.');
}

byId('bsa-lookup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = byId('bsa-lookup-id').value.trim();
  if (!/^bsa_[0-9a-fA-F-]{36}$/.test(id)) return;
  byId('bsa-result').hidden = true;
  try { await pollBsaResult(`/admin/api/bsa/${id}/result`); }
  catch (error) { byId('bsa-message').textContent = error.message || 'Unable to open analysis.'; }
});

byId('bsa-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const files = Array.from(byId('bsa-file').files);
  if (!files.length) return;
  const button = event.currentTarget.querySelector('button[type=submit]');
  const message = byId('bsa-message');
  button.disabled = true;
  byId('bsa-result').hidden = true;
  message.textContent = 'Uploading statement…';
  try {
    const body = new FormData();
    for (const file of files) body.append('statement_file', file);
    body.append('country_code', 'AE');
    body.append('entity_type', byId('bsa-entity').value);
    body.append('get_pdf', byId('bsa-get-pdf').checked ? 'true' : 'false');
    body.append('get_xlsx', byId('bsa-get-xlsx').checked ? 'true' : 'false');
    body.append('credit_models', JSON.stringify(Array.from(document.querySelectorAll('[name="bsa-credit-model"]:checked'), input => input.value)));
    const names = byId('bsa-names').value.split('\n').map(value => value.trim()).filter(Boolean);
    if (names.length) body.append('declared_names', JSON.stringify(names));
    if (byId('bsa-employer').value.trim()) body.append('declared_employer', byId('bsa-employer').value.trim());
    if (byId('bsa-income').value) {
      body.append('declared_monthly_income', byId('bsa-income').value);
      body.append('declared_income_currency', byId('bsa-income-currency').value);
    }
    if (byId('bsa-reference').value.trim()) body.append('customer_reference', byId('bsa-reference').value.trim());
    const accepted = await bsaRequest('/admin/api/bsa', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body });
    byId('bsa-lookup-id').value = accepted.body.analysisId;
    history.replaceState(null, '', `/admin?analysis=${encodeURIComponent(accepted.body.analysisId)}`);
    await pollBsaResult(accepted.body.resultUrl);
  } catch (error) { message.textContent = error.message || 'Analysis failed.'; }
  finally { button.disabled = false; }
});


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

byId('ejari-config-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = byId('ejari-config-error');
  error.textContent = '';
  try {
    const values = {
      enabled: form.elements.enabled.checked,
      ocr_model: form.elements.ocr_model.value.trim(),
      ocr_detail: form.elements.ocr_detail.value,
      openai_key: form.elements.openai_key.value,
      capsolver_key: form.elements.capsolver_key.value
    };
    await request('/admin/api/ejari/config', { method: 'PUT', body: JSON.stringify(values) });
    form.elements.openai_key.value = '';
    form.elements.capsolver_key.value = '';
    await loadEjariConfig();
  } catch (problem) { error.textContent = problem.message || 'Ejari setup could not be saved.'; }
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
    const path = form.elements.workspace_id.value ? `/admin/api/customers/${form.elements.workspace_id.value}/invite` : '/admin/api/customers';
    const result = await request(path, { method: 'POST', body: JSON.stringify({ name: form.elements.name.value, admin_email: form.elements.admin_email.value.trim() }) });
    form.reset();
    form.elements.name.readOnly = false;
    byId('client-dialog').close();
    await loadClients();
    byId('client-notice').hidden = false;
    byId('client-notice').textContent = result.delivery === 'sent' ? 'Invitation sent. The administrator can set a password and create API keys.' : 'Workspace created, but email delivery failed. Use Resend invite.';
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


byId('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  byId('password-error').textContent = '';
  if (form.elements.new_password.value !== form.elements.confirm_password.value) {
    byId('password-error').textContent = 'New passwords do not match.';
    return;
  }
  try {
    const auth = await request('/admin/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ current_password: form.elements.current_password.value, new_password: form.elements.new_password.value })
    });
    csrfToken = auth.csrf_token;
    form.reset();
    byId('password-dialog').close();
  } catch (error) {
    byId('password-error').textContent = error.message;
  }
});

bootstrapAuth();
