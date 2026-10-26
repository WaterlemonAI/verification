(() => {
  const loginForm = document.getElementById('login-form');
  const inviteForm = document.getElementById('invite-form');
  const forgotForm = document.getElementById('forgot-form');
  const resetForm = document.getElementById('reset-form');
  const title = document.getElementById('auth-title');
  const intro = document.getElementById('auth-intro');
  const allowedPaths = new Set(['/', '/iban', '/entity-search', '/adverse-media', '/merchant-screening', '/bank-statement-analysis', '/forms', '/account']);

  function destination() {
    const value = new URLSearchParams(location.search).get('next') || '/';
    try {
      const parsed = new URL(value, location.origin);
      const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/$/, '') : '/';
      return parsed.origin === location.origin && allowedPaths.has(path) ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/';
    } catch { return '/'; }
  }

  function setMode(mode) {
    loginForm.hidden = mode !== 'login';
    inviteForm.hidden = mode !== 'invite';
    forgotForm.hidden = mode !== 'forgot';
    resetForm.hidden = mode !== 'reset';
    document.getElementById('show-forgot').hidden = mode !== 'login';
    document.getElementById('back-to-login').hidden = mode === 'login';
    title.textContent = mode === 'reset' ? 'Set a new password' : mode === 'forgot' ? 'Recover your account' : mode === 'invite' ? 'Set up your workspace' : 'Welcome back';
    intro.textContent = mode === 'reset' ? 'Choose a new password for your workspace.' : mode === 'forgot' ? 'We will email a reset link if this account exists.' : mode === 'invite' ? 'Your invitation links this account to the correct customer workspace.' : 'Sign in with your workspace email and password.';
  }

  async function submit(form, endpoint, body, errorElement) {
    const button = form.querySelector('button[type="submit"]');
    errorElement.textContent = '';
    button.disabled = true;
    try {
      const response = await fetch(endpoint, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
      location.replace(destination());
    } catch (error) {
      errorElement.textContent = error.message;
      button.disabled = false;
    }
  }

  document.getElementById('show-forgot').addEventListener('click', () => setMode('forgot'));
  document.getElementById('back-to-login').addEventListener('click', () => { history.replaceState(null, '', '/login'); setMode('login'); });
  forgotForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = forgotForm.querySelector('button[type="submit"]');
    const message = document.getElementById('forgot-message');
    button.disabled = true;
    try {
      const response = await fetch('/portal/api/auth/forgot-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: document.getElementById('forgot-email').value }) });
      const result = await response.json();
      message.textContent = response.ok ? result.message : result.error;
    } catch { message.textContent = 'The request could not be completed.'; }
    finally { button.disabled = false; }
  });
  resetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = document.getElementById('reset-password').value;
    const message = document.getElementById('reset-message');
    if (password !== document.getElementById('reset-confirm').value) { message.textContent = 'Passwords do not match.'; return; }
    const button = resetForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const token = new URLSearchParams(location.search).get('reset');
      const response = await fetch('/portal/api/auth/reset-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The reset link could not be used.');
      history.replaceState(null, '', '/login');
      resetForm.reset();
      setMode('login');
      document.getElementById('login-error').textContent = result.message;
    } catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  });
  loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(loginForm, '/portal/api/auth/login', {
      email: document.getElementById('login-email').value,
      password: document.getElementById('login-password').value
    }, document.getElementById('login-error'));
  });
  inviteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = document.getElementById('invite-password').value;
    const errorElement = document.getElementById('invite-error');
    if (password !== document.getElementById('invite-confirm').value) {
      errorElement.textContent = 'Passwords do not match.';
      return;
    }
    const button = inviteForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const token = new URLSearchParams(location.hash.slice(1)).get('invite');
      const response = await fetch('/portal/api/invitations/accept', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The invitation could not be accepted.');
      sessionStorage.setItem('ai7_new_api_key', result.api_key);
      history.replaceState(null, '', '/login');
      location.replace('/account');
    } catch (error) { errorElement.textContent = error.message; button.disabled = false; }
  });

  if (new URLSearchParams(location.hash.slice(1)).has('invite')) {
    setMode('invite');
    fetch('/portal/api/invitations/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: new URLSearchParams(location.hash.slice(1)).get('invite') }) })
      .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; })
      .then((result) => { document.getElementById('invite-workspace').textContent = result.customer.name; document.getElementById('invite-email').value = result.customer.admin_email; })
      .catch((error) => { document.getElementById('invite-error').textContent = error.message || 'This setup link is invalid.'; inviteForm.querySelector('button[type="submit"]').disabled = true; });
  }
  else if (new URLSearchParams(location.search).has('reset')) setMode('reset');
  else fetch('/portal/api/auth/status', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then((response) => response.json()).then((status) => { if (status.authenticated) location.replace(destination()); }).catch(() => {});
})();
