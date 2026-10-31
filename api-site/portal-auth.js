(() => {
  const protectedPaths = new Set(['/', '/iban', '/entity-search', '/adverse-media', '/merchant-screening', '/bank-statement-analysis', '/forms', '/account', '/cases']);
  const normalizedPath = location.pathname.length > 1 ? location.pathname.replace(/\/$/, '') : '/';
  const documentApis = [
    ['uae-trade-license-ocr', 'UAE Trade License OCR'],
    ['passport-icao-ocr', 'Passport & MRZ'],
    ['uae-poa-ocr', 'UAE POA OCR'],
    ['uae-utility-bill-ocr', 'UAE Utility Bill OCR'],
    ['cheque-ocr', 'Cheque OCR'],
    ['moa-analysis', 'MOA Analysis'],
    ['articles-of-association-ocr', 'Articles of Association'],
    ['emirates-id-ocr', 'Emirates ID OCR']
  ];
  const pageContext = {
    '/': ['Verification API', 'UAE Trade Licence'],
    '/iban': ['Verification API', 'IBAN Verification'],
    '/entity-search': ['Verification API', 'Entity Search'],
    '/adverse-media': ['Verification API', 'Adverse Media'],
    '/merchant-screening': ['Verification API', 'Merchant Screening'],
    '/bank-statement-analysis': ['Verification API', 'Bank Statement Analysis'],
    '/forms': ['Forms', 'Forms Module'],
    '/account': ['Workspace', 'Account settings'],
    '/cases': ['Workspace', 'Case Manager'],
    ...Object.fromEntries(documentApis.map(([id, name]) => [`/document-extraction/${id}`, ['Document Extraction', name]]))
  };

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[character]);
  }

  async function loadSession() {
    const response = await fetch('/portal/api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) {
      if (protectedPaths.has(normalizedPath) || normalizedPath.startsWith('/document-extraction/')) location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
      return;
    }
    const session = await response.json();
    const entitlementResponse = await fetch('/portal/api/entitlements', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!entitlementResponse.ok) return;
    renderPortal(session, await entitlementResponse.json());
  }

  function renderPortal(session, entitlements) {
    const account = session.account || {};
    const sidebar = document.createElement('nav');
    sidebar.className = 'portal-sidebar';
    sidebar.id = 'portal-sidebar';
    sidebar.setAttribute('aria-label', 'Portal navigation');
    sidebar.innerHTML = `
      <a class="portal-brand" href="/" aria-label="KYCProbe developer portal"><img src="/assets/kycprobe-logo-white.png" alt="KYCProbe by AI7Lab" /></a>
      <div class="portal-nav-group">
        <p>VERIFICATION API</p>
        <a href="/" data-path="/"><span>01</span> UAE Trade Licence</a>
        <a href="/iban" data-path="/iban"><span>02</span> IBAN Verification</a>
        <a href="/entity-search" data-path="/entity-search"><span>03</span> Entity Search</a>
        <a href="/adverse-media" data-path="/adverse-media"><span>04</span> Adverse Media</a>
        <a href="/merchant-screening" data-path="/merchant-screening"><span>05</span> Merchant Screening</a>
        <a href="/bank-statement-analysis" data-path="/bank-statement-analysis"><span>06</span> Bank Statement Analysis</a>
      </div>
      <div class="portal-nav-group">
        <p>DOCUMENT EXTRACTION</p>
        ${documentApis.map(([id, name], index) => `<a href="/document-extraction/${id}" data-path="/document-extraction/${id}"><span>${String(index + 9).padStart(2, '0')}</span> ${escapeHtml(name)}</a>`).join('')}
      </div>
      <div class="portal-nav-group">
        <p>FORMS</p>
        <a href="/forms" data-path="/forms"><span>07</span> Forms Module</a>
      </div>
      <div class="portal-nav-group">
        <p>WORKSPACE</p>
        <a href="/account" data-path="/account"><span>08</span> Account settings</a>
        <a href="/cases" data-path="/cases" id="portal-case-link" hidden><span>09</span> Case Manager</a>
      </div>
      <div class="portal-account">
        <span>WORKSPACE</span>
        <strong>${escapeHtml(account.client_name || 'AI7 API workspace')}</strong>
        <small>${escapeHtml(account.email)}</small>
        <button type="button" id="portal-sign-out">Sign out</button>
      </div>`;
    sidebar.querySelector(`[data-path="${normalizedPath}"]`)?.classList.add('active');
    const modules = { '/': 'uae-trade-licence', '/iban': 'iban-verification', '/entity-search': 'entity-search', '/adverse-media': 'adverse-media', '/merchant-screening': 'merchant-screening', '/bank-statement-analysis': 'bank-statement-analysis', '/forms': 'forms',
      ...Object.fromEntries(documentApis.map(([id]) => [`/document-extraction/${id}`, id])) };
    sidebar.querySelectorAll('a[data-path]').forEach((link) => {
      const module = modules[link.dataset.path];
      if (module && ((!entitlements.allowed_modules.includes('*') && !entitlements.allowed_modules.includes(module))
        || (Array.isArray(entitlements.available_modules) && !entitlements.available_modules.includes(module)))) link.remove();
    });
    document.body.prepend(sidebar);
    fetch('/portal/api/case-manager/settings', { credentials: 'same-origin' }).then((response) => response.ok ? response.json() : null)
      .then((settings) => { if (settings?.available) sidebar.querySelector('#portal-case-link').hidden = false; }).catch(() => {});

    const header = document.querySelector('header');
    if (header) {
      header.classList.add('portal-header');
      header.querySelector('nav')?.remove();
      header.querySelector('.brand')?.remove();
      const menu = document.createElement('button');
      menu.type = 'button';
      menu.id = 'portal-menu';
      menu.className = 'portal-menu';
      menu.setAttribute('aria-controls', 'portal-sidebar');
      menu.setAttribute('aria-expanded', 'false');
      menu.setAttribute('aria-label', 'Open navigation');
      menu.textContent = '☰';
      header.prepend(menu);
      const context = document.createElement('div');
      context.className = 'portal-context';
      const [section, page] = pageContext[normalizedPath] || ['Developer Portal', 'Workspace'];
      context.innerHTML = `<span>${section}</span><strong>${page}</strong>`;
      menu.after(context);
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
    if (protectedPaths.has(normalizedPath) || normalizedPath.startsWith('/document-extraction/')) location.replace('/login');
  });
})();
