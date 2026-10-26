(() => {
  const byId = (id) => document.getElementById(id);
  let csrf = '';

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
        for (const value of [log.date_time, log.transaction_id, log.modules.join(', ') || 'Utility', log.response_code ?? 'Pending', `${account.currency} ${log.cost}`]) {
          const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
        }
        body.append(row);
      }
      if (!logs.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = 'No API calls logged yet.'; row.append(cell); body.append(row); }
    } catch (error) { byId('usage-status').textContent = error.message; }
  }

  byId('create-key-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    byId('account-message').textContent = '';
    try { const result = await request('/portal/api/keys', { method: 'POST', body: JSON.stringify({ label: byId('key-label').value }) });
      showNewKey(result.api_key); event.currentTarget.reset(); await loadKeys(); }
    catch (error) { byId('account-message').textContent = error.message; }
    finally { button.disabled = false; }
  });
  byId('copy-new-key').addEventListener('click', async () => { await navigator.clipboard.writeText(byId('new-key-value').textContent); byId('copy-new-key').textContent = 'Copied'; });
  byId('refresh-health').addEventListener('click', loadHealth);
  byId('refresh-usage').addEventListener('click', loadUsage);

  request('/portal/api/auth/session').then(async (session) => {
    csrf = session.csrf_token;
    byId('account-identity').textContent = `${session.account.client_name} · ${session.account.email}`;
    const initial = sessionStorage.getItem('ai7_new_api_key');
    if (initial) { sessionStorage.removeItem('ai7_new_api_key'); showNewKey(initial); }
    await Promise.all([loadKeys(), loadHealth(), loadUsage()]);
  }).catch(() => location.replace('/login?next=%2Faccount'));
})();
