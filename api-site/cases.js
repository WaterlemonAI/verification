(() => {
  const $ = (id) => document.getElementById(id);
  const labels = { passed: 'Passed', failed: 'Failed', review_required: 'Review required',
    extracted: 'Extracted', pending: 'Pending', not_run: 'Not run',
    could_not_complete: 'Could not complete', unclassified: 'Unclassified' };
  let cursor = null;
  let selected = null;

  async function request(path) {
    const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }

  function text(tag, value, className = '') {
    const element = document.createElement(tag);
    element.textContent = value == null ? '—' : String(value);
    if (className) element.className = className;
    return element;
  }

  function renderValue(value, depth = 0) {
    if (value == null || typeof value !== 'object') return text('span', value == null ? 'null' : value, 'case-value');
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item]) : Object.entries(value);
    const details = document.createElement('details');
    details.className = 'case-nested';
    if (depth === 0) details.open = true;
    const summary = text('summary', Array.isArray(value) ? `${entries.length} items` : `${entries.length} fields`);
    const content = document.createElement('div');
    content.className = 'case-nested-content';
    let rendered = false;
    const fill = () => {
      if (rendered) return;
      rendered = true;
      for (const [key, item] of entries) {
        const row = document.createElement('div');
        row.className = 'case-field';
        row.append(text('strong', key), renderValue(item, depth + 1));
        content.append(row);
      }
      if (!entries.length) content.append(text('span', 'No fields'));
    };
    details.addEventListener('toggle', () => { if (details.open) fill(); });
    details.append(summary, content);
    if (details.open) fill();
    return details;
  }

  function renderSummary(item, response) {
    const section = document.createElement('section');
    section.className = 'case-summary';
    section.append(text('h3', 'At a glance'));
    const cards = document.createElement('div'); cards.className = 'case-summary-grid';
    const add = (label, value) => {
      if (value == null || value === '') return;
      const card = document.createElement('div'); card.className = 'case-summary-card';
      card.append(text('small', label), text('strong', value)); cards.append(card);
    };
    const yesNo = (value) => typeof value === 'boolean' ? value ? 'Yes' : 'No' : null;
    add('Business outcome', labels[item.outcome] || 'Unclassified');
    add('Service', item.service_id);
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      if (item.service_id === 'adverse-media') {
        add('Coverage complete', yesNo(response.coverage?.complete));
        add('Decision eligible', yesNo(response.summary?.decision_eligible));
        add('Human review required', yesNo(response.summary?.human_review_required));
      } else if (item.service_id === 'merchant-screening') {
        add('Risk level', typeof response.summary?.risk_level === 'string' ? response.summary.risk_level : null);
        add('Decision eligible', yesNo(response.summary?.decision_eligible));
      } else if (item.service_id === 'bank-statement-analysis') {
        add('Analysis status', typeof response.status === 'string' ? response.status : null);
        add('Decision eligible', yesNo(response.decisionEligible));
        add('Artifacts', Array.isArray(response.artifacts) ? response.artifacts.length : null);
      } else if (item.service_id === 'forms') {
        add('Form status', typeof response.status === 'string' ? response.status : null);
        add('Selected checks', Array.isArray(response.services) ? response.services.length : null);
        add('Decision eligible', yesNo(response.summary?.decision_eligible));
      } else if (item.service_id.endsWith('-ocr') || item.service_id === 'moa-analysis') {
        add('Extraction status', typeof response.status === 'string' ? response.status : response.job?.status);
        add('Extracted fields', response.data && typeof response.data === 'object' ? Object.keys(response.data).length : null);
        add('Artifacts', Array.isArray(response.artifacts) ? response.artifacts.length : null);
      } else {
        add('Supplier status', typeof response.status === 'string' ? response.status : null);
      }
    }
    section.append(cards);
    return section;
  }

  function filterQuery() {
    const query = new URLSearchParams();
    const from = $('case-from').value;
    const through = $('case-to').value;
    if (from) query.set('from', `${from}T00:00:00.000Z`);
    if (through) query.set('to', `${through}T23:59:59.999Z`);
    if ($('case-service').value.trim()) query.set('service', $('case-service').value.trim());
    if ($('case-outcome').value) query.set('outcome', $('case-outcome').value);
    query.set('limit', '25');
    if (cursor) query.set('cursor', cursor);
    return query;
  }

  async function loadCases(append = false) {
    if (!append) { cursor = null; $('case-list').replaceChildren(); }
    $('cases-notice').textContent = 'Loading cases…';
    try {
      const result = await request(`/portal/api/cases?${filterQuery()}`);
      for (const item of result.cases) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'case-list-item';
        button.append(text('strong', item.service_id), text('span', labels[item.outcome] || 'Unclassified', `case-badge case-${item.outcome}`),
          text('small', `${new Date(item.accepted_at).toLocaleString()} · ${item.state}`));
        button.addEventListener('click', () => loadDetail(item.id));
        $('case-list').append(button);
      }
      cursor = result.next_cursor;
      $('cases-more').hidden = !cursor;
      $('cases-notice').textContent = result.cases.length ? '' : append ? 'No more cases.' : 'No cases match these filters.';
    } catch (error) { $('cases-notice').textContent = error.message; }
  }

  async function loadDetail(id) {
    selected = id;
    const panel = $('case-detail');
    panel.replaceChildren(text('p', 'Loading case…'));
    try {
      const result = await request(`/portal/api/cases/${id}`);
      if (selected !== id) return;
      const item = result.case;
      panel.replaceChildren();
      panel.append(text('p', item.service_id, 'label'), text('h2', labels[item.outcome] || 'Unclassified'));
      const meta = document.createElement('dl'); meta.className = 'case-meta';
      for (const [name, value] of [['Accepted', item.accepted_at], ['Expires', item.expires_at],
        ['State', item.state], ['HTTP status', item.final_http_status || 'Pending'],
        ['Reason codes', item.outcome_reason_codes.join(', ') || 'None']]) {
        meta.append(text('dt', name), text('dd', value));
      }
      panel.append(meta, renderSummary(item, result.response));
      if (result.artifacts.length) {
        const artifacts = document.createElement('div'); artifacts.className = 'case-artifacts';
        artifacts.append(text('h3', 'Artifacts'));
        for (const artifact of result.artifacts) {
          const link = document.createElement('a');
          link.href = `/portal/api/cases/${id}/artifacts/${artifact.index}`;
          link.textContent = artifact.name || 'Download artifact';
          artifacts.append(link);
        }
        panel.append(artifacts);
      }
      const tabs = document.createElement('div'); tabs.className = 'case-tabs';
      const readable = text('button', 'Readable result'); readable.type = 'button';
      const plainText = typeof result.response === 'string';
      const raw = text('button', plainText ? 'Final response text' : 'Final response JSON'); raw.type = 'button';
      const copy = text('button', plainText ? 'Copy response' : 'Copy JSON'); copy.type = 'button';
      const view = document.createElement('div'); view.className = 'case-result';
      const showReadable = () => { readable.setAttribute('aria-pressed', 'true'); raw.setAttribute('aria-pressed', 'false');
        view.replaceChildren(result.response == null ? text('p', 'Final result is pending.') : renderValue(result.response)); };
      const showRaw = async () => { readable.setAttribute('aria-pressed', 'false'); raw.setAttribute('aria-pressed', 'true');
        view.replaceChildren(text('p', 'Loading final response…'));
        const response = await fetch(`/portal/api/cases/${id}/json`, { credentials: 'same-origin' });
        if (!response.ok) { view.replaceChildren(text('p', 'Final response is not yet available.')); return; }
        const body = await response.text();
        let formatted = body;
        try { formatted = JSON.stringify(JSON.parse(body), null, 2); } catch { /* supplier text remains text */ }
        view.replaceChildren(text('pre', formatted, 'case-json')); };
      readable.addEventListener('click', showReadable); raw.addEventListener('click', showRaw);
      copy.addEventListener('click', async () => { await navigator.clipboard.writeText(plainText
        ? result.response : JSON.stringify(result.response, null, 2));
        copy.textContent = 'Copied'; });
      tabs.append(readable, raw, copy); panel.append(tabs, view); showReadable();
    } catch (error) { panel.replaceChildren(text('p', error.message)); }
  }

  $('cases-filters').addEventListener('submit', (event) => { event.preventDefault(); loadCases(); });
  $('cases-more').addEventListener('click', () => loadCases(true));
  (async () => {
    try {
      const settings = await request('/portal/api/case-manager/settings');
      if (!settings.available || !settings.policy.enabled) {
        $('cases-notice').textContent = 'Case Manager is not enabled for this workspace. An administrator can enable it in Account settings.';
        return;
      }
      const now = new Date();
      $('case-to').value = now.toISOString().slice(0, 10);
      $('case-from').value = new Date(now.getTime() - 44 * 86_400_000).toISOString().slice(0, 10);
      $('cases-filters').hidden = false;
      await loadCases();
    } catch { location.replace('/login?next=%2Fcases'); }
  })();
})();
