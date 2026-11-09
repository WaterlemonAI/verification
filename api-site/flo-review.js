(() => {
  const el = (tag, value, className) => {
    const node = document.createElement(tag);
    if (value != null) node.textContent = String(value);
    if (className) node.className = className;
    return node;
  };
  const display = (value) => value === true ? 'Yes' : value === false ? 'No'
    : value == null || value === '' ? 'Not supplied' : Array.isArray(value) ? value.length ? value.map(display).join(', ') : 'Not supplied'
      : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const nice = (key) => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const latest = (items, type) => (items || []).filter((item) => item.type === type).at(-1);
  function pairs(parent, source, keys) {
    const grid = el('dl', null, 'flo-facts');
    for (const key of keys) {
      if (source?.[key] == null || source[key] === '' || Array.isArray(source[key]) && !source[key].length) continue;
      const dt = el('dt', key === 'supplier_email' ? 'Recipient Email' : nice(key));
      const dd = el('dd', display(source?.[key]));
      grid.append(dt, dd);
    }
    if (grid.children.length) parent.append(grid);
    else parent.append(el('p', 'No values recorded.', 'flo-empty'));
  }
  function section(parent, title, source, keys) {
    const card = el('section', null, 'flo-review-section'); card.append(el('h3', title)); pairs(card, source, keys); parent.append(card);
  }
  function extractedRows(value, path = '', rows = [], depth = 0) {
    if (rows.length >= 80) return rows;
    if (value && typeof value === 'object' && depth < 5) {
      const entries = Array.isArray(value) ? value.slice(0, 20).map((entry, index) => [index + 1, entry])
        : Object.entries(value).slice(0, 50);
      for (const [key, entry] of entries) extractedRows(entry, path ? `${path} · ${nice(key)}` : nice(key), rows, depth + 1);
    } else if (value != null && value !== '') rows.push([path || 'Value', display(value).slice(0, 2000)]);
    return rows;
  }
  function signals(item) {
    const results = []; const documents = item.documents || [];
    const missingAnswers = (item.review_requirements?.text || [])
      .filter((key) => item.draft?.[key] == null || String(item.draft[key]).trim() === '');
    if (missingAnswers.length) results.push({ level: 'blocker', title: 'Required answers missing',
      detail: missingAnswers.map(nice).join(', ') });
    for (const type of item.review_requirements?.documents || []) {
      const doc = latest(documents, type);
      if (!doc) results.push({ level: 'blocker', title: `${nice(type)} missing`, detail: 'Required document has not been uploaded.' });
      else if (['substitute', 'test_sample', 'unexecuted_draft'].includes(doc.diagnostic_label))
        results.push({ level: 'blocker', title: `${nice(type)} is ${nice(doc.diagnostic_label).toLowerCase()}`, detail: 'Present for the controlled test; genuine evidence is still required.' });
    }
    for (const issue of item.preview_issues || []) results.push({ level: issue.severity === 'error' ? 'blocker' : 'warning',
      title: nice(issue.code || 'Evidence issue'), detail: issue.message || issue.field || 'Review the evidence.' });
    for (const doc of documents.filter((row) => row.extraction_state === 'failed')) results.push({ level: 'warning',
      title: `${nice(doc.type)} extraction failed`, detail: doc.extraction_reason || 'No extracted values are available.' });
    for (const comparison of (item.comparisons || []).filter((row) => row.outcome === 'mismatch'))
      results.push({ level: 'warning', title: `${nice(comparison.rule)} mismatch`, detail: comparison.reason || 'Source values differ.' });
    for (const check of (item.checks || []).filter((row) => row.transport === 'failed' || row.business_result === 'requires_review'))
      results.push({ level: 'warning', title: `${nice(check.service_id)} needs review`,
        detail: [check.transport, check.coverage, ...(check.reason_codes || [])].filter(Boolean).join(' · ') });
    if (item.diagnostic?.outcome) results.unshift({ level: 'blocker', title: `Diagnostic: ${nice(item.diagnostic.outcome)}`,
      detail: item.diagnostic.rationale || 'Buyer diagnostic outcome.' });
    return results;
  }
  function signalCard(signal) {
    const row = el('li', null, `flo-signal flo-${signal.level}`);
    row.append(el('span', signal.level, 'flo-signal-level'), el('strong', signal.title), el('small', signal.detail));
    return row;
  }
  function renderOverview(panel, item, derived) {
    panel.append(el('p', item.diagnostic ? 'Controlled diagnostic · no supplier submission or approval is implied.'
      : 'Automated analysis supports the buyer review; it does not make the decision.', 'flo-review-note'));
    const brief = el('section', null, 'flo-review-section flo-brief'); brief.append(el('p', 'DECISION BRIEF', 'flo-kicker'),
      el('h3', derived.signals.length ? 'What needs your attention' : 'No review signals recorded'));
    const list = el('ul', null, 'flo-signal-list');
    if (derived.signals.length) derived.signals.slice(0, 6).forEach((signal) => list.append(signalCard(signal)));
    else list.append(el('li', 'This is not an automated clearance. Inspect the source documents and checks.'));
    if (derived.signals.length > 6) list.append(el('li', `${derived.signals.length - 6} more review signals. See Documents and Checks.`, 'flo-signal-more'));
    brief.append(list); panel.append(brief);

    const workspace = el('div', null, 'flo-overview-grid');
    const identity = el('section', null, 'flo-review-section'); identity.append(el('p', 'APPLICANT', 'flo-kicker'),
      el('h3', item.draft?.tradingName || item.draft?.business_name || 'Name not supplied'));
    pairs(identity, { type: item.draft?.supplierType || item.draft?.company_type,
      email: item.supplier_email, representative: item.draft?.representativeEmail,
      licence: item.draft?.licence_number || item.documents?.find((doc) => doc.type === 'tradeLicenceFile')?.extraction_result?.data?.license_number },
    ['type', 'email', 'representative', 'licence']);
    workspace.append(identity);
    const journey = el('section', null, 'flo-review-section'); journey.append(el('p', 'APPLICATION', 'flo-kicker'),
      el('h3', nice(item.status)));
    pairs(journey, item, ['flow_id', 'created_at', 'submitted_at', 'preview_ready_at']);
    workspace.append(journey); panel.append(workspace);

    const evidence = el('section', null, 'flo-review-section'); evidence.append(el('p', 'EVIDENCE READINESS', 'flo-kicker'),
      el('h3', 'Required documents'));
    const required = el('div', null, 'flo-required-grid');
    for (const type of item.review_requirements?.documents || []) {
      const doc = latest(item.documents, type); const row = el('div', null, `flo-required-item ${doc ? 'flo-present' : 'flo-missing'}`);
      row.append(el('span', doc ? '✓' : '!', 'flo-required-icon'), el('strong', nice(type)),
        el('small', doc ? doc.diagnostic_label ? `${nice(doc.diagnostic_label)} · review quality` : 'Uploaded · review quality' : 'Missing'));
      required.append(row);
    }
    if (!required.children.length) required.append(el('p', 'No document requirements available for this flow.'));
    evidence.append(required); panel.append(evidence);

    const recent = el('section', null, 'flo-review-section'); recent.append(el('p', 'RECENT ACTIVITY', 'flo-kicker'));
    for (const event of (item.events || []).slice(-3).reverse()) recent.append(el('p', `${nice(event.type)} · ${display(event.at)}`, 'flo-recent-event'));
    if (!item.events?.length) recent.append(el('p', 'No activity recorded.', 'flo-empty'));
    panel.append(recent);
  }
  function renderProfile(panel, item) {
    panel.append(el('p', 'Declared or buyer-inferred application details. Document extraction and checks appear in their own tabs.', 'flo-review-note'));
    const profile = el('div', null, 'flo-profile-grid'); panel.append(profile);
    section(profile, 'Case identity', item, ['application_id', 'customer_reference', 'flow_id', 'template_version', 'status',
      'supplier_email', 'created_at', 'updated_at', 'submitted_at', 'preview_ready_at']);
    const provenance = el('details', null, 'flo-review-section'); provenance.append(el('summary', 'Case provenance'));
    pairs(provenance, item, ['workspace_id', 'definition_hash', 'expires_at', 'link_expires_at', 'link_redeemed_at']);
    profile.append(provenance);
    if (Object.keys(item.prefill || {}).length) {
      const prefill = el('section', null, 'flo-review-section'); prefill.append(el('h3', 'Link prefill'),
        el('pre', JSON.stringify(item.prefill, null, 2)));
      profile.append(prefill);
    }
    const draft = item.draft || {};
    section(profile, 'Legal identity and representative', draft, ['supplierType', 'tradingName', 'formerNames', 'business_name',
      'licence_number', 'company_type', 'representativeEmail', 'representativePhone', 'representativeTitle',
      'identityType', 'authorityBasis', 'ownershipComplete', 'meetingAvailability']);
    section(profile, 'People and ownership', draft, ['owners', 'stakeholders', 'keyPersonChanges', 'keyPersonExplanation']);
    section(profile, 'Premises and operating profile', draft, ['locationEvidenceType', 'registeredAddressSame', 'registered_address',
      'operatingAddress', 'operating_address', 'fulfilmentLocations', 'addressChanges', 'addressChangeExplanation',
      'siteActivities', 'activities', 'website', 'website_url']);
    section(profile, 'Tax, bank and payment profile', draft, ['vatRegistered', 'vatReason', 'iban', 'thirdPartyPayments',
      'thirdPartyDetail', 'cashPayment', 'cashDetail']);
    section(profile, 'Supply and procurement', draft, ['supplyType', 'supplyDescription', 'staffCount', 'unusualCapacity',
      'capacityDetail', 'goodsOrigin', 'goodsRights', 'goodsRightsDetail', 'intermediary', 'intermediaryDetail',
      'priceExplanation', 'recommendationNote']);
    section(profile, 'Declarations', draft, ['accuracyDeclaration', 'screeningConsent', 'controlledTest', 'testDeclaration']);
  }
  function renderDocuments(panel, item) {
    const layout = el('div', null, 'flo-document-layout'); const list = el('div', null, 'flo-document-list');
    const viewer = el('div', null, 'flo-document-viewer'); layout.append(list, viewer); panel.append(layout);
    function select(doc) {
      for (const button of list.querySelectorAll('button')) button.classList.toggle('active', button.dataset.documentId === doc.document_id);
      viewer.replaceChildren(el('h3', nice(doc.type)), el('p', `Uploaded ${display(doc.uploaded_at)} · ${display(doc.size)} bytes`));
      const path = `/portal/api/flo/cases/${encodeURIComponent(item.application_id)}/documents/${encodeURIComponent(doc.document_id)}`;
      const frame = doc.mime_type === 'application/pdf' ? el('iframe') : el('img');
      frame.src = `${path}?view=inline`; frame.className = 'flo-document-frame';
      if (frame.tagName === 'IFRAME') { frame.title = `${nice(doc.type)} document preview`; frame.setAttribute('referrerpolicy', 'no-referrer'); }
      else frame.alt = `${nice(doc.type)} preview`;
      viewer.append(frame);
      const download = el('a', 'Download original'); download.href = path; viewer.append(download);
      const meta = el('div', null, 'flo-document-meta');
      pairs(meta, doc, ['diagnostic_label', 'mime_type', 'sha256', 'scan_result', 'extraction_state', 'extraction_reason']);
      viewer.append(meta);
      const data = doc.extraction_result?.data;
      const extracted = el('section', null, 'flo-review-section'); extracted.append(el('h4', 'Extracted values'));
      const rows = data ? extractedRows(data) : [];
      if (rows.length) {
        const values = el('dl', null, 'flo-facts');
        for (const [path, value] of rows) values.append(el('dt', path), el('dd', value));
        extracted.append(values);
      } else extracted.append(el('p', 'No extracted values available.', 'flo-empty'));
      viewer.append(extracted);
      const linked = (item.facts || []).filter((fact) => fact.source_id === doc.document_id);
      const comparisons = (item.comparisons || []).filter((comparison) => comparison.source_ids?.includes(doc.document_id)
        || linked.some((fact) => [comparison.left_fact_id, comparison.right_fact_id].includes(fact.fact_id)));
      if (linked.length || comparisons.length) {
        const sources = el('section', null, 'flo-review-section'); sources.append(el('h4', 'Linked review evidence'));
        const rows = el('ul');
        for (const fact of linked) rows.append(el('li', `${fact.field_path}: ${display(fact.value)} · ${display(fact.confidence)}`));
        for (const comparison of comparisons) rows.append(el('li', `${nice(comparison.rule)}: ${comparison.outcome} · ${display(comparison.reason)}`));
        sources.append(rows); viewer.append(sources);
      }
    }
    for (const doc of item.documents || []) {
      const button = el('button', null, 'flo-document-item'); button.type = 'button'; button.dataset.documentId = doc.document_id;
      button.append(el('strong', nice(doc.type)), el('small', `${doc.diagnostic_label ? `${nice(doc.diagnostic_label)} · ` : ''}${display(doc.extraction_state)}`));
      button.addEventListener('click', () => select(doc)); list.append(button);
    }
    if (item.documents?.length) select(item.documents[0]); else viewer.append(el('p', 'No documents uploaded.'));
  }
  function renderAssessments(panel, item) {
    const checks = el('section', null, 'flo-review-section'); checks.append(el('h3', 'Provider checks'));
    if (!item.checks?.length) checks.append(el('p', 'No checks have run.'));
    for (const check of item.checks || []) {
      const card = el('article', null, 'flo-assessment');
      card.append(el('strong', nice(check.service_id)), el('p', `${check.transport} · coverage ${check.coverage} · ${check.business_result}`),
        el('small', `Subject ${check.subject_id} · ${(check.reason_codes || []).join(', ') || 'No reason code'}`));
      checks.append(card);
    }
    panel.append(checks);
    if (item.check_history?.length) {
      const history = el('section', null, 'flo-review-section'); history.append(el('h3', 'Previous check runs'));
      for (const run of item.check_history) history.append(el('p', `${display(run.at || run.created_at)} · ${display(run.reason || run.status)} · ${display(run.checks?.length)} checks`));
      panel.append(history);
    }
    const subjects = el('section', null, 'flo-review-section'); subjects.append(el('h3', 'Screened subjects'));
    for (const subject of item.subjects || []) subjects.append(el('p', `${subject.name} · ${subject.type} · ${(subject.roles || []).join(', ')}`));
    if (!item.subjects?.length) subjects.append(el('p', 'No subjects identified.'));
    panel.append(subjects);
    const comparisons = el('section', null, 'flo-review-section'); comparisons.append(el('h3', 'Cross-document comparisons'));
    for (const comparison of item.comparisons || []) comparisons.append(el('p', `${nice(comparison.rule)}: ${comparison.outcome} · ${display(comparison.reason)}`));
    if (!item.comparisons?.length) comparisons.append(el('p', 'No comparisons available.'));
    panel.append(comparisons);
    const facts = el('section', null, 'flo-review-section'); facts.append(el('h3', 'Source facts'));
    for (const fact of item.facts || []) facts.append(el('p', `${fact.field_path}: ${display(fact.value)} · ${display(fact.source_id)} · ${display(fact.confidence)}`));
    if (!item.facts?.length) facts.append(el('p', 'No source facts extracted.'));
    panel.append(facts);
    const ai = el('section', null, 'flo-review-section'); ai.append(el('h3', 'AI evidence review'));
    ai.append(el('p', item.gemini_review ? `${item.gemini_review.status} · ${(item.gemini_review.reason_codes || item.gemini_review.validation_errors || []).join(', ')}` : 'Not run'));
    panel.append(ai);
  }
  function renderActivity(panel, item) {
    const routing = el('section', null, 'flo-review-section'); routing.append(el('h3', 'Flow and callback routing'));
    pairs(routing, item.configuration || {}, ['brand_name', 'callback_url', 'success_url', 'failure_url']);
    panel.append(routing);
    const reports = el('section', null, 'flo-review-section'); reports.append(el('h3', 'Retained reports'));
    for (const report of item.reports || []) {
      const row = el('p', `Version ${report.version} · ${report.generated_at} `);
      for (const [label, suffix] of [['PDF', ''], ['HTML', '.html'], ['JSON', '.json']]) {
        const link = el('a', label); link.href = `/portal/api/flo/cases/${item.application_id}/reports/${report.version}${suffix}`;
        row.append(link, document.createTextNode('  '));
      }
      reports.append(row);
    }
    if (!item.reports?.length) reports.append(el('p', 'No report generated.'));
    panel.append(reports);
    const events = el('section', null, 'flo-review-section'); events.append(el('h3', 'Case activity and callbacks'));
    const list = el('ol', null, 'flo-event-list');
    for (const event of item.events || []) list.append(el('li', `${event.at} · ${nice(event.type)} · ${event.actor || 'system'}${event.http_status ? ` · HTTP ${event.http_status}` : ''}${event.reason_code ? ` · ${event.reason_code}` : ''}`));
    events.append(list); panel.append(events);
  }
  window.FloReview = { render(shell, item) {
    const documents = item.documents || []; const required = item.review_requirements?.documents || [];
    const present = required.filter((type) => documents.some((doc) => doc.type === type)).length;
    const derived = { signals: signals(item) }; const blockers = derived.signals.filter((signal) => signal.level === 'blocker').length;
    const summary = el('div', null, 'flo-review-summary');
    for (const [label, value, note] of [
      ['Approval blockers', blockers, `${derived.signals.length - blockers} additional review signals`],
      ['Required documents present', `${present} / ${required.length}`, 'Presence does not confirm authenticity or adequacy'],
      ['Risk conclusion', 'Not scored', 'Review provider results and source evidence']
    ]) { const card = el('div', null, 'flo-summary-card'); card.append(el('small', label), el('strong', value), el('span', note)); summary.append(card); }
    shell.append(summary);
    const tabs = el('div', null, 'flo-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Case review');
    const panels = {}; const names = ['Overview', 'Profile', 'Documents', 'Checks', 'Activity'];
    for (const name of names) {
      const key = name.toLowerCase(); const button = el('button', `${name} ${name === 'Documents' ? documents.length : name === 'Checks' ? (item.checks || []).length : name === 'Activity' ? (item.events || []).length : ''}`.trim());
      button.type = 'button'; button.id = `flo-tab-${key}`; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `flo-panel-${key}`);
      const panel = el('section', null, 'flo-tab-panel'); panel.id = `flo-panel-${key}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
      panels[key] = panel;
      button.addEventListener('click', () => { for (const other of names.map((value) => value.toLowerCase())) {
        panels[other].hidden = other !== key; document.getElementById(`flo-tab-${other}`).setAttribute('aria-selected', String(other === key));
      } });
      tabs.append(button);
    }
    tabs.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...tabs.querySelectorAll('[role="tab"]')];
      const current = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[next].focus(); buttons[next].click();
    });
    shell.append(tabs, ...names.map((name) => panels[name.toLowerCase()]));
    renderOverview(panels.overview, item, derived); renderProfile(panels.profile, item);
    renderDocuments(panels.documents, item); renderAssessments(panels.checks, item); renderActivity(panels.activity, item);
    tabs.firstChild.click();
    return panels.overview;
  } };
})();
