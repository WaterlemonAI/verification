(() => {
  const loginForm = document.getElementById('login-form');
  const signupForm = document.getElementById('signup-form');
  const loginTab = document.getElementById('show-login');
  const signupTab = document.getElementById('show-signup');
  const title = document.getElementById('auth-title');
  const intro = document.getElementById('auth-intro');
  const allowedPaths = new Set(['/', '/iban', '/entity-search', '/adverse-media', '/merchant-screening', '/forms']);

  function destination() {
    const value = new URLSearchParams(location.search).get('next') || '/';
    try {
      const parsed = new URL(value, location.origin);
      const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/$/, '') : '/';
      return parsed.origin === location.origin && allowedPaths.has(path) ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/';
    } catch { return '/'; }
  }

  function setMode(mode) {
    const signingUp = mode === 'signup';
    loginForm.hidden = signingUp;
    signupForm.hidden = !signingUp;
    loginTab.classList.toggle('active', !signingUp);
    signupTab.classList.toggle('active', signingUp);
    loginTab.setAttribute('aria-selected', String(!signingUp));
    signupTab.setAttribute('aria-selected', String(signingUp));
    title.textContent = signingUp ? 'Create your account' : 'Welcome back';
    intro.textContent = signingUp ? 'Connect an active AI7 key to your email, then set your portal password.' : 'Sign in with your workspace email and password.';
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

  loginTab.addEventListener('click', () => setMode('login'));
  signupTab.addEventListener('click', () => setMode('signup'));
  loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(loginForm, '/portal/api/auth/login', {
      email: document.getElementById('login-email').value,
      password: document.getElementById('login-password').value
    }, document.getElementById('login-error'));
  });
  signupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const password = document.getElementById('signup-password').value;
    if (password !== document.getElementById('signup-confirm').value) {
      document.getElementById('signup-error').textContent = 'Passwords do not match.';
      return;
    }
    submit(signupForm, '/portal/api/auth/signup', {
      api_key: document.getElementById('signup-key').value,
      email: document.getElementById('signup-email').value,
      password
    }, document.getElementById('signup-error'));
  });

  fetch('/portal/api/auth/status', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then((response) => response.json()).then((status) => { if (status.authenticated) location.replace(destination()); }).catch(() => {});
})();
