// Fixed presentation shared by the supplier journey and non-submitting editor preview.
// Workflow content is always inserted as text or as a validated control value.
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function renderSchemaProgress(container, schema, current) {
  container.replaceChildren();
  container.style.setProperty('--step-total', schema.stages.length);
  schema.stages.forEach((stage, index) => {
    const marker = element('span', null, `step-marker${index === current ? ' current' : ''}${index < current ? ' complete' : ''}`);
    marker.append(element('span', index < current ? '✓' : String(index + 1), 'step-number'),
      element('span', stage.title, 'step-label'));
    if (index === current) marker.setAttribute('aria-current', 'step');
    container.append(marker);
  });
}
export function renderSchemaStage(container, { schema, stageIndex = 0, draft = {}, documents = [],
  declarations = {}, pendingFiles = new Map(), preview = false,
  onFieldChange = () => {}, onDocumentChange = () => {} }) {
  const stage = schema.stages[stageIndex];
  if (!stage) throw new Error('Stage unavailable.');
  const visible = (rule) => !rule || (rule.in
    ? rule.in.includes(draft[rule.field]) : draft[rule.field] === rule.equals);
  const hasDependents = (id) => schema.stages.some((entry) => [...entry.fields, ...entry.documents]
    .some((child) => child.show_if?.field === id));
  const ownerNamesOnDocument = ['trade_licence', 'incorporation_record'].some((type) => {
    const document = documents.findLast((entry) => entry.type === type);
    const names = document?.extraction_result?.data?.stakeholder_names;
    return typeof names === 'string' && names.trim() && names !== 'Not Found';
  });
  const fieldset = element('fieldset');
  fieldset.append(element('legend', stage.title));
  const description = stage.id === 'documents_first' && stage.declarations.some((entry) => entry.id === 'sample_terms')
    ? stage.description?.split('Sample terms for design review only:')[0].trim() : stage.description;
  if (description) fieldset.append(element('p', description, 'description'));
  const fieldGrid = element('div', null, 'field-grid');
  for (const field of stage.fields.filter((entry) => visible(entry.show_if)
    && !(entry.id === 'stakeholders' && ownerNamesOnDocument))) {
    const control = field.type === 'select' ? element('select')
      : ['textarea', 'people'].includes(field.type) ? element('textarea') : element('input');
    if (control.tagName === 'INPUT') control.type = field.type;
    control.name = field.id; control.required = field.required; control.maxLength = field.max_length || 2000;
    control.autocomplete = field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'off';
    if (field.type === 'email') control.spellcheck = false;
    if (field.type === 'date' && /(?:^|_)expiry$/.test(field.id))
      control.min = new Date().toISOString().slice(0, 10);
    if (field.type === 'select') {
      const empty = element('option', 'Select an option'); empty.value = ''; control.append(empty);
      for (const value of field.options) { const option = element('option', value); option.value = value; control.append(option); }
    }
    control.value = field.type === 'people' ? (draft[field.id] || []).map((person) =>
      `${person.name} | ${person.role} | ${person.ownership_percentage ?? ''}`).join('\n') : draft[field.id] || '';
    control.dataset.fieldType = field.type;
    control.addEventListener('input', () => { if (field.type === 'people') draft[field.id] = control.value.split('\n')
      .map((line) => line.trim()).filter(Boolean).map((line) => {
        const [name = '', role = '', ownership = ''] = line.split('|').map((part) => part.trim());
        return { name, role, ownership_percentage: ownership || null };
      });
      else draft[field.id] = control.value;
      onFieldChange(field.id, control.value, false); });
    if (hasDependents(field.id)) control.addEventListener('change', () => onFieldChange(field.id, control.value, true));
    const wrapper = element('label', null, `field${['textarea', 'people'].includes(field.type) ? ' wide' : ''}`);
    const label = element('span', field.label, 'field-title');
    if (field.required) label.append(element('span', ' *', 'required'));
    else if (!/optional|if any|if available|if missing/i.test(field.label))
      label.append(element('span', ' · Optional', 'optional'));
    wrapper.append(label, control);
    if (field.type === 'people') wrapper.append(element('small', 'One person per line: Name | Role | Ownership %'));
    fieldGrid.append(wrapper);
  }
  fieldset.append(fieldGrid);
  const visibleDocuments = stage.documents.filter((entry) => visible(entry.show_if));
  if (visibleDocuments.length) {
    const heading = element('div', null, 'section-heading');
    heading.append(element('h2', 'Documents to upload'),
      element('p', 'PDF, PNG or JPG · Maximum 6 MB per file. You can replace a document if needed.'));
    fieldset.append(heading);
  }
  const documentGrid = element('div', null, 'document-grid');
  for (const document of visibleDocuments) {
    const control = element('input'); control.type = 'file';
    control.accept = document.id === 'ejari' ? '.pdf' : '.pdf,.png,.jpg,.jpeg';
    control.name = document.id; control.disabled = preview;
    const pending = pendingFiles.get(document.id);
    if (pending && !preview && typeof DataTransfer !== 'undefined') {
      const transfer = new DataTransfer(); transfer.items.add(pending); control.files = transfer.files;
    }
    const existing = documents.findLast((entry) => entry.type === document.id);
    const wrapper = element('label', null, `field document-card${existing ? ' uploaded' : ''}`);
    const label = element('span', document.label, 'field-title');
    if (document.required) label.append(element('span', ' *', 'required'));
    else if (!/optional|if any|if available/i.test(document.label))
      label.append(element('span', ' · Optional', 'optional'));
    wrapper.append(label, control);
    control.required = document.required && !existing && !preview;
    const status = element('small', pending ? `Selected: ${pending.name}` : existing
      ? 'Document uploaded · Choose another file to replace it'
      : document.id === 'ejari' ? 'PDF only' : 'Choose a file to upload', 'document-status');
    if (preview) status.textContent = 'Upload disabled in preview';
    control.addEventListener('change', () => {
      onDocumentChange(document.id, control.files?.[0] || null);
      status.textContent = control.files?.[0] ? `Selected: ${control.files[0].name}` : existing
        ? 'Document uploaded · Choose another file to replace it' : 'Choose a file to upload';
    });
    wrapper.append(status); documentGrid.append(wrapper);
  }
  fieldset.append(documentGrid);
  for (const declaration of stage.declarations) {
    if (declaration.id === 'sample_terms' && declarations[declaration.id] === true) continue;
    const control = element('input'); control.type = 'checkbox'; control.name = declaration.id;
    control.checked = declarations[declaration.id] === true;
    const wrapper = element('label', null, 'field check');
    wrapper.append(control, element('span', declaration.label, 'field-title')); fieldset.append(wrapper);
  }
  container.replaceChildren(fieldset);
  return fieldset;
}
