import { FloBuilderModel, FIELD_TYPES, CANONICAL_COMPONENTS } from './flo-builder-model.js';
import { renderSchemaProgress, renderSchemaStage, requiredDocumentChecklist } from './flo-schema-view.js';

const el = (tag, text = '', className = '') => { const item = document.createElement(tag);
  item.textContent = text; if (className) item.className = className; return item; };
const button = (text, action, className = '') => { const item = el('button', text, className); item.type = 'button';
  item.addEventListener('click', action); return item; };
const inputLabel = (text, value, onChange, type = 'text') => {
  const wrapper = el('label', '', 'flo-property'); const caption = el('span', text); const input = el('input');
  input.type = type; input.value = value ?? ''; input.addEventListener('change', () => onChange(input.value));
  wrapper.append(caption, input); return wrapper;
};
function stageSummary(schema) {
  return `${schema.stages.length} stages · ${schema.stages.reduce((n, stage) => n + stage.fields.length, 0)} fields · `
    + `${schema.stages.reduce((n, stage) => n + stage.documents.length, 0)} documents · ${schema.checks.length} checks`;
}
export function mountFloBuilder(root, { schema, checks = [], validate, onChange = () => {}, readOnly = false }) {
  const model = new FloBuilderModel(schema); let selectedId = schema.stages[0]?.id || null;
  let tab = readOnly ? 'preview' : 'builder', previewStage = 0, width = 'desktop', pendingJson = false;
  let previewIntroVisible = true;
  let issueList = [], previewDraft = {}, sortable = [], jsonEditor = null;
  root.classList.add('flo-builder');
  const tabs = el('div', '', 'flo-builder-tabs');
  const status = el('span', '', 'flo-builder-status'); status.setAttribute('role', 'status');
  const announcement = el('p', '', 'flo-builder-announcement'); announcement.setAttribute('aria-live', 'polite');
  const issueBox = el('div', '', 'flo-builder-issues'); issueBox.setAttribute('role', 'alert');
  const content = el('div', '', 'flo-builder-content');
  const toolbar = el('div', '', 'flo-builder-toolbar');
  root.replaceChildren(tabs, status, toolbar, issueBox, announcement, content);
  function report(message) { announcement.textContent = message; }
  function clearSortables() { for (const instance of sortable) instance.destroy(); sortable = []; }
  function reportError(error) { report(error.message || String(error)); }
  function run(operation, focusId) {
    try { operation(); if (focusId !== undefined) selectedId = focusId; issueList = []; render();
      const focus = content.querySelector(`[data-flo-id="${CSS.escape(selectedId || '')}"] .flo-drag`);
      focus?.focus(); }
    catch (error) { reportError(error); render(); }
  }
  model.onchange = (value) => { onChange(value, model.dirty); updateStatus(); };
  function updateStatus() { const dirty = model.dirty || pendingJson;
    status.textContent = `${stageSummary(model.value)} · ${pendingJson ? 'Unapplied JSON edits' : dirty ? 'Unsaved changes' : 'Saved draft'}`;
    status.dataset.dirty = String(dirty); }
  function updateHistoryActions() {
    for (const action of toolbar.querySelectorAll('[data-history-action]')) action.disabled = pendingJson;
  }
  function issueTarget(path) {
    const parts = path.split('.'); if (parts[0] !== 'stages') return null;
    const stage = model.value.stages[Number(parts[1])]; if (!stage) return null;
    return parts[2] && stage[parts[2]]?.[Number(parts[3])]?.id || stage.id;
  }
  function drawIssues() {
    issueBox.replaceChildren();
    if (!issueList.length) return;
    issueBox.append(el('strong', 'Fix these items before saving or publishing:'));
    const list = el('ul');
    for (const issue of issueList) {
      const target = issueTarget(issue.path);
      const row = el('li'); const item = button(`${issue.path}: ${issue.message}`, () => {
        if (tab === 'json' && pendingJson) { report('Apply the JSON or cancel advanced edits before opening a builder item.'); return; }
        if (target) { selectedId = target; tab = 'builder'; render();
          content.querySelector(`[data-flo-id="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'center' }); }
      });
      row.append(item); list.append(row);
    }
    issueBox.append(list);
  }
  function ensureSelected() { if (!model.position(selectedId)) selectedId = model.value.stages[0]?.id || null; }
  function dragList(container, ids, draggable = '.flo-item', handle = '.flo-drag') {
    if (!window.Sortable || ids.length < 2) return;
    sortable.push(new window.Sortable(container, { animation: 150, handle, draggable,
      forceFallback: draggable === '.flo-stage', fallbackTolerance: 3,
      ghostClass: 'flo-ghost', onEnd: ({ oldIndex, newIndex }) => {
        if (oldIndex === newIndex) return;
        const id = ids[oldIndex]; run(() => { model.move(id, newIndex); report(`${id} moved to position ${newIndex + 1}.`); }, id);
      } }));
  }
  function rowFor(item, kind) {
    const row = el('div', '', 'flo-item'); row.dataset.floId = item.id;
    if (item.id === selectedId) row.classList.add('selected');
    const title = kind === 'stages' ? item.title : item.label;
    const handle = el('button', `↕ ${title}`, 'flo-drag'); handle.type = 'button';
    if (kind === 'stages') handle.classList.add('flo-stage-handle');
    handle.setAttribute('aria-label', `Reorder ${title}. Use arrow keys to move.`);
    handle.addEventListener('click', () => { selectedId = item.id; render(); });
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const position = model.position(item.id);
      const next = position.index + (event.key === 'ArrowUp' ? -1 : 1);
      if (next < 0 || next >= position.length) return;
      run(() => { model.move(item.id, next); report(`${title} moved to position ${next + 1} of ${position.length}.`); }, item.id);
    });
    row.append(handle, el('small', kind === 'fields' ? item.type : kind === 'stages' ? 'Stage' : kind.slice(0, -1)));
    const up = button('↑', () => moveRelative(item.id, -1)); up.setAttribute('aria-label', `Move ${title} up`);
    const down = button('↓', () => moveRelative(item.id, 1)); down.setAttribute('aria-label', `Move ${title} down`);
    const position = model.position(item.id); up.disabled = position.index === 0; down.disabled = position.index === position.length - 1;
    row.append(up, down, button('Copy', () => run(() => { selectedId = model.duplicate(item.id); report(`${title} copied.`); })),
      button('Delete', () => run(() => { model.remove(item.id); selectedId = null; report(`${title} removed.`); }, null)));
    return row;
  }
  function moveRelative(id, delta) { const position = model.position(id); if (!position) return;
    const next = position.index + delta; if (next < 0 || next >= position.length) return;
    run(() => { model.move(id, next); report(`${id} moved to position ${next + 1}.`); }, id); }
  function drawCanvas() {
    const layout = el('div', '', 'flo-builder-grid'); const palette = el('aside', '', 'flo-palette');
    palette.append(el('h3', 'Add components'), el('p', 'Choose a stage, then add a field, document or declaration.'));
    palette.append(button('+ Stage', () => run(() => { selectedId = model.add('stages'); })));
    const fieldSelect = el('select'); fieldSelect.setAttribute('aria-label', 'Field type');
    for (const type of FIELD_TYPES) { const option = el('option', type); option.value = type; fieldSelect.append(option); }
    palette.append(fieldSelect);
    const stageIndex = () => model.position(selectedId)?.stageIndex ?? 0;
    palette.append(button('+ Field', () => run(() => { selectedId = model.add('fields', stageIndex(), fieldSelect.value); })),
      button('+ Document', () => run(() => { selectedId = model.add('documents', stageIndex()); })),
      button('+ Declaration', () => run(() => { selectedId = model.add('declarations', stageIndex()); })));
    palette.append(el('small', 'Up to 8 stages, 80 fields and 30 documents. Conditions can refer only to earlier fields.'));
    const canvas = el('div', '', 'flo-canvas'); canvas.append(el('h3', 'Stage canvas'));
    const stages = el('div', '', 'flo-stage-list');
    for (const stage of model.value.stages) {
      const card = el('section', '', 'flo-stage'); card.append(rowFor(stage, 'stages'));
      for (const kind of ['fields', 'documents', 'declarations']) {
        const heading = el('h4', kind[0].toUpperCase() + kind.slice(1)); card.append(heading);
        const list = el('div', '', 'flo-item-list');
        for (const item of stage[kind]) list.append(rowFor(item, kind));
        card.append(list); dragList(list, stage[kind].map((item) => item.id));
      }
      stages.append(card);
    }
    canvas.append(stages); dragList(stages, model.value.stages.map((stage) => stage.id),
      '.flo-stage', '.flo-stage-handle');
    const properties = el('aside', '', 'flo-properties'); properties.append(el('h3', 'Properties'));
    drawProperties(properties); layout.append(palette, canvas, properties); content.replaceChildren(layout);
  }
  function propertyText(container, name, value, apply, multiline = false) {
    const wrapper = el('label', '', 'flo-property'); wrapper.append(el('span', name));
    const control = el(multiline ? 'textarea' : 'input'); control.value = value ?? '';
    control.addEventListener('change', () => run(() => apply(control.value)));
    wrapper.append(control); container.append(wrapper);
  }
  function drawProperties(container) {
    const found = model.position(selectedId);
    if (!found) { container.append(el('p', 'Select a component.')); return; }
    const item = found.item; container.append(el('p', `Stable ID: ${item.id}`, 'flo-id'));
    if (found.kind === 'stages') {
      propertyText(container, 'Stage title', item.title, (value) => model.update(item.id, { title: value }));
      propertyText(container, 'Description', item.description || '', (value) => model.update(item.id, { description: value }), true);
    } else {
      propertyText(container, 'Label', item.label, (value) => model.update(item.id, { label: value }));
      if (found.kind !== 'declarations') {
        const required = el('label', '', 'flo-property'); const box = el('input'); box.type = 'checkbox'; box.checked = item.required;
        box.addEventListener('change', () => run(() => model.update(item.id, { required: box.checked })));
        required.append(box, el('span', 'Required')); container.append(required);
      }
      if (found.kind === 'fields') {
        const type = el('select'); type.setAttribute('aria-label', 'Field type');
        for (const value of FIELD_TYPES) { const option = el('option', value); option.value = value; type.append(option); }
        type.value = item.type; type.addEventListener('change', () => run(() => model.update(item.id,
          type.value === 'select' ? { type: type.value, options: item.options || ['Option 1'] }
            : { type: type.value, options: undefined })));
        container.append(el('span', 'Field type'), type);
        if (item.type === 'select') propertyText(container, 'Options, one per line', item.options.join('\n'),
          (value) => model.update(item.id, { options: value.split('\n').map((part) => part.trim()).filter(Boolean) }), true);
        propertyText(container, 'Maximum length', item.max_length ?? '', (value) => model.update(item.id,
          { max_length: value ? Number(value) : undefined }), false);
      }
      if (found.kind === 'fields' || found.kind === 'documents') {
        const before = model.value.stages.slice(0, found.stageIndex).flatMap((stage) => stage.fields);
        before.push(...model.value.stages[found.stageIndex].fields.slice(0, found.kind === 'fields' ? found.index : undefined));
        const select = el('select'); select.setAttribute('aria-label', 'Show when earlier field');
        const none = el('option', 'Always show'); none.value = ''; select.append(none);
        for (const field of before) { const option = el('option', `${field.label} (${field.id})`); option.value = field.id; select.append(option); }
        select.value = item.show_if?.field || '';
        select.addEventListener('change', () => run(() => model.update(item.id,
          { show_if: select.value ? { field: select.value, equals: item.show_if?.equals || 'Yes' } : undefined })));
        container.append(el('span', 'Visibility condition'), select);
        if (item.show_if) propertyText(container, 'Equals', item.show_if.equals,
          (value) => model.update(item.id, { show_if: { ...item.show_if, equals: value } }));
      }
    }
  }
  function drawChecks() {
    const panel = el('section', '', 'flo-check-panel'); panel.append(el('h3', 'Checks and report'));
    propertyText(panel, 'Workflow name', model.value.name, (value) => model.updateRoot({ name: value }));
    for (const check of checks) {
      const wrapper = el('label', '', 'flo-check-option'); const box = el('input'); box.type = 'checkbox'; box.checked = model.value.checks.includes(check.id);
      box.addEventListener('change', () => run(() => model.updateRoot({ checks: box.checked
        ? [...model.value.checks, check.id] : model.value.checks.filter((id) => id !== check.id) })));
      wrapper.append(box, el('span', `${check.label} — ${check.description}`),
        el('small', `Needs fields: ${check.required_fields.join(', ') || 'none'}; documents: ${check.required_documents.join(', ') || 'none'}`)); panel.append(wrapper);
      if (box.checked) {
        const present = new Set(model.value.stages.flatMap((stage) => [
          ...stage.fields.map((field) => field.id), ...stage.documents.map((document) => document.id)]));
        const missing = el('div', '', 'flo-check-missing');
        for (const [kind, required] of [['fields', check.required_fields], ['documents', check.required_documents]]) {
          for (const id of required) {
            if (present.has(id)) continue;
            const definition = CANONICAL_COMPONENTS[kind]?.[id];
            if (!definition) { missing.append(el('p', `Required ${kind.slice(0, -1)} ${id} needs an approved component.`)); continue; }
            missing.append(button(`+ Add ${definition.label}`, () => run(() => {
              selectedId = model.addCanonical(kind, id, model.position(selectedId)?.stageIndex ?? 0);
              tab = 'builder'; report(`${definition.label} added with required ID ${id}.`);
            }, id)));
          }
        }
        if (missing.childNodes.length) panel.append(missing);
      }
    }
    propertyText(panel, 'Report sections, one per line', (model.value.report_sections || []).join('\n'),
      (value) => model.updateRoot({ report_sections: value.split('\n').map((part) => part.trim()).filter(Boolean) }), true);
    for (const key of ['primary_color', 'accent_color']) propertyText(panel, key.replace('_', ' '), model.value.tokens?.[key] || '',
      (value) => { const tokens = { ...model.value.tokens }; if (value) tokens[key] = value; else delete tokens[key];
        model.updateRoot({ tokens }); });
    content.replaceChildren(panel);
  }
  function drawPreview() {
    const schema = model.value;
    const alNaboodah = /^Al Naboodah Supplier Onboarding\b/i.test(schema.name || '');
    const brand = alNaboodah ? 'Al Naboodah' : 'Your buyer';
    const panel = el('section', '', 'flo-preview-panel');
    const bar = el('div', '', 'flo-preview-bar');
    bar.append(el('strong', 'Supplier preview · no data is submitted'),
      button('Desktop', () => { width = 'desktop'; drawPreview(); }),
      button('Mobile', () => { width = 'mobile'; drawPreview(); }));
    panel.append(bar, el('p', 'This shows the current draft. Existing supplier links keep their original published version.', 'flo-preview-note'));
    const canvas = el('div', '', `flo-supplier-canvas flo-supplier-${width}`);
    canvas.style.visibility = 'hidden';
    if (/^#[0-9a-fA-F]{6}$/.test(schema.tokens?.primary_color || ''))
      canvas.style.setProperty('--brand', schema.tokens.primary_color);
    if (/^#[0-9a-fA-F]{6}$/.test(schema.tokens?.accent_color || ''))
      canvas.style.setProperty('--accent', schema.tokens.accent_color);
    const surface = canvas.attachShadow({ mode: 'open' });
    const sheet = el('link'); sheet.rel = 'stylesheet'; sheet.href = '/flo-supplier-preview.css';
    sheet.addEventListener('load', () => { canvas.style.visibility = ''; });
    sheet.addEventListener('error', () => { canvas.style.visibility = ''; report('Supplier preview styles could not load.'); });
    const previewStyle = el('style'); previewStyle.textContent = `
      :host { display: block; position: relative; overflow: hidden; background: #f2f5f9; font: 16px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; color: #172f45; --brand: #002c5f; --accent: #f9b233; --ink: #172f45; --muted: #5b6d7c; --line: #dce5ee; --soft: #f7f9fc; --focus: #d28b00; }
      :host(.flo-supplier-mobile) .shell { width: 100%; min-height: 680px; margin: 0; border: 0; border-radius: 0; box-shadow: none; }
      :host(.flo-supplier-mobile) .field-grid, :host(.flo-supplier-mobile) .document-grid { grid-template-columns: 1fr; }
      :host(.flo-supplier-mobile) .al-naboodah-brand .brand-row { min-height: 82px; padding: .2rem 1.2rem; }
      :host(.flo-supplier-mobile) .al-naboodah-brand #brand-logo { width: 145px; height: 78px; }
      :host(.flo-supplier-mobile) .secure-label { width: 2rem; height: 2rem; padding: 0; justify-content: center; font-size: 0; }
      :host(.flo-supplier-mobile) .hero-copy { padding: 1.15rem 1.25rem 1.3rem; }
      :host(.flo-supplier-mobile) .eyebrow { margin-bottom: .35rem; font-size: .64rem; letter-spacing: .14em; }
      :host(.flo-supplier-mobile) h1 { max-width: none; font-size: 1.75rem; line-height: 1.15; letter-spacing: -.03em; }
      :host(.flo-supplier-mobile) #subtitle { margin-top: .55rem; font-size: .84rem; line-height: 1.4; }
      :host(.flo-supplier-mobile) .journey { padding: .85rem 1.25rem .95rem; }
      :host(.flo-supplier-mobile) .journey-heading { margin-bottom: .6rem; font-size: .69rem; }
      :host(.flo-supplier-mobile) .step-marker { display: flex; flex-direction: column; align-items: center; gap: .25rem; text-align: center; font-size: .66rem; }
      :host(.flo-supplier-mobile) .step-number { width: 1.65rem; height: 1.65rem; font-size: .72rem; }
      :host(.flo-supplier-mobile) .step-label { display: block; margin: 0; max-width: 10ch; line-height: 1.2; }
      :host(.flo-supplier-mobile) .step-marker::after { display: none; }
      :host(.flo-supplier-mobile) #form { padding: 1.25rem 1.25rem 0; }
      :host(.flo-supplier-mobile) legend { font-size: 1.3rem; }
      :host(.flo-supplier-mobile) .description { margin-bottom: 1rem; font-size: .85rem; }
      :host(.flo-supplier-mobile) .preview-intro { padding: .5rem; }
      :host(.flo-supplier-mobile) .intro-top, :host(.flo-supplier-mobile) .intro-content { padding-left: 1rem; padding-right: 1rem; }
      :host(.flo-supplier-mobile) .intro-top { padding-top: 1rem; padding-bottom: .85rem; }
      :host(.flo-supplier-mobile) .intro-top h2 { font-size: 1.3rem; }
      :host(.flo-supplier-mobile) .intro-content { padding-top: 1rem; }
      :host(.flo-supplier-mobile) #intro-documents { gap: .38rem; margin-bottom: .8rem; }
      :host(.flo-supplier-mobile) #intro-documents li { font-size: .8rem; line-height: 1.4; }
      :host(.flo-supplier-mobile) .intro-actions { padding: .65rem 1rem 1rem; }
      .preview-intro { position: absolute; inset: 0; z-index: 2; display: grid; place-items: start center; padding: 1.5rem; background: #0c213ba8; }
      .preview-intro-card { width: min(100%, 600px); border-radius: 17px; overflow: hidden; background: #fff; box-shadow: 0 20px 55px #0d234568; }
      .preview-intro .intro-actions { padding-top: .8rem; }
      .preview-intro-note { margin: 0; padding: 0 2rem 1rem; color: #536779; font-size: .8rem; }
    `;
    const shell = el('main', '', `shell${alNaboodah ? ' al-naboodah-brand' : ''}`);
    if (/^#[0-9a-fA-F]{6}$/.test(schema.tokens?.primary_color || ''))
      shell.style.setProperty('--brand', schema.tokens.primary_color);
    if (/^#[0-9a-fA-F]{6}$/.test(schema.tokens?.accent_color || ''))
      shell.style.setProperty('--accent', schema.tokens.accent_color);
    const header = el('header', '', 'page-header');
    const brandRow = el('div', '', 'brand-row'); const identity = el('div', '', 'brand-identity');
    if (alNaboodah) {
      const logo = el('img'); logo.src = '/flo-supplier-preview-logo.png'; logo.alt = 'Al Naboodah'; logo.id = 'brand-logo';
      identity.append(logo);
    } else identity.append(el('span', brand));
    const secure = el('span', '', 'secure-label'); secure.append(el('span', '', 'secure-dot'),
      document.createTextNode('Secure Supplier Portal'));
    brandRow.append(identity, secure);
    const hero = el('div', '', 'hero-copy');
    const subtitle = el('p', `${brand} invited you to complete this supplier verification.`); subtitle.id = 'subtitle';
    hero.append(el('p', 'SUPPLIER VERIFICATION', 'eyebrow'), el('h1', schema.name), subtitle);
    header.append(brandRow, hero);
    const journey = el('section', '', 'journey'); journey.setAttribute('aria-label', 'Application progress');
    const journeyHeading = el('div', '', 'journey-heading');
    journeyHeading.append(el('span', 'Your Progress'), el('span', `Stage ${previewStage + 1} of ${schema.stages.length}`));
    const progress = el('nav'); progress.id = 'steps'; progress.setAttribute('aria-label', 'Progress');
    renderSchemaProgress(progress, schema, previewStage); journey.append(journeyHeading, progress);
    const form = el('form'); form.id = 'form'; form.addEventListener('submit', (event) => event.preventDefault());
    renderSchemaStage(form, { schema, stageIndex: previewStage, draft: previewDraft,
      declarations: { sample_terms: true }, preview: true,
      onFieldChange: (id, value, dependent) => { if (dependent) { previewDraft[id] = value; drawPreview(); } } });
    const actions = el('div', '', 'actions');
    const back = button('Back', () => { previewStage--; drawPreview(); }, 'button-secondary');
    back.disabled = previewStage === 0;
    const next = button(previewStage === schema.stages.length - 1 ? 'Submit Application' : 'Save & Continue',
      () => { previewStage++; drawPreview(); });
    next.disabled = previewStage === schema.stages.length - 1;
    actions.append(back, next); shell.append(header, journey, form, actions);
    surface.append(sheet, previewStyle, shell);
    const terms = schema.stages.flatMap((stage) => stage.declarations)
      .find((entry) => entry.id === 'sample_terms');
    if (previewIntroVisible && terms && previewStage === 0) {
      const overlay = el('div', '', 'preview-intro');
      const card = el('div', '', 'preview-intro-card');
      const top = el('div', '', 'intro-top');
      top.append(el('span', 'BEFORE YOU START', 'intro-badge'), el('h2', 'Get your documents ready'),
        el('p', 'Upload the documents that apply to you, then confirm the details we extract.'));
      const body = el('div', '', 'intro-content'); body.append(el('h3', 'Documents to have ready'));
      const list = el('ul'); list.id = 'intro-documents';
      for (const label of requiredDocumentChecklist(schema)) list.append(el('li', label));
      const termsBox = el('div', '', 'terms-box');
      termsBox.append(el('h3', 'Sample Terms & Conditions'),
        el('p', schema.stages[0]?.description?.split('Sample terms for design review only:')[1]?.trim() || terms.label));
      body.append(list, termsBox);
      const introActions = el('div', '', 'intro-actions');
      introActions.append(button('View form', () => { previewIntroVisible = false; drawPreview(); }));
      card.append(top, body, el('p', 'Preview only · No agreement is recorded.', 'preview-intro-note'), introActions);
      overlay.append(card); surface.append(overlay);
    }
    panel.append(canvas); content.replaceChildren(panel);
  }
  function drawJson() {
    const panel = el('section', '', 'flo-json-panel'); panel.append(el('p', 'Generated JSON is read-only until you choose Advanced edit.'));
    jsonEditor = el('textarea'); jsonEditor.value = JSON.stringify(model.value, null, 2); jsonEditor.readOnly = true;
    jsonEditor.setAttribute('aria-label', 'Workflow JSON schema'); panel.append(jsonEditor);
    if (!readOnly) panel.append(button('Advanced edit', () => { jsonEditor.readOnly = false; jsonEditor.focus(); report('Advanced JSON edit enabled. Apply valid JSON to replace the builder model.'); }));
    if (!readOnly) panel.append(button('Apply JSON', async () => {
      try { const parsed = JSON.parse(jsonEditor.value); const result = await validate(parsed);
        issueList = result.issues || []; drawIssues(); if (!result.valid) throw new Error('Fix the JSON issues before applying.');
        model.replace(parsed); pendingJson = false; render(); report('JSON applied to the builder.');
      } catch (error) { reportError(error); }
    }));
    if (!readOnly) panel.append(button('Cancel JSON edits', () => { pendingJson = false; render(); report('Advanced JSON edits discarded.'); }));
    panel.append(button('Copy JSON', async () => { try { await navigator.clipboard.writeText(pendingJson ? jsonEditor.value : JSON.stringify(model.value, null, 2)); report('JSON copied.'); }
      catch { report('Clipboard unavailable. Select the JSON to copy it.'); } }));
    panel.append(button('Download JSON', () => { const blob = new Blob([pendingJson ? jsonEditor.value : JSON.stringify(model.value, null, 2)], { type: 'application/json' });
      const link = el('a'); link.href = URL.createObjectURL(blob); link.download = 'flo-workflow.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000); }));
    if (!readOnly) jsonEditor.addEventListener('input', () => { pendingJson = jsonEditor.value !== JSON.stringify(model.value, null, 2);
      updateStatus(); updateHistoryActions(); report(pendingJson ? 'Apply JSON before leaving this tab or saving.' : 'JSON matches the builder.'); });
    content.replaceChildren(panel);
  }
  function render() {
    clearSortables(); ensureSelected(); updateStatus(); drawIssues();
    tabs.replaceChildren();
    for (const [name, title] of (readOnly ? [['preview', 'Preview'], ['json', 'JSON']]
      : [['builder', 'Builder'], ['checks', 'Checks and report'], ['preview', 'Preview'], ['json', 'JSON']])) {
      const item = button(title, async () => { if (tab === 'json' && pendingJson) { report('Apply the JSON or cancel advanced edits first.'); return; }
        if (name === 'preview' && !readOnly && !await validateCurrent()) return;
        tab = name; render(); }); item.setAttribute('aria-selected', String(tab === name)); tabs.append(item);
    }
    const historyButtons = readOnly ? [] : [['Undo', () => model.undo()], ['Redo', () => model.redo()]].map(([label, action]) => {
      const control = button(label, () => { if (pendingJson) return; if (action()) render(); });
      control.dataset.historyAction = label.toLowerCase(); return control;
    });
    toolbar.replaceChildren(...historyButtons); updateHistoryActions();
    if (tab === 'builder') drawCanvas(); else if (tab === 'checks') drawChecks();
    else if (tab === 'preview') drawPreview(); else drawJson();
  }
  render();
  async function validateCurrent() { const result = await validate(model.value); issueList = result.issues || []; drawIssues();
    if (!result.valid) { report('Workflow validation found items to fix.'); return false; }
    report('Workflow is valid for the current check catalog.'); return true; }
  return {
    getSchema() { if (pendingJson) throw new Error('Apply or cancel advanced JSON edits first.'); return model.value; },
    get dirty() { return model.dirty || pendingJson; },
    markSaved(schema) { model.markSaved(schema); updateStatus(); },
    async validate() { this.getSchema(); return validateCurrent(); },
    async showPreview() { this.getSchema(); if (!await validateCurrent()) return; tab = 'preview'; render(); },
    summary() { return stageSummary(model.value); },
    destroy() { clearSortables(); root.replaceChildren(); }
  };
}
