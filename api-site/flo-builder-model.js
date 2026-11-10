// Schema is the only source of truth. This module has no DOM, storage or network access.
const clone = (value) => structuredClone(value);
const idPattern = /^[a-z][a-z0-9_]{1,63}$/;
const arrays = ['fields', 'documents', 'declarations'];
export const FIELD_TYPES = Object.freeze(['text', 'email', 'url', 'date', 'select', 'textarea', 'number', 'people']);
export const CANONICAL_COMPONENTS = Object.freeze({
  fields: Object.freeze({
    business_name: { label: 'Registered business name', type: 'text' },
    licence_number: { label: 'Trade licence number', type: 'text' },
    iban: { label: 'IBAN', type: 'text' },
    stakeholders: { label: 'Stakeholders', type: 'people' },
    website_url: { label: 'Business website', type: 'url' }
  }),
  documents: Object.freeze({
    trade_licence: { label: 'Trade licence' },
    bank_letter: { label: 'Bank letter' },
    ejari: { label: 'Ejari certificate' }
  })
});

export function dependencyProblem(schema) {
  const seen = new Set(); const earlierFields = new Set();
  for (const stage of schema.stages || []) {
    if (seen.has(stage.id)) return `Duplicate ID: ${stage.id}`;
    seen.add(stage.id);
    for (const kind of arrays) for (const item of stage[kind] || []) {
      if (seen.has(item.id)) return `Duplicate ID: ${item.id}`;
      if (item.show_if && !earlierFields.has(item.show_if.field))
        return `${item.id} depends on ${item.show_if.field}, which must appear earlier.`;
      seen.add(item.id);
      if (kind === 'fields') earlierFields.add(item.id);
    }
  }
  return null;
}
export function nextId(schema, label) {
  const base = String(label || 'item').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '') || 'item';
  const used = new Set((schema.stages || []).flatMap((stage) => [stage.id,
    ...arrays.flatMap((kind) => (stage[kind] || []).map((item) => item.id))]));
  let candidate = base.slice(0, 55), index = 2;
  while (!idPattern.test(candidate) || used.has(candidate)) candidate = `${base.slice(0, 54)}_${index++}`;
  return candidate;
}
function createItem(schema, kind, type) {
  if (kind === 'stages') return { id: nextId(schema, 'new_stage'), title: 'New stage',
    description: '', fields: [], documents: [], declarations: [] };
  const label = kind === 'fields' ? `New ${type} field` : kind === 'documents' ? 'New document' : 'New declaration';
  const item = { id: nextId(schema, label), label,
    ...(kind === 'fields' ? { type, required: false } : { required: true }) };
  if (type === 'select') item.options = ['Option 1'];
  return item;
}
function findItem(schema, id) {
  for (let stageIndex = 0; stageIndex < schema.stages.length; stageIndex++) {
    const stage = schema.stages[stageIndex];
    if (stage.id === id) return { item: stage, stageIndex, kind: 'stages', index: stageIndex };
    for (const kind of arrays) {
      const index = stage[kind].findIndex((item) => item.id === id);
      if (index >= 0) return { item: stage[kind][index], stageIndex, kind, index };
    }
  }
  return null;
}
export class FloBuilderModel {
  constructor(schema) { this.schema = clone(schema); this.baseline = JSON.stringify(this.schema);
    this.undoStack = []; this.redoStack = []; this.onchange = () => {}; }
  get value() { return clone(this.schema); }
  get json() { return JSON.stringify(this.schema); }
  get dirty() { return this.json !== this.baseline; }
  markSaved(schema = this.schema) { this.baseline = JSON.stringify(schema); this.onchange(this.value); }
  replace(schema) {
    if (!schema || typeof schema !== 'object' || !Array.isArray(schema.stages)) throw new Error('Invalid workflow JSON.');
    const problem = dependencyProblem(schema); if (problem) throw new Error(problem);
    this.commit(() => clone(schema));
  }
  commit(transform) {
    const next = transform(clone(this.schema));
    const problem = dependencyProblem(next); if (problem) throw new Error(problem);
    const before = this.json; const after = JSON.stringify(next);
    if (after === before) return;
    this.undoStack.push(before); if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = []; this.schema = next; this.onchange(this.value);
  }
  undo() { if (!this.undoStack.length) return false; this.redoStack.push(this.json);
    this.schema = JSON.parse(this.undoStack.pop()); this.onchange(this.value); return true; }
  redo() { if (!this.redoStack.length) return false; this.undoStack.push(this.json);
    this.schema = JSON.parse(this.redoStack.pop()); this.onchange(this.value); return true; }
  add(kind, stageIndex = 0, type = 'text') {
    if (kind !== 'stages' && !arrays.includes(kind)) throw new Error('Unknown component.');
    if (kind === 'fields' && !FIELD_TYPES.includes(type)) throw new Error('Unknown field type.');
    const item = createItem(this.schema, kind, type);
    this.commit((schema) => {
      if (kind === 'stages') schema.stages.push(item);
      else if (schema.stages[stageIndex]) schema.stages[stageIndex][kind].push(item);
      else throw new Error('Select a stage first.');
      return schema;
    });
    return item.id;
  }
  addCanonical(kind, id, stageIndex = 0) {
    const definition = CANONICAL_COMPONENTS[kind]?.[id];
    if (!definition) throw new Error('Unknown required input.');
    if (findItem(this.schema, id)) throw new Error(`${definition.label} is already in this workflow.`);
    this.commit((schema) => {
      if (!schema.stages[stageIndex]) throw new Error('Select a stage first.');
      schema.stages[stageIndex][kind].push({ id, label: definition.label, required: true,
        ...(kind === 'fields' ? { type: definition.type } : {}) });
      return schema;
    });
    return id;
  }
  duplicate(id) {
    let copiedId;
    this.commit((schema) => {
      const found = findItem(schema, id); if (!found) throw new Error('Component unavailable.');
      const copy = clone(found.item); const idMap = new Map();
      if (found.kind === 'stages') {
        copy.id = nextId(schema, `${copy.id}_copy`); copiedId = copy.id; idMap.set(found.item.id, copy.id);
        for (const kind of arrays) for (const item of copy[kind]) {
          const oldId = item.id; item.id = nextId({ stages: [...schema.stages, copy] }, `${oldId}_copy`);
          // A copied stage needs unique nested IDs even if another nested copy has the same base.
          if (item.id === oldId) item.id = nextId(schema, `${oldId}_copy`);
          idMap.set(oldId, item.id);
        }
        for (const kind of ['fields', 'documents']) for (const item of copy[kind])
          if (item.show_if && idMap.has(item.show_if.field)) item.show_if.field = idMap.get(item.show_if.field);
        schema.stages.splice(found.index + 1, 0, copy);
      } else {
        copy.id = nextId(schema, `${copy.id}_copy`); copiedId = copy.id;
        schema.stages[found.stageIndex][found.kind].splice(found.index + 1, 0, copy);
      }
      return schema;
    });
    return copiedId;
  }
  remove(id) {
    this.commit((schema) => {
      const found = findItem(schema, id); if (!found) throw new Error('Component unavailable.');
      if (found.kind === 'stages' && schema.stages.length === 1) throw new Error('Keep at least one stage.');
      const removedIds = new Set(found.kind === 'stages' ? [id, ...arrays.flatMap((kind) => found.item[kind].map((item) => item.id))] : [id]);
      for (const stage of schema.stages) for (const kind of ['fields', 'documents']) for (const item of stage[kind])
        if (!removedIds.has(item.id) && item.show_if && removedIds.has(item.show_if.field))
          throw new Error(`${item.id} depends on ${item.show_if.field}. Remove that condition first.`);
      if (found.kind === 'stages') schema.stages.splice(found.index, 1);
      else schema.stages[found.stageIndex][found.kind].splice(found.index, 1);
      return schema;
    });
  }
  move(id, toIndex) {
    this.commit((schema) => {
      const found = findItem(schema, id); if (!found) throw new Error('Component unavailable.');
      const collection = found.kind === 'stages' ? schema.stages : schema.stages[found.stageIndex][found.kind];
      if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= collection.length) throw new Error('Position unavailable.');
      collection.splice(toIndex, 0, collection.splice(found.index, 1)[0]); return schema;
    });
  }
  update(id, values) {
    this.commit((schema) => {
      const found = findItem(schema, id); if (!found) throw new Error('Component unavailable.');
      if ('id' in values) throw new Error('Component ID cannot change.');
      Object.assign(found.item, values);
      return schema;
    });
  }
  updateRoot(values) { this.commit((schema) => Object.assign(schema, values)); }
  position(id) { const found = findItem(this.schema, id); if (!found) return null;
    const length = found.kind === 'stages' ? this.schema.stages.length : this.schema.stages[found.stageIndex][found.kind].length;
    return { ...found, length }; }
}
