(() => {
  const $ = (id) => document.getElementById(id);
  const actions = [
    { module: 'uae-trade-licence', label: 'Check a trade licence', href: '/' },
    { module: 'iban-verification', label: 'Check an IBAN', href: '/iban' },
    { module: 'forms', label: 'Open Forms', href: '/forms' }
  ];
  const allowed = (access, id) => (access.allowed_modules || []).some((item) => item === '*' || item === id)
    && (access.available_modules || []).includes(id);
  const link = (title, href, detail) => {
    const card = document.createElement('a'); card.className = 'home-card'; card.href = href;
    const heading = document.createElement('strong'); heading.textContent = title;
    const note = document.createElement('span'); note.textContent = detail;
    card.append(heading, note); return card;
  };
  async function json(path) {
    const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('Activity is temporarily unavailable.');
    return response.json();
  }
  async function load() {
    $('home-status').textContent = 'Loading workspace…'; $('home-retry').hidden = true;
    let session; let access;
    try { [session, access] = await Promise.all([json('/portal/api/auth/session'), json('/portal/api/entitlements')]); }
    catch { $('home-status').textContent = 'Workspace data could not be loaded.'; $('home-retry').hidden = false; return; }
    const admin = (session.account?.role || 'org_admin') === 'org_admin';
    $('home-intro').textContent = `${session.account?.client_name || 'Your workspace'} · Choose a task or review recent activity.`;
    $('home-actions').replaceChildren(...actions.filter((item) => allowed(access, item.module))
      .map((item) => link(item.label, item.href, 'Open tool')));
    if (!$('home-actions').children.length) $('home-actions').textContent = 'Checking available tools…';
    const [floStatus, caseSettings] = await Promise.allSettled([
      admin && allowed(access, 'flo') ? json('/portal/api/flo/status') : Promise.resolve(null),
      json('/portal/api/case-manager/settings')
    ]);
    const pending = [];
    if (floStatus.status === 'fulfilled' && floStatus.value?.enabled && floStatus.value?.has_active_flow) {
      if (!$('home-actions').children.length) $('home-actions').replaceChildren();
      $('home-actions').prepend(link('Create an onboarding link', '/flo#new-application', 'Open tool'));
    }
    if (!$('home-actions').children.length) $('home-actions').textContent = 'No tools are enabled for this workspace.';
    if (floStatus.status === 'fulfilled' && floStatus.value?.enabled) {
      $('home-flo-section').hidden = false;
      pending.push(json('/portal/api/flo/cases?limit=5').then(({ cases }) => {
        $('home-flo').replaceChildren(...cases.map((item) => link(item.customer_reference || 'Application', '/flo',
          `${String(item.status || 'open').replaceAll('_', ' ')} · ${item.flow_id}`)));
        if (!cases.length) $('home-flo').textContent = 'No Flo applications yet.';
      }).catch(() => { $('home-flo').textContent = 'Recent Flo applications are unavailable. Open Flo to try again.'; }));
    }
    if (caseSettings.status === 'fulfilled' && caseSettings.value?.available && caseSettings.value?.policy?.enabled) {
      $('home-cases-section').hidden = false;
      pending.push(json('/portal/api/cases?limit=5').then(({ cases }) => {
        $('home-cases').replaceChildren(...cases.map((item) => link(item.service_id || 'API case', '/cases',
          `${String(item.outcome || 'unclassified').replaceAll('_', ' ')} · ${new Date(item.accepted_at).toLocaleDateString()}`)));
        if (!cases.length) $('home-cases').textContent = 'No saved API cases yet.';
      }).catch(() => { $('home-cases').textContent = 'Recent API cases are unavailable. Open Case Manager to try again.'; }));
    }
    $('home-status').textContent = 'Workspace ready. Recent activity loads below.';
    await Promise.all(pending);
    if (floStatus.status === 'rejected' || caseSettings.status === 'rejected') {
      $('home-status').textContent = 'Some activity is unavailable.'; $('home-retry').hidden = false;
    } else $('home-status').textContent = '';
  }
  $('home-retry').addEventListener('click', load);
  load();
})();
