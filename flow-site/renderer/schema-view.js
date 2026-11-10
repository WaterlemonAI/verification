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
  schema.stages.forEach((stage, index) => {
    const marker = element('span', `${index + 1}. ${stage.title}`, index === current ? 'current' : '');
    if (index === current) marker.setAttribute('aria-current', 'step');
    container.append(marker);
  });
}
export function renderSchemaStage(container, { schema, stageIndex = 0, draft = {}, documents = [],
  declarations = {}, preview = false, onFieldChange = () => {} }) {
  const stage = schema.stages[stageIndex];
  if (!stage) throw new Error('Stage unavailable.');
  const visible = (rule) => !rule || draft[rule.field] === rule.equals;
  const hasDependents = (id) => schema.stages.some((entry) => [...entry.fields, ...entry.documents]
    .some((child) => child.show_if?.field === id));
  const fieldset = element('fieldset');
  fieldset.append(element('legend', stage.title));
  if (stage.description) fieldset.append(element('p', stage.description, 'description'));
  for (const field of stage.fields.filter((entry) => visible(entry.show_if))) {
    const control = field.type === 'select' ? element('select')
      : ['textarea', 'people'].includes(field.type) ? element('textarea') : element('input');
    if (control.tagName === 'INPUT') control.type = field.type;
    control.name = field.id; control.required = field.required; control.maxLength = field.max_length || 2000;
    if (field.type === 'select') {
      const empty = element('option', 'Choose one'); empty.value = ''; control.append(empty);
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
    const wrapper = element('label', null, 'field');
    wrapper.append(element('span', `${field.label}${field.required ? ' *' : ''}`), control);
    if (field.type === 'people') wrapper.append(element('small', 'One person per line: Name | Role | Ownership %'));
    fieldset.append(wrapper);
  }
  for (const document of stage.documents.filter((entry) => visible(entry.show_if))) {
    const control = element('input'); control.type = 'file'; control.accept = '.pdf,.png,.jpg,.jpeg';
    control.name = document.id; control.disabled = preview;
    const wrapper = element('label', null, 'field');
    wrapper.append(element('span', `${document.label}${document.required ? ' *' : ''}`), control);
    const existing = documents.find((entry) => entry.type === document.id);
    if (existing) wrapper.append(element('small', `Uploaded · ${existing.uploaded_at || 'saved'}`));
    if (preview) wrapper.append(element('small', 'Upload disabled in preview'));
    fieldset.append(wrapper);
  }
  for (const declaration of stage.declarations) {
    const control = element('input'); control.type = 'checkbox'; control.name = declaration.id;
    control.checked = declarations[declaration.id] === true;
    const wrapper = element('label', null, 'field check');
    wrapper.append(element('span', declaration.label), control); fieldset.append(wrapper);
  }
  container.replaceChildren(fieldset);
  return fieldset;
}
