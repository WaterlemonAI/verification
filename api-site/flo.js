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
  async function filePayload(file) {
    if (!file || file.size > 6 * 1024 * 1024) throw new Error('Choose a PDF or image under 6 MB.');
    const mime_type = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    return { mime_type, content_base64: btoa(binary) };
  }
  function showLinkResult(result) {
    const root = $('flo-link-result'); root.replaceChildren(); root.hidden = false;
    root.append(node('strong', result.reused ? 'Application already created' : 'Onboarding link created'),
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
    } else root.append(node('p', 'The one-time link cannot be displayed again after a replay. Check the recipient email.'));
  }
  async function loadFlows() {
    const { flows } = await request('/portal/api/flo/flows');
    const selector = $('flo-link-flow'); selector.replaceChildren();
    if (flows?.length > 1) {
      const prompt = node('option', 'Choose a flow'); prompt.value = ''; prompt.disabled = true;
      selector.append(prompt);
    }
    for (const flow of flows || []) {
      const option = node('option', `${flow.flow_id} · ${flow.version}`); option.value = flow.flow_id;
      selector.append(option);
    }
    if (flows?.length > 1) selector.value = '';
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
    const { application: item, diagnostic_enabled: diagnosticEnabled } = await request(`/portal/api/flo/cases/${id}`);
    for (const button of document.querySelectorAll('#flo-list .flo-case')) {
      button.classList.toggle('active', button.dataset.caseId === id);
      if (button.dataset.caseId === id)
        button.querySelector('small').textContent = `${item.flow_id} · ${item.template_version} · ${item.status} · ${item.created_at}`;
    }
    const shell = $('flo-detail');
    shell.replaceChildren(node('p', 'APPLICATION REVIEW', 'flo-kicker'),
      node('h2', item.customer_reference), node('p', `Status: ${item.status.replaceAll('_', ' ')} · ${item.flow_id}`));
    const overview = window.FloReview.render(shell, item);
    const root = document.createElement('section'); root.className = 'flo-review-section flo-case-actions';
    overview.append(root);
    if (item.reports?.length && !item.reports.some((report) => report.branding === 'AI7EDD')) {
      root.append(node('h3', 'Updated report version'),
        node('p', 'Create a new AI7EDD report from the recorded case evidence. Earlier report versions remain available.'));
      const reissue = node('button', 'Create AI7EDD report version'); reissue.type = 'button';
      reissue.addEventListener('click', async () => {
        reissue.disabled = true; $('flo-notice').textContent = '';
        try {
          const result = await request(`/portal/api/flo/cases/${id}/reports`, 'POST', {});
          $('flo-notice').textContent = `Report version ${result.version} is ready.`;
          await detail(id);
        } catch (error) { $('flo-notice').textContent = error.message; reissue.disabled = false; }
      });
      root.append(reissue);
    }
    if (diagnosticEnabled) {
      root.append(node('h3', 'Controlled pilot diagnostic'),
        node('p', 'This is not a supplier submission or approval. The formation certificate substitutes for a trade licence; the bank letter is a test sample; company drafts are unexecuted; premises evidence is missing.'));
      if (item.diagnostic) {
        root.append(node('p', `Diagnostic: ${item.diagnostic.state}${item.diagnostic.finding ? ` · ${item.diagnostic.finding}` : ''}${item.diagnostic.outcome ? ` · ${item.diagnostic.outcome}` : ''}`));
        if (item.diagnostic.rationale) root.append(node('p', item.diagnostic.rationale));
      }
      if (item.status === 'in_progress' && !['queued', 'running', 'complete'].includes(item.diagnostic?.state)) {
        const types = [
          ['identityFile', 'Identity document', 'unverified'],
          ['moaFile', 'Memorandum draft', 'unexecuted_draft'],
          ['aoaFile', 'Articles draft', 'unexecuted_draft'],
          ['bankConfirmationFile', 'Bank test sample', 'test_sample'],
          ['vatFile', 'Tax certificate', 'unverified']
        ];
        const upload = document.createElement('div');
        for (const [type, label, diagnostic_label] of types) {
          if (item.documents?.some((doc) => doc.type === type)) continue;
          const row = document.createElement('div');
          const file = document.createElement('input'); file.type = 'file'; file.accept = '.pdf,.jpg,.jpeg,.png';
          file.setAttribute('aria-label', label);
          const button = node('button', `Upload ${label}`); button.type = 'button';
          button.addEventListener('click', async () => {
            button.disabled = true; $('flo-notice').textContent = '';
            try {
              const payload = await filePayload(file.files[0]);
              await request(`/portal/api/flo/cases/${id}/diagnostic/documents`, 'POST',
                { type, diagnostic_label, ...payload }); await detail(id);
            } catch (error) { $('flo-notice').textContent = error.message; button.disabled = false; }
          });
          row.append(node('span', `${label}: `), file, button); upload.append(row);
        }
        root.append(upload);
        root.append(node('p', 'Buyer-inferred context for this diagnostic, based on the supplied COF and passport. These fields are not supplier attestations.'));
        const name = document.createElement('input'); name.type = 'text'; name.maxLength = 200;
        name.value = item.draft?.tradingName || 'AETHERIX SYSTEMS - FZCO'; name.setAttribute('aria-label', 'Buyer-inferred entity name');
        root.append(name);
        const run = node('button', 'Run controlled diagnostic'); run.type = 'button';
        run.addEventListener('click', async () => {
          run.disabled = true;
          try { await request(`/portal/api/flo/cases/${id}/diagnostic/run`, 'POST',
            { inferred_draft: { supplierType: 'legal_entity', identityType: 'passport', tradingName: name.value.trim() } });
            await detail(id); }
          catch (error) { $('flo-notice').textContent = error.message; run.disabled = false; }
        }); root.append(run);
      }
      if (item.diagnostic?.state === 'complete' && !item.diagnostic.outcome) {
        const reason = document.createElement('textarea'); reason.placeholder = 'Reason for the controlled diagnostic outcome';
        root.append(reason);
        for (const outcome of ['needs_more_evidence', 'checks_failed', 'inconclusive']) {
          const button = node('button', outcome.replaceAll('_', ' ')); button.type = 'button';
          button.addEventListener('click', async () => {
            button.disabled = true;
            try { await request(`/portal/api/flo/cases/${id}/diagnostic/decision`, 'POST',
              { outcome, rationale: reason.value }); await detail(id); }
            catch (error) { $('flo-notice').textContent = error.message; button.disabled = false; }
          }); root.append(button);
        }
      }
      if (item.diagnostic?.outcome && !item.diagnostic.callback_retry_requested_at
        && (item.events || []).some((event) => ['diagnostic_review_ready', 'diagnostic_decision'].includes(event.type)
          && !(item.events || []).some((attempt) => attempt.type === 'callback_delivered' && attempt.source_event_id === event.event_id))) {
        const retry = node('button', 'Retry undelivered diagnostic callbacks'); retry.type = 'button';
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          try { const result = await request(`/portal/api/flo/cases/${id}/diagnostic/retry-callbacks`, 'POST', {});
            $('flo-notice').textContent = `${result.queued} callback event(s) queued.`; await detail(id); }
          catch (error) { $('flo-notice').textContent = error.message; retry.disabled = false; }
        }); root.append(retry);
      }
      if (['queued', 'running'].includes(item.diagnostic?.state)) {
        const refresh = node('button', 'Refresh diagnostic'); refresh.type = 'button';
        refresh.addEventListener('click', () => detail(id).catch((error) => { $('flo-notice').textContent = error.message; }));
        root.append(refresh);
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
    if (root.childNodes.length) {
      root.prepend(node('p', 'CASE ACTIONS', 'flo-kicker'));
      overview.insertBefore(root, overview.querySelector('.flo-overview-grid'));
    }
    else root.remove();
  }
  async function loadCases() {
    const flow = $('flo-filter').value;
    const { cases } = await request(`/portal/api/flo/cases${flow ? `?flow_id=${encodeURIComponent(flow)}` : ''}`);
    const list = $('flo-list'); list.replaceChildren();
    if (!cases.length) list.append(node('p', 'No Flo applications yet.'));
    for (const item of cases) {
      const button = node('button', '', 'flo-case');
      button.dataset.caseId = item.application_id;
      button.classList.toggle('active', item.application_id === selected);
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
