(() => {
  const $ = (id) => document.getElementById(id);
  let csrfToken = '';
  let selected = '';
  let pendingLink = null;
  async function request(path, method = 'GET', data, extraHeaders = {}) {
    const response = await fetch(path, { method, credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json',
        ...(method === 'GET' ? {} : { 'x-ai7-csrf': csrfToken }), ...extraHeaders },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
    return value;
  }
  function node(tag, text, className) { const element = document.createElement(tag); element.textContent = String(text ?? '—'); if (className) element.className = className; return element; }
  function field(label, value) { const div = document.createElement('div'); div.append(node('strong', label), node('span', value)); return div; }
  function showLinkResult(result) {
    const root = $('flo-link-result'); root.replaceChildren(); root.hidden = false;
    root.append(node('strong', result.reused ? 'Application already created' : 'Supplier link created'),
      node('p', `Application ID: ${result.application_id}`));
    if (result.supplier_url) {
      const link = node('a', result.supplier_url); link.href = result.supplier_url;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; root.append(link);
      const copy = node('button', 'Copy link'); copy.type = 'button';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(result.supplier_url); copy.textContent = 'Copied'; }
        catch { copy.textContent = 'Select and copy the link above'; }
      });
      root.append(copy, node('p', 'The link is shown once. Email delivery is not confirmed here.'));
    } else root.append(node('p', 'The one-time link cannot be displayed again after a replay. Check the supplier email.'));
  }
  async function loadFlows() {
    const { flows } = await request('/portal/api/flo/flows');
    const selector = $('flo-link-flow'); selector.replaceChildren();
    for (const flow of flows || []) {
      const option = node('option', `${flow.flow_id} · ${flow.version}`); option.value = flow.flow_id;
      selector.append(option);
    }
    if ([...(flows || [])].some((flow) => flow.flow_id === 'supplier-onboarding-v1'))
      selector.value = 'supplier-onboarding-v1';
    $('flo-link-form').hidden = !flows?.length;
    $('flo-link-unavailable').hidden = Boolean(flows?.length);
  }
  async function createLink(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const fingerprint = JSON.stringify(data);
    if (pendingLink?.fingerprint !== fingerprint)
      pendingLink = { fingerprint, key: crypto.randomUUID() };
    const button = $('flo-link-submit'); button.disabled = true;
    $('flo-notice').textContent = '';
    try {
      const result = await request(`/portal/api/flo/flows/${encodeURIComponent(data.flow_id)}/links`,
        'POST', { customer_reference: data.customer_reference, supplier_email: data.supplier_email },
        { 'idempotency-key': pendingLink.key });
      pendingLink = null;
      showLinkResult(result);
      form.elements.customer_reference.value = '';
      form.elements.supplier_email.value = '';
      await loadCases();
    } catch (error) { $('flo-notice').textContent = error.message; }
    finally { button.disabled = false; }
  }
  async function detail(id) {
    selected = id;
    const { application: item } = await request(`/portal/api/flo/cases/${id}`);
    const root = $('flo-detail'); root.replaceChildren(node('h2', item.customer_reference), node('p', `Status: ${item.status}`));
    const grid = node('div', '', 'flo-detail-grid');
    for (const [label, value] of [['Application ID', item.application_id], ['Created', item.created_at],
      ['Flow', `${item.flow_id} · ${item.template_version}`], ['Supplier', item.supplier_email],
      ['Business', item.draft?.business_name || item.draft?.tradingName],
      ['Licence', item.draft?.licence_number || item.documents?.find((doc) => doc.type === 'tradeLicenceFile')?.extraction_result?.data?.license_number]]) grid.append(field(label, value));
    root.append(grid, node('h3', 'Documents'));
    const docs = document.createElement('ul');
    for (const doc of item.documents || []) {
      const li = document.createElement('li'); const link = node('a', `${doc.type.replaceAll('_', ' ')} · ${doc.document_id}`);
      link.href = `/portal/api/flo/cases/${id}/documents/${doc.document_id}`; li.append(link); docs.append(li);
    }
    root.append(docs, node('h3', 'Checks'));
    const checks = document.createElement('ul');
    for (const check of item.checks || []) checks.append(node('li', `${check.service_id} · ${check.subject_id} · ${check.transport} · ${check.business_result}`));
    root.append(checks);
    if (item.reports?.length) {
      root.append(node('h3', 'Reports'));
      for (const report of item.reports) {
        const row = node('p', `Version ${report.version} · ${report.generated_at} `);
        for (const [label, suffix] of [['Download PDF', ''], ['View HTML', '.html'], ['Download JSON', '.json']]) {
          const link = node('a', label); link.href = `/portal/api/flo/cases/${id}/reports/${report.version}${suffix}`;
          link.style.marginRight = '1rem'; row.append(link);
        }
        root.append(row);
      }
    }
    if (['pending_review', 'needs_correction'].includes(item.status)) {
      root.append(node('h3', 'Buyer decision'));
      const rationale = document.createElement('textarea'); rationale.placeholder = 'Reason for the decision'; root.append(rationale);
      for (const decision of (item.status === 'pending_review' ? ['accepted', 'rejected', 'needs_correction'] : ['rejected', 'needs_correction'])) {
        const button = node('button', decision === 'accepted' ? 'Accept' : decision === 'rejected' ? 'Reject' : 'Request correction');
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { const result = await request(`/portal/api/flo/cases/${id}/decision`, 'POST', { decision, rationale: rationale.value });
            if (result.supplier_url) $('flo-notice').textContent = `Correction link: ${result.supplier_url}`;
            await detail(id); }
          catch (error) { $('flo-notice').textContent = error.message; button.disabled = false; }
        }); root.append(button);
      }
    }
    root.append(node('h3', 'Audit history'));
    const events = document.createElement('ul');
    for (const event of item.events || []) events.append(node('li', `${event.at} · ${event.type} · ${event.actor}`));
    root.append(events);
  }
  async function loadCases() {
    const flow = $('flo-filter').value;
    const { cases } = await request(`/portal/api/flo/cases${flow ? `?flow_id=${encodeURIComponent(flow)}` : ''}`);
    const list = $('flo-list'); list.replaceChildren();
    if (!cases.length) list.append(node('p', 'No Flo applications yet.'));
    for (const item of cases) {
      const button = node('button', '', 'flo-case');
      button.append(node('strong', item.customer_reference),
        node('small', `${item.flow_id} · ${item.template_version} · ${item.status} · ${item.created_at}`));
      button.addEventListener('click', () => detail(item.application_id).catch((error) => { $('flo-notice').textContent = error.message; }));
      list.append(button);
    }
    const filter = $('flo-filter');
    const known = new Set([...filter.options].map((option) => option.value));
    for (const flowId of [...new Set(cases.map((item) => item.flow_id))]) {
      if (known.has(flowId)) continue;
      const option = node('option', flowId); option.value = flowId; filter.append(option);
    }
    return cases;
  }
  async function start() {
    try {
      const session = await request('/portal/api/auth/session'); csrfToken = session.csrf_token;
      $('flo-link-form').addEventListener('submit', createLink);
      await loadFlows();
      await loadCases();
      $('flo-filter').addEventListener('change', () => loadCases().catch((error) => { $('flo-notice').textContent = error.message; }));
    } catch (error) { $('flo-notice').textContent = error.message; }
  }
  start();
})();
