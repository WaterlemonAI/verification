(() => {
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

  for (const input of document.querySelectorAll('.auth-form input[type="password"]')) {
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

  const loginForm = document.getElementById('login-form');
  const codeForm = document.getElementById('code-form');
  let pendingLogin = null;
  const inviteForm = document.getElementById('invite-form');
  const forgotForm = document.getElementById('forgot-form');
  const resetForm = document.getElementById('reset-form');
  const title = document.getElementById('auth-title');
  const intro = document.getElementById('auth-intro');
  const allowedPaths = new Set(['/', '/iban', '/entity-search', '/adverse-media', '/merchant-screening', '/bank-statement-analysis', '/forms', '/account', '/cases']);

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
    codeForm.hidden = mode !== 'code';
    inviteForm.hidden = mode !== 'invite';
    forgotForm.hidden = mode !== 'forgot';
    resetForm.hidden = mode !== 'reset';
    document.getElementById('show-forgot').hidden = mode !== 'login';
    document.getElementById('back-to-login').hidden = mode === 'login';
    title.textContent = mode === 'code' ? 'Check your email' : mode === 'reset' ? 'Set a new password' : mode === 'forgot' ? 'Recover your account' : mode === 'invite' ? 'Set up your workspace' : 'Welcome back';
    intro.textContent = mode === 'code' ? `Enter the eight digit code sent to ${pendingLogin?.email || 'your email'}.` : mode === 'reset' ? 'Choose a new password for your workspace.' : mode === 'forgot' ? 'We will email a reset link if this account exists.' : mode === 'invite' ? 'Your invitation links this account to the correct customer workspace.' : 'Sign in with your workspace email and password.';
  }

  document.getElementById('show-forgot').addEventListener('click', () => setMode('forgot'));
  document.getElementById('back-to-login').addEventListener('click', () => {
    history.replaceState(null, '', '/login'); pendingLogin = null; codeForm.reset(); setMode('login');
  });
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
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = document.getElementById('login-email');
    const password = document.getElementById('login-password');
    const error = document.getElementById('login-error');
    if (!email.value.trim()) { error.textContent = 'Enter your email address.'; email.focus(); return; }
    if (!email.validity.valid) { error.textContent = 'Enter a valid email address.'; email.focus(); return; }
    if (!password.value) { error.textContent = 'Enter your password.'; password.focus(); return; }
    const button = loginForm.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      const response = await fetch('/portal/api/auth/login', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.value.trim(), password: password.value }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Sign-in could not be completed.');
      pendingLogin = { email: email.value.trim(), challengeId: result.challenge_id };
      password.value = ''; setMode('code'); document.getElementById('login-code').focus();
    } catch (failure) { error.textContent = failure.message; }
    finally { button.disabled = false; }
  });
  codeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = document.getElementById('login-code').value.trim();
    const error = document.getElementById('code-error'); error.textContent = '';
    if (!/^\d{8}$/.test(code) || !pendingLogin) { error.textContent = 'Enter the eight digit code from your email.'; return; }
    const button = codeForm.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      const response = await fetch('/portal/api/auth/verify-code', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: pendingLogin.email,
          challenge_id: pendingLogin.challengeId, code }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The code could not be verified.');
      if (result.api_key) sessionStorage.setItem('ai7_new_api_key', result.api_key);
      location.replace(result.api_key ? '/account' : destination());
    } catch (failure) { error.textContent = failure.message; button.disabled = false; }
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
      history.replaceState(null, '', '/login');
      document.getElementById('login-email').value = result.account.email;
      setMode('login');
      document.getElementById('login-error').textContent = result.message;
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
