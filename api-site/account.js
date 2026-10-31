(() => {
  const byId = (id) => document.getElementById(id);
  let csrf = '';
  let casePolicyVersion = 0;

  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, credentials: 'same-origin', headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.method && options.method !== 'GET' ? { 'x-ai7-csrf': csrf } : {}), ...(options.headers || {})
    } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }

  function showNewKey(value) {
    byId('new-key-value').textContent = value;
    byId('new-key-panel').hidden = false;
    byId('new-key-panel').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  async function loadKeys() {
    const { keys } = await request('/portal/api/keys');
    const list = byId('key-list');
    list.replaceChildren();
    if (!keys.length) { list.textContent = 'No keys yet. Create one to start using the APIs.'; return; }
    for (const key of keys) {
      const row = document.createElement('div'); row.className = 'account-key-row';
      const info = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = key.label || 'Default key';
      const details = document.createElement('small'); details.textContent = `•••• ${key.lastFour} · ${key.status} · created ${new Date(key.createdAt).toLocaleDateString()}`;
      info.append(title, details); row.append(info);
      if (key.status === 'active') {
        const rotate = document.createElement('button'); rotate.textContent = 'Rotate'; rotate.type = 'button';
        rotate.addEventListener('click', async () => {
          if (!confirm(`Rotate ${key.label || 'this key'}? Its current value will stop working.`)) return;
          rotate.disabled = true;
          try { const result = await request(`/portal/api/keys/${key.id}/rotate`, { method: 'POST' }); showNewKey(result.api_key); await loadKeys(); }
          catch (error) { byId('account-message').textContent = error.message; rotate.disabled = false; }
        });
        const revoke = document.createElement('button'); revoke.textContent = 'Revoke'; revoke.type = 'button';
        revoke.addEventListener('click', async () => {
          if (!confirm(`Revoke ${key.label || 'this key'}? This cannot be undone.`)) return;
          revoke.disabled = true;
          try { await request(`/portal/api/keys/${key.id}/revoke`, { method: 'POST' }); await loadKeys(); }
          catch (error) { byId('account-message').textContent = error.message; revoke.disabled = false; }
        });
        row.append(rotate, revoke);
      }
      list.append(row);
    }
  }

  async function loadHealth() {
    byId('health-status').textContent = 'Checking…';
    try {
      const result = await request('/portal/api/health');
      byId('health-status').textContent = `${result.status.replaceAll('_', ' ')} · checked ${new Date(result.checked_at).toLocaleString()} · upstream probes ${result.upstream_probe.replaceAll('_', ' ')}`;
      const list = byId('health-list'); list.replaceChildren();
      for (const check of result.checks) {
        const row = document.createElement('div'); row.className = 'account-health-row';
        const name = document.createElement('strong'); name.textContent = check.name;
        const status = document.createElement('span'); status.textContent = check.status;
        row.append(name, status); list.append(row);
      }
      if (!result.checks.length) list.textContent = 'No APIs are enabled for this workspace.';
    } catch (error) { byId('health-status').textContent = error.message; }
  }

  async function loadUsage() {
    byId('usage-status').textContent = 'Loading usage…';
    try {
      const { account, logs } = await request('/portal/api/usage');
      byId('usage-status').textContent = `${account.mode === 'postpay' ? 'Postpay · unlimited usage' : `Prepaid balance ${account.currency} ${account.balance}`} · ${account.charged_calls} charged calls · total cost ${account.currency} ${account.spent}`;
      const body = byId('usage-rows'); body.replaceChildren();
      for (const log of logs) {
        const row = document.createElement('tr');
        const cost = `${account.currency} ${log.cost}${log.refund_amount && log.refund_amount !== '0.000000' ? ` · refunded ${log.refund_amount}` : ''}`;
        for (const value of [log.date_time, log.transaction_id, log.modules.join(', ') || 'Utility', log.response_code ?? 'Pending', cost]) {
          const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
        }
        body.append(row);
      }
      if (!logs.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = 'No API calls logged yet.'; row.append(cell); body.append(row); }
    } catch (error) { byId('usage-status').textContent = error.message; }
  }

  async function loadCaseSettings() {
    const settings = await request('/portal/api/case-manager/settings');
    if (!settings.available) return;
    byId('case-settings-section').hidden = false;
    casePolicyVersion = settings.policy.version;
    byId('case-enabled').checked = settings.policy.enabled;
    byId('case-ttl').value = settings.policy.ttl_days || 30;
  }

  byId('case-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    byId('case-settings-message').textContent = '';
    try {
      const enabled = byId('case-enabled').checked;
      const ttlDays = Number(byId('case-ttl').value);
      const result = await request('/portal/api/case-manager/settings', { method: 'PUT',
        body: JSON.stringify({ version: casePolicyVersion, enabled, ttl_days: ttlDays }) });
      casePolicyVersion = result.policy.version;
      byId('case-settings-message').textContent = result.retirement_recovery_pending
        ? 'Earlier case copies are hidden. Deletion recovery is pending and operations has been alerted.'
        : enabled
          ? `Case Manager is enabled for new checks. Copies expire after ${ttlDays} days (30 days at most for OCR).`
          : 'Case Manager is disabled. Earlier copies are retired and will be purged.';
    } catch (error) { byId('case-settings-message').textContent = error.message; }
    finally { button.disabled = false; }
  });

  byId('create-key-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    button.disabled = true;
    byId('account-message').textContent = '';
    const label = byId('key-label').value.trim();
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem('ai7_pending_create_key') || 'null'); } catch { /* replace malformed local state */ }
    if (!pending || pending.label !== label) {
      pending = { label, idempotencyKey: crypto.randomUUID() };
      sessionStorage.setItem('ai7_pending_create_key', JSON.stringify(pending));
    }
    try { const result = await request('/portal/api/keys', { method: 'POST',
      headers: { 'idempotency-key': pending.idempotencyKey }, body: JSON.stringify({ label }) });
      showNewKey(result.api_key); sessionStorage.removeItem('ai7_pending_create_key'); form.reset();
      try { await loadKeys(); }
      catch { byId('account-message').textContent = 'Key created. The list could not refresh; reload this page after storing the new key.'; }
    }
    catch (error) { byId('account-message').textContent = error.message; }
    finally { button.disabled = false; }
  });
  byId('copy-new-key').addEventListener('click', async () => {
    const button = byId('copy-new-key');
    await navigator.clipboard.writeText(byId('new-key-value').textContent);
    const icon = button.innerHTML;
    button.disabled = true;
    button.textContent = '✓';
    button.setAttribute('aria-label', 'Copied API key');
    setTimeout(() => { button.innerHTML = icon; button.setAttribute('aria-label', 'Copy API key'); button.disabled = false; }, 1200);
  });
  byId('refresh-health').addEventListener('click', loadHealth);
  byId('refresh-usage').addEventListener('click', loadUsage);

  request('/portal/api/auth/session').then(async (session) => {
    csrf = session.csrf_token;
    byId('account-identity').textContent = `${session.account.client_name} · ${session.account.email}`;
    const initial = sessionStorage.getItem('ai7_new_api_key');
    if (initial) { sessionStorage.removeItem('ai7_new_api_key'); showNewKey(initial); }
    await Promise.all([loadKeys(), loadHealth(), loadUsage(), loadCaseSettings()]);
  }).catch(() => location.replace('/login?next=%2Faccount'));
})();
