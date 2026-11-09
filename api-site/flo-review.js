(() => {
  const el = (tag, value, className) => {
    const node = document.createElement(tag);
    if (value != null) node.textContent = String(value);
    if (className) node.className = className;
    return node;
  };
  const display = (value) => value === true ? 'Yes' : value === false ? 'No'
    : value == null || value === '' ? 'Not supplied' : Array.isArray(value) ? `${value.length} items`
      : typeof value === 'object' ? `${Object.keys(value).length} fields` : String(value);
  const nice = (key) => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(Aml|Iban|Vat|Ubo|Uae|Ai7edd)\b/g, (word) => word.toUpperCase());
  const latest = (items, type) => (items || []).filter((item) => item.type === type).at(-1);
  function humanValue(value) {
    if (Array.isArray(value)) {
      if (!value.length) return el('span', 'None recorded', 'flo-empty');
      const list = el('ol', null, 'flo-data-list');
      for (const entry of value) {
        const row = el('li'); row.append(humanValue(entry)); list.append(row);
      }
      return list;
    }
    if (value && typeof value === 'object') {
      const grid = el('dl', null, 'flo-facts flo-nested-facts');
      for (const [key, entry] of Object.entries(value)) {
        if (entry == null || entry === '') continue;
        const field = el('dd'); field.append(humanValue(entry));
        grid.append(el('dt', nice(key)), field);
      }
      return grid.children.length ? grid : el('span', 'No values recorded', 'flo-empty');
    }
    return el('span', display(value));
  }
  function pairs(parent, source, keys) {
    const grid = el('dl', null, 'flo-facts');
    for (const key of keys) {
      if (source?.[key] == null || source[key] === '' || Array.isArray(source[key]) && !source[key].length) continue;
      const dt = el('dt', key === 'supplier_email' ? 'Recipient Email' : nice(key));
      const dd = el('dd'); dd.append(humanValue(source[key]));
      grid.append(dt, dd);
    }
    if (grid.children.length) parent.append(grid);
    else parent.append(el('p', 'No values recorded.', 'flo-empty'));
  }
  function section(parent, title, source, keys) {
    const card = el('section', null, 'flo-review-section'); card.append(el('h3', title)); pairs(card, source, keys); parent.append(card);
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
  function screeningState(check) {
    if (!check || check.transport === 'not_run') return 'Not run';
    if (check.transport !== 'completed') return 'Unavailable';
    if (check.raw_response?.flagged === true || check.raw_response?.alert === true)
      return 'Potential flag';
    if (Array.isArray(check.raw_response?.matches) && check.raw_response.matches.length)
      return `${check.raw_response.matches.length} potential matches`;
    if (check.coverage !== 'complete') return 'Incomplete';
    return 'Review result';
  }
  function renderScreening(panel, item) {
    const card = el('section', null, 'flo-review-section flo-screening');
    card.append(el('p', 'SCREENING FLAGS', 'flo-kicker'), el('h3', 'AML and adverse media'));
    const grid = el('div', null, 'flo-screening-grid');
    const subjects = new Map((item.subjects || []).map((subject) => [subject.subject_id, subject.name]));
    for (const [title, suffix] of [['AML', '-aml'], ['Adverse media', '-adverse-media']]) {
      const checks = (item.checks || []).filter((check) => check.service_id?.endsWith(suffix));
      const states = checks.map(screeningState);
      const summaryState = !checks.length ? 'Not run' : states.some((state) => /potential/i.test(state)) ? 'Potential flag'
        : states.some((state) => ['Not run', 'Unavailable', 'Incomplete'].includes(state)) ? 'Incomplete' : 'Review results';
      const group = el('details', null, 'flo-screening-group');
      const heading = el('summary'); heading.append(el('strong', title),
        el('span', summaryState, `flo-screening-status ${/potential/i.test(summaryState) ? 'flo-flag' : summaryState === 'Incomplete' || summaryState === 'Not run' ? 'flo-unavailable' : 'flo-review'}`),
        el('small', `${checks.length} ${checks.length === 1 ? 'check' : 'checks'} · expand details`));
      group.append(heading);
      if (!checks.length) group.append(el('p', 'No screening check has run.', 'flo-empty'));
      for (const check of checks) {
        const result = el('article', null, 'flo-screening-result');
        result.append(el('strong', subjects.get(check.subject_id) || nice(check.service_id)),
          el('span', screeningState(check), 'flo-screening-result-state'));
        pairs(result, check, ['service_id', 'transport', 'coverage', 'business_result', 'reason_codes',
          'http_status', 'started_at', 'completed_at']);
        if (check.raw_response != null) {
          const evidence = el('details', null, 'flo-screening-evidence'); evidence.append(el('summary', 'Provider response'));
          evidence.addEventListener('toggle', () => {
            if (evidence.open && evidence.children.length === 1) evidence.append(humanValue(check.raw_response));
          });
          result.append(evidence);
        }
        group.append(result);
      }
      grid.append(group);
    }
    card.append(grid); panel.append(card);
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
    renderScreening(panel, item);

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
        humanValue(item.prefill));
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
      pairs(meta, doc, ['document_id', 'diagnostic_label', 'mime_type', 'sha256', 'scan_result',
        'extraction_state', 'extraction_reason']);
      viewer.append(meta);
      if (doc.extraction_result) {
        const { data: _data, ...extractionMeta } = doc.extraction_result;
        if (Object.keys(extractionMeta).length) {
          const details = el('section', null, 'flo-review-section'); details.append(el('h4', 'Extraction details'),
            humanValue(extractionMeta));
          viewer.append(details);
        }
      }
      const data = doc.extraction_result?.data;
      const extracted = el('section', null, 'flo-review-section'); extracted.append(el('h4', 'Extracted values'));
      extracted.append(data ? humanValue(data) : el('p', 'No extracted values available.', 'flo-empty'));
      viewer.append(extracted);
      const linked = (item.facts || []).filter((fact) => fact.source_id === doc.document_id);
      const comparisons = (item.comparisons || []).filter((comparison) => comparison.source_ids?.includes(doc.document_id)
        || linked.some((fact) => [comparison.left_fact_id, comparison.right_fact_id].includes(fact.fact_id)));
      if (linked.length || comparisons.length) {
        const sources = el('section', null, 'flo-review-section'); sources.append(el('h4', 'Linked review evidence'));
        const rows = el('ul');
        for (const fact of linked) {
          const row = el('li'); row.append(el('strong', `${nice(fact.field_path)} · `), humanValue(fact.value),
            el('small', ` · ${display(fact.confidence)}`)); rows.append(row);
        }
        for (const comparison of comparisons) {
          const row = el('li'); row.append(el('strong', `${nice(comparison.rule)} · `), humanValue(comparison)); rows.append(row);
        }
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
      card.append(el('strong', nice(check.service_id)));
      pairs(card, check, ['subject_id', 'transport', 'coverage', 'business_result', 'reason_codes',
        'http_status', 'started_at', 'completed_at']);
      if (check.raw_response != null) {
        const response = el('details', null, 'flo-screening-evidence'); response.append(el('summary', 'Provider response'));
        response.addEventListener('toggle', () => {
          if (response.open && response.children.length === 1) response.append(humanValue(check.raw_response));
        });
        card.append(response);
      }
      checks.append(card);
    }
    panel.append(checks);
    if (item.check_history?.length) {
      const history = el('section', null, 'flo-review-section'); history.append(el('h3', 'Previous check runs'));
      for (const run of item.check_history) {
        const detail = el('details', null, 'flo-assessment'); detail.append(el('summary', `${display(run.at)} · ${run.checks?.length || 0} checks`));
        detail.addEventListener('toggle', () => {
          if (detail.open && detail.children.length === 1) detail.append(humanValue(run));
        });
        history.append(detail);
      }
      panel.append(history);
    }
    const subjects = el('section', null, 'flo-review-section'); subjects.append(el('h3', 'Screened subjects'));
    for (const subject of item.subjects || []) {
      const card = el('article', null, 'flo-assessment'); card.append(el('strong', subject.name || 'Unnamed subject'), humanValue(subject));
      subjects.append(card);
    }
    if (!item.subjects?.length) subjects.append(el('p', 'No subjects identified.'));
    panel.append(subjects);
    const comparisons = el('section', null, 'flo-review-section'); comparisons.append(el('h3', 'Cross-document comparisons'));
    for (const comparison of item.comparisons || []) {
      const card = el('article', null, 'flo-assessment'); card.append(el('strong', nice(comparison.rule)), humanValue(comparison));
      comparisons.append(card);
    }
    if (!item.comparisons?.length) comparisons.append(el('p', 'No comparisons available.'));
    panel.append(comparisons);
    if (item.preview_issues?.length) {
      const issues = el('section', null, 'flo-review-section'); issues.append(el('h3', 'Evidence issues'));
      for (const issue of item.preview_issues) {
        const card = el('article', null, 'flo-assessment'); card.append(el('strong', nice(issue.code)), humanValue(issue));
        issues.append(card);
      }
      panel.append(issues);
    }
    const facts = el('section', null, 'flo-review-section'); facts.append(el('h3', 'Source facts'));
    for (const fact of item.facts || []) {
      const card = el('article', null, 'flo-assessment'); card.append(el('strong', nice(fact.field_path)), humanValue(fact));
      facts.append(card);
    }
    if (!item.facts?.length) facts.append(el('p', 'No source facts extracted.'));
    panel.append(facts);
    const ai = el('section', null, 'flo-review-section'); ai.append(el('h3', 'AI7EDD evidence review'));
    ai.append(item.ai7edd_review ? humanValue(item.ai7edd_review) : el('p', 'Not run'));
    panel.append(ai);
  }
  function renderActivity(panel, item) {
    const routing = el('section', null, 'flo-review-section'); routing.append(el('h3', 'Flow and callback routing'));
    pairs(routing, item.configuration || {}, ['enabled', 'brand_name', 'callback_url', 'success_url', 'failure_url', 'updated_at']);
    panel.append(routing);
    const reports = el('section', null, 'flo-review-section'); reports.append(el('h3', 'Retained reports'));
    for (const report of item.reports || []) {
      const row = el('div', null, 'flo-assessment'); row.append(el('strong', `Version ${report.version} · ${display(report.generated_at)}`),
        humanValue(report));
      for (const [label, suffix] of [['PDF', ''], ['HTML', '.html'], ['JSON', '.json']]) {
        const link = el('a', label); link.href = `/portal/api/flo/cases/${item.application_id}/reports/${report.version}${suffix}`;
        row.append(link, document.createTextNode('  '));
      }
      reports.append(row);
    }
    if (!item.reports?.length) reports.append(el('p', 'No report generated.'));
    panel.append(reports);
    if (item.diagnostic) {
      const diagnostic = el('section', null, 'flo-review-section'); diagnostic.append(el('h3', 'Controlled diagnostic'),
        humanValue(item.diagnostic)); panel.append(diagnostic);
    }
    const events = el('section', null, 'flo-review-section'); events.append(el('h3', 'Case activity and callbacks'));
    for (const event of item.events || []) {
      const detail = el('details', null, 'flo-assessment');
      detail.append(el('summary', `${nice(event.type)} · ${display(event.at)} · ${event.actor || 'system'}`));
      detail.addEventListener('toggle', () => {
        if (detail.open && detail.children.length === 1) detail.append(humanValue(event));
      });
      events.append(detail);
    }
    if (!item.events?.length) events.append(el('p', 'No activity recorded.', 'flo-empty'));
    panel.append(events);
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
    const complete = el('details', null, 'flo-full-json'); complete.append(el('summary', 'Complete application JSON'));
    complete.addEventListener('toggle', () => {
      if (complete.open && complete.children.length === 1)
        complete.append(el('pre', JSON.stringify(item, null, 2)));
    });
    shell.append(complete);
    tabs.firstChild.click();
    return panels.overview;
  } };
})();
