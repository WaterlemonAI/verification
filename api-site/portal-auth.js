(() => {
  const path = location.pathname.length > 1 ? location.pathname.replace(/\/$/, '') : '/';
  const protectedPaths = new Set(['/', '/iban', '/entity-search', '/adverse-media', '/merchant-screening',
    '/bank-statement-analysis', '/ejari-verification', '/forms', '/account', '/usage', '/api-keys',
    '/cases', '/flo', '/flo-workflows']);
  const verification = [
    ['/', 'UAE Trade Licence', 'uae-trade-licence'],
    ['/iban', 'IBAN Verification', 'iban-verification'],
    ['/entity-search', 'Entity Search', 'entity-search'],
    ['/adverse-media', 'Adverse Media', 'adverse-media'],
    ['/merchant-screening', 'Merchant Screening', 'merchant-screening'],
    ['/bank-statement-analysis', 'Bank Statement Analysis', 'bank-statement-analysis'],
    ['/ejari-verification', 'Dubai Ejari Verification', 'ejari-verification']
  ];
  const el = (tag, label, className) => {
    const item = document.createElement(tag);
    if (label != null) item.textContent = label;
    if (className) item.className = className;
    return item;
  };
  const loginTarget = () => '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
  const allowed = (entitlements, module) => {
    const assigned = entitlements.allowed_modules || [];
    const available = entitlements.available_modules || [];
    return (assigned.includes('*') || assigned.includes(module)) && available.includes(module);
  };
  const formPath = /^\/forms\/[a-z0-9-]+$/.test(path);
  const ocrPath = /^\/document-extraction\/[a-z0-9-]+$/.test(path);
  let navigationAbort = null;

  function confirmExternalLink(event) {
    const link = event.target.closest?.('a[href]');
    if (!link || event.defaultPrevented) return;
    const destination = new URL(link.href);
    if (!['http:', 'https:'].includes(destination.protocol) || destination.origin === location.origin) return;
    if (!window.confirm('You will be redirected to ' + destination.hostname + ' website. Continue?')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  document.addEventListener('click', confirmExternalLink, true);
  document.addEventListener('auxclick', confirmExternalLink, true);

  async function getJson(url) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('Navigation data unavailable.');
    return response.json();
  }

  async function loadData(entitlements) {
    const needsFlo = allowed(entitlements, 'flo');
    const needsForms = allowed(entitlements, 'forms');
    const needsOcr = (entitlements.available_modules || []).some((id) =>
      (id.endsWith('-ocr') || id === 'moa-analysis') && allowed(entitlements, id));
    const [flo, cases, forms, ocr] = await Promise.allSettled([
      needsFlo ? getJson('/portal/api/flo/status') : Promise.resolve(null),
      getJson('/portal/api/case-manager/settings'),
      needsForms ? getJson('/forms.json') : Promise.resolve(null),
      needsOcr ? getJson('/document-extraction-catalog.json') : Promise.resolve(null)
    ]);
    return {
      flo: flo.status === 'fulfilled' ? flo.value : null,
      cases: cases.status === 'fulfilled' ? cases.value : null,
      forms: forms.status === 'fulfilled' ? forms.value : null,
      formsFailed: needsForms && forms.status === 'rejected',
      ocr: ocr.status === 'fulfilled' && Array.isArray(ocr.value) ? ocr.value : null,
      ocrFailed: needsOcr && ocr.status === 'rejected'
    };
  }

  function renderPortal(session, entitlements, data) {
    navigationAbort?.abort();
    navigationAbort = new AbortController();
    document.querySelector('#portal-sidebar')?.remove();
    document.querySelector('.portal-overlay')?.remove();
    const account = session.account || {};
    const sidebar = el('nav', null, 'portal-sidebar');
    sidebar.id = 'portal-sidebar';
    sidebar.setAttribute('aria-label', 'Workspace navigation');
    const brand = el('a', null, 'portal-brand');
    brand.href = '/'; brand.setAttribute('aria-label', 'KYCProbe home');
    const logo = el('img'); logo.src = '/assets/kycprobe-logo-white.png'; logo.alt = 'KYCProbe by AI7Lab';
    brand.append(logo); sidebar.append(brand);
    const groups = [];
    let active = null;

    function addLink(container, label, href, destination) {
      const link = el('a', label);
      link.href = href; link.dataset.path = destination || href.split('#')[0];
      const isCurrent = destination === path && (href.includes('#') ? location.hash === href.slice(href.indexOf('#')) : !location.hash || path !== '/flo');
      if (isCurrent) {
        link.classList.add('active'); link.setAttribute('aria-current', 'page');
        active = { group: container.closest('.portal-nav-group')?.dataset.group || '', label };
      }
      container.append(link);
      return link;
    }

    function setGroup(id, expand) {
      for (const entry of groups) {
        const open = entry.id === id && expand;
        entry.button.setAttribute('aria-expanded', String(open));
        entry.panel.hidden = !open;
      }
      try { if (expand) sessionStorage.setItem('portal_open_group', id);
        else sessionStorage.removeItem('portal_open_group'); } catch { /* storage unavailable */ }
    }

    function addGroup(id, title, links, note) {
      const section = el('section', null, 'portal-nav-group');
      section.dataset.group = id;
      const button = el('button', title, 'portal-group-toggle');
      button.type = 'button'; button.setAttribute('aria-controls', 'portal-group-' + id);
      button.setAttribute('aria-expanded', 'false');
      const panel = el('div', null, 'portal-submenu'); panel.id = 'portal-group-' + id; panel.hidden = true;
      section.append(button, panel);
      for (const [label, href, destination] of links) addLink(panel, label, href, destination);
      if (note) {
        panel.append(el('p', note, 'portal-nav-note'));
        const retry = el('button', 'Retry catalog', 'portal-catalog-retry');
        retry.type = 'button';
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          renderPortal(session, entitlements, await loadData(entitlements));
        });
        panel.append(retry);
      }
      button.addEventListener('click', () => setGroup(id, button.getAttribute('aria-expanded') !== 'true'));
      groups.push({ id, button, panel }); sidebar.append(section);
    }

    const floEnabled = account.role === 'org_admin' && data.flo?.enabled === true;
    if (floEnabled) {
      const links = [['Applications and reports', '/flo', '/flo'], ['Create onboarding link', '/flo#new-application', '/flo']];
      if (data.flo.workflow_platform_enabled) links.push(['Workflows', '/flo-workflows', '/flo-workflows']);
      addGroup('flo', 'Flo', links);
    }
    const verificationLinks = verification.filter((entry) => allowed(entitlements, entry[2]))
      .map(([href, label]) => [label, href, href]);
    if (verificationLinks.length) addGroup('verification', 'Verification API', verificationLinks);
    const ocrLinks = (data.ocr || []).filter((entry) => allowed(entitlements, entry.id))
      .map((entry) => [entry.name.replace(/\s*\([^)]*\)\s*$/, ''), '/document-extraction/' + entry.id,
        '/document-extraction/' + entry.id]);
    if (ocrLinks.length || data.ocrFailed) addGroup('ocr', 'OCR', ocrLinks,
      data.ocrFailed ? 'OCR services could not be loaded.' : '');
    const formsAllowed = allowed(entitlements, 'forms');
    if (formsAllowed) {
      const links = [['All Forms', '/forms', '/forms'], ...(data.forms?.forms || [])
        .map((form) => [form.name, '/forms/' + form.id, '/forms/' + form.id])];
      addGroup('forms', 'Forms', links, data.formsFailed ? 'Forms could not be loaded.' : '');
      if (!data.formsFailed && !(data.forms?.forms || []).length)
        groups.at(-1).panel.append(el('p', 'No Forms are enabled for this workspace.', 'portal-nav-note'));
    }
    const direct = el('div', null, 'portal-nav-direct');
    if (data.cases?.available) addLink(direct, 'API Case Manager', '/cases', '/cases');
    addLink(direct, 'Account Settings', '/account', '/account');
    addLink(direct, 'Usage & Billing', '/usage', '/usage');
    addLink(direct, 'API Keys', '/api-keys', '/api-keys');
    sidebar.append(direct);
    const identity = el('div', null, 'portal-account');
    identity.append(el('span', 'WORKSPACE'), el('strong', account.client_name || 'API workspace'),
      el('small', account.email || ''));
    const signOut = el('button', 'Sign out'); signOut.type = 'button'; identity.append(signOut);
    sidebar.append(identity);
    document.body.prepend(sidebar);

    const header = document.querySelector('header');
    let menu = null;
    if (header) {
      header.classList.add('portal-header');
      header.querySelector('nav')?.remove();
      header.querySelector('.brand')?.remove();
      header.querySelector('#portal-menu')?.remove();
      header.querySelector('.portal-context')?.remove();
      menu = el('button', '☰', 'portal-menu');
      menu.type = 'button'; menu.id = 'portal-menu';
      menu.setAttribute('aria-controls', 'portal-sidebar');
      menu.setAttribute('aria-expanded', 'false');
      menu.setAttribute('aria-label', 'Open navigation');
      const context = el('div', null, 'portal-context');
      const fallback = path === '/flo' ? ['Flo', 'Applications and reports']
        : path === '/cases' ? ['Workspace', 'API Case Manager']
          : path === '/usage' ? ['Workspace', 'Usage & Billing']
            : path === '/api-keys' ? ['Workspace', 'API Keys']
              : path === '/account' ? ['Workspace', 'Account Settings']
                : formPath ? ['Forms', path.split('/').at(-1)]
                  : ocrPath ? ['OCR', path.split('/').at(-1)] : ['Verification API', 'Workspace'];
      const groupTitle = { flo: 'Flo', verification: 'Verification API', ocr: 'OCR', forms: 'Forms' };
      context.append(el('span', groupTitle[active?.group] || fallback[0]),
        el('strong', active?.label || fallback[1]));
      header.prepend(menu); menu.after(context);
    }
    const overlay = el('button', null, 'portal-overlay');
    overlay.type = 'button'; overlay.setAttribute('aria-label', 'Close navigation');
    document.body.append(overlay);
    const mobile = window.matchMedia('(max-width: 760px)');
    function setDrawer(open, returnFocus = false) {
      document.body.classList.toggle('portal-menu-open', open);
      menu?.setAttribute('aria-expanded', String(open));
      menu?.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
      sidebar.inert = mobile.matches && !open;
      for (const child of document.body.children)
        if (child !== sidebar && child !== overlay) child.inert = mobile.matches && open;
      if (open) sidebar.querySelector('button, a')?.focus();
      else if (returnFocus) menu?.focus();
    }
    menu?.addEventListener('click', () => setDrawer(!document.body.classList.contains('portal-menu-open'), true));
    overlay.addEventListener('click', () => setDrawer(false, true));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.body.classList.contains('portal-menu-open')) {
        event.preventDefault(); setDrawer(false, true);
      }
    }, { signal: navigationAbort.signal });
    mobile.addEventListener('change', () => setDrawer(false), { signal: navigationAbort.signal });
    setDrawer(false);
    const activeGroup = active?.group || (path === '/flo-workflows' ? 'flo' : '');
    let remembered = '';
    try { remembered = sessionStorage.getItem('portal_open_group') || ''; } catch { /* storage unavailable */ }
    if (activeGroup || remembered) setGroup(activeGroup || remembered, true);
    signOut.addEventListener('click', async () => {
      signOut.disabled = true;
      const response = await fetch('/portal/api/auth/logout', { method: 'POST', credentials: 'same-origin',
        headers: { 'x-ai7-csrf': session.csrf_token, accept: 'application/json' } });
      if (response.ok) location.replace('/login');
      else signOut.disabled = false;
    });
    document.body.classList.add('portal-ready');
    document.dispatchEvent(new Event('portal:navigation-ready'));
  }

  async function loadSession() {
    const response = await fetch('/portal/api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) { if (protectedPaths.has(path) || formPath || ocrPath) location.replace(loginTarget()); return; }
    const session = await response.json();
    const entitlements = await getJson('/portal/api/entitlements');
    renderPortal(session, entitlements, await loadData(entitlements));
  }
  loadSession().catch(() => {
    if (protectedPaths.has(path) || formPath || ocrPath) location.replace(loginTarget());
  });
})();
