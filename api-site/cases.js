import { buildCasePresentation, serviceName } from './case-result-model.mjs?v=2';

(() => {
  const $ = (id) => document.getElementById(id);
  const labels = { passed: 'Passed', failed: 'Failed', review_required: 'Review required',
    extracted: 'Extracted', analyzed: 'Analyzed', pending: 'Pending', not_run: 'Not run',
    could_not_complete: 'Could not complete', unclassified: 'Unclassified' };
  const outcomeLabel = (item) => item.outcome === 'passed'
    && ['adverse-media', 'merchant-screening'].includes(item.service_id)
    ? 'No material findings' : item.outcome === 'passed' && item.service_id === 'entity-search'
      ? 'No candidates found' : labels[item.outcome] || 'Unclassified';
  const requestStatusLabel = (item) => {
    const labels = { succeeded: 'API succeeded', failed: 'API failed', pending: 'Awaiting final API result',
      other: 'Other HTTP status' };
    const label = labels[item.request_status] || 'Awaiting final API result';
    return item.final_http_status ? `${label} (HTTP ${item.final_http_status})` : label;
  };
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

  function safeEvidenceUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function renderPresentation(item, response) {
    const model = buildCasePresentation(item, response);
    const root = document.createElement('div'); root.className = 'case-presentation';
    if (model.metrics.length) {
      const metrics = document.createElement('div'); metrics.className = 'case-summary-grid';
      for (const metric of model.metrics) {
        const card = document.createElement('div'); card.className = 'case-summary-card';
        card.append(text('small', metric.label), text('strong', metric.value)); metrics.append(card);
      }
      root.append(metrics);
    }
    if (model.note) root.append(text('p', model.note, 'case-guidance'));
    for (const section of model.sections) {
      const block = document.createElement('section'); block.className = 'case-section';
      block.append(text('h3', section.title));
      if (section.fields?.length) {
        const grid = document.createElement('dl'); grid.className = 'case-facts';
        for (const field of section.fields) grid.append(text('dt', field.label), text('dd', field.value));
        block.append(grid);
      }
      if (section.items?.length) {
        const list = document.createElement('div'); list.className = 'case-evidence-list';
        for (const entry of section.items) {
          const card = document.createElement('article'); card.className = 'case-evidence';
          const title = text('h4', entry.title);
          const href = safeEvidenceUrl(entry.url);
          if (href) {
            const link = document.createElement('a'); link.href = href;
            link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.textContent = entry.title || 'Open source';
            title.replaceChildren(link);
          }
          card.append(title);
          if (entry.meta) card.append(text('p', entry.meta, 'case-evidence-meta'));
          if (entry.description) card.append(text('p', entry.description, 'case-evidence-description'));
          if (entry.fields?.length) {
            const facts = document.createElement('dl'); facts.className = 'case-facts';
            for (const field of entry.fields) facts.append(text('dt', field.label), text('dd', field.value));
            card.append(facts);
          }
          list.append(card);
        }
        block.append(list);
      }
      if (section.note) block.append(text('p', section.note, 'case-section-note'));
      root.append(block);
    }
    return root;
  }

  function filterQuery() {
    const query = new URLSearchParams();
    const from = $('case-from').value;
    const through = $('case-to').value;
    const transactionId = $('case-transaction').value.trim();
    if (!transactionId && from) query.set('from', new Date(`${from}T00:00:00.000`).toISOString());
    if (!transactionId && through) query.set('to', new Date(`${through}T23:59:59.999`).toISOString());
    if ($('case-service').value.trim()) query.set('service', $('case-service').value.trim());
    if (transactionId) query.set('transaction_id', transactionId);
    if ($('case-outcome').value) query.set('outcome', $('case-outcome').value);
    if ($('case-request-status').value) query.set('request_status', $('case-request-status').value);
    query.set('limit', '25');
    if (cursor) query.set('cursor', cursor);
    return query;
  }

  async function loadCases(append = false) {
    if (!append) {
      cursor = null; selected = null;
      $('case-list').replaceChildren();
      $('case-detail').replaceChildren(text('p', 'Select a case to review its result.'));
    }
    $('cases-notice').textContent = 'Loading cases…';
    try {
      const result = await request(`/portal/api/cases?${filterQuery()}`);
      for (const item of result.cases) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'case-list-item'; button.dataset.caseId = item.id;
        button.append(text('strong', serviceName(item.service_id)), text('span', outcomeLabel(item), `case-badge case-${item.outcome}`),
          text('small', `${new Date(item.accepted_at).toLocaleString()} · ${requestStatusLabel(item)}`));
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
    document.querySelectorAll('.case-list-item').forEach((button) => {
      button.setAttribute('aria-current', button.dataset.caseId === id ? 'true' : 'false');
    });
    const panel = $('case-detail');
    panel.replaceChildren(text('p', 'Loading case…'));
    try {
      const result = await request(`/portal/api/cases/${id}`);
      if (selected !== id) return;
      const item = result.case;
      panel.replaceChildren();
      panel.append(text('p', serviceName(item.service_id), 'label'), text('h2', outcomeLabel(item)),
        text('p', `${requestStatusLabel(item)} · HTTP status describes the API request, not the verification result.`,
          'case-request-note'));
      if (outcomeLabel(item) === 'No material findings') {
        panel.append(text('p', 'No material findings within completed screening coverage. This is not legal or credit clearance.'));
      }
      if (item.outcome === 'passed' && item.service_id === 'entity-search') {
        panel.append(text('p', 'No candidates were returned in the completed provider checks. This does not certify every underlying source as clear.'));
      }
      const tabs = document.createElement('div'); tabs.className = 'case-tabs';
      const readable = text('button', 'Overview'); readable.type = 'button';
      const plainText = typeof result.response === 'string';
      const raw = text('button', plainText ? 'Final response text' : 'Final response JSON'); raw.type = 'button';
      const copy = text('button', plainText ? 'Copy response' : 'Copy JSON'); copy.type = 'button';
      const view = document.createElement('div'); view.className = 'case-result';
      const showReadable = () => {
        readable.setAttribute('aria-pressed', 'true'); raw.setAttribute('aria-pressed', 'false');
        const overview = renderPresentation(item, result.response);
        if (result.artifacts.length) {
          const artifacts = document.createElement('section'); artifacts.className = 'case-artifacts case-section';
          artifacts.append(text('h3', 'Downloads'));
          for (const artifact of result.artifacts) {
            const link = document.createElement('a');
            link.href = `/portal/api/cases/${id}/artifacts/${artifact.index}`;
            link.textContent = artifact.name || 'Download artifact';
            artifacts.append(link);
          }
          overview.append(artifacts);
        }
        const details = document.createElement('details'); details.className = 'case-technical';
        details.append(text('summary', 'Case details'));
        const meta = document.createElement('dl'); meta.className = 'case-meta';
        for (const [name, value] of [['Accepted', item.accepted_at], ['Expires', item.expires_at],
          ['State', item.state], ['Transaction IDs', item.attempt_ids.join(', ') || 'None'],
          ['HTTP status', item.final_http_status || 'Pending'],
          ['Reason codes', item.outcome_reason_codes.join(', ') || 'None']]) {
          meta.append(text('dt', name), text('dd', value));
        }
        details.append(meta); overview.append(details);
        view.replaceChildren(overview);
      };
      const showRaw = async () => { readable.setAttribute('aria-pressed', 'false'); raw.setAttribute('aria-pressed', 'true');
        view.replaceChildren(text('p', 'Loading final response…'));
        const response = await fetch(`/portal/api/cases/${id}/json`, { credentials: 'same-origin' });
        if (selected !== id || raw.getAttribute('aria-pressed') !== 'true') return;
        if (!response.ok) { view.replaceChildren(text('p', 'Final response is not yet available.')); return; }
        const body = await response.text();
        if (selected !== id || raw.getAttribute('aria-pressed') !== 'true') return;
        let formatted = body;
        try { formatted = JSON.stringify(JSON.parse(body), null, 2); } catch { /* supplier text remains text */ }
        view.replaceChildren(text('pre', formatted, 'case-json')); };
      readable.addEventListener('click', showReadable); raw.addEventListener('click', showRaw);
      copy.addEventListener('click', async () => { await navigator.clipboard.writeText(plainText
        ? result.response : JSON.stringify(result.response, null, 2));
        copy.textContent = 'Copied'; });
      tabs.append(readable, raw, copy); panel.append(tabs, view); showReadable();
      if (window.matchMedia('(max-width: 760px)').matches) panel.scrollIntoView({ block: 'start' });
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
      const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const firstDay = new Date(now);
      firstDay.setDate(firstDay.getDate() - 44);
      $('case-to').value = localDate(now);
      $('case-from').value = localDate(firstDay);
      $('cases-filters').hidden = false;
      await loadCases();
    } catch { location.replace('/login?next=%2Fcases'); }
  })();
})();
