(() => {
  const protectedPaths = new Set(['/', '/iban', '/entity-search', '/adverse-media', '/merchant-screening', '/forms']);
  const normalizedPath = location.pathname.length > 1 ? location.pathname.replace(/\/$/, '') : '/';

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[character]);
  }

  async function loadSession() {
    const response = await fetch('/portal/api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) {
      if (protectedPaths.has(normalizedPath)) location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
      return;
    }
    renderPortal(await response.json());
  }

  function renderPortal(session) {
    const account = session.account || {};
    const sidebar = document.createElement('nav');
    sidebar.className = 'portal-sidebar';
    sidebar.id = 'portal-sidebar';
    sidebar.setAttribute('aria-label', 'Portal navigation');
    sidebar.innerHTML = `
      <a class="portal-brand" href="/" aria-label="AI7 UAE developer portal"><span>A7</span><strong>AI7 <b>UAE</b></strong></a>
      <div class="portal-nav-group">
        <p>VERIFICATION API</p>
        <a href="/" data-path="/"><span>01</span> UAE Trade Licence</a>
        <a href="/iban" data-path="/iban"><span>02</span> IBAN Verification</a>
        <a href="/entity-search" data-path="/entity-search"><span>03</span> Entity Search</a>
        <a href="/adverse-media" data-path="/adverse-media"><span>04</span> Adverse Media</a>
        <a href="/merchant-screening" data-path="/merchant-screening"><span>05</span> Merchant Screening</a>
      </div>
      <div class="portal-nav-group">
        <p>FORMS</p>
        <a href="/forms" data-path="/forms"><span>06</span> Forms Module</a>
      </div>
      <div class="portal-account">
        <span>WORKSPACE</span>
        <strong>${escapeHtml(account.client_name || 'AI7 API workspace')}</strong>
        <small>${escapeHtml(account.email)}</small>
        <button type="button" id="portal-sign-out">Sign out</button>
      </div>`;
    sidebar.querySelector(`[data-path="${normalizedPath}"]`)?.classList.add('active');
    document.body.prepend(sidebar);

    const header = document.querySelector('header');
    if (header) {
      header.classList.add('portal-header');
      header.querySelector('nav')?.remove();
      const menu = document.createElement('button');
      menu.type = 'button';
      menu.id = 'portal-menu';
      menu.className = 'portal-menu';
      menu.setAttribute('aria-controls', 'portal-sidebar');
      menu.setAttribute('aria-expanded', 'false');
      menu.setAttribute('aria-label', 'Open navigation');
      menu.textContent = '☰';
      header.prepend(menu);
      menu.addEventListener('click', () => {
        const open = document.body.classList.toggle('portal-menu-open');
        menu.setAttribute('aria-expanded', String(open));
      });
    }

    const overlay = document.createElement('button');
    overlay.className = 'portal-overlay';
    overlay.type = 'button';
    overlay.setAttribute('aria-label', 'Close navigation');
    overlay.addEventListener('click', () => document.body.classList.remove('portal-menu-open'));
    document.body.append(overlay);

    document.getElementById('portal-sign-out')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      const response = await fetch('/portal/api/auth/logout', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'x-ai7-csrf': session.csrf_token, accept: 'application/json' }
      });
      if (response.ok) location.replace('/login');
      else button.disabled = false;
    });
    document.body.classList.add('portal-ready');
  }

  loadSession().catch(() => {
    if (protectedPaths.has(normalizedPath)) location.replace('/login');
  });
})();
