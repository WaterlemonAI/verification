import test from 'node:test';
import assert from 'node:assert/strict';
import { FloBuilderModel, dependencyProblem, CANONICAL_COMPONENTS } from '../api-site/flo-builder-model.js';
import { schemaHash, validateWorkflowSchema } from '../lib/flows/template-schema.mjs';
import { visibleCheckCatalog } from '../lib/flows/checks-catalog.mjs';

const schema = () => ({ schema_version: '1.0.0', name: 'Supplier details', stages: [
  { id: 'identity', title: 'Identity', description: '', fields: [
    { id: 'business_name', label: 'Business name', type: 'text', required: true },
    { id: 'entity_type', label: 'Entity type', type: 'select', options: ['Company', 'Individual'], required: true },
    { id: 'licence_number', label: 'Licence number', type: 'text', required: true,
      show_if: { field: 'entity_type', equals: 'Company' } }],
  documents: [{ id: 'trade_licence', label: 'Trade licence', required: true,
    show_if: { field: 'entity_type', equals: 'Company' } }], declarations: [] }],
  checks: ['uae-trade-licence'], report_sections: ['Identity'], tokens: { primary_color: '#064b79' } });

test('untouched import and export preserve schema JSON and definition hash', () => {
  const original = schema(); const model = new FloBuilderModel(original);
  assert.equal(model.json, JSON.stringify(original));
  assert.equal(schemaHash(model.value), schemaHash(original));
  assert.equal(model.dirty, false);
  model.replace(JSON.parse(model.json)); assert.equal(model.dirty, false);
});

test('builder IDs survive renames; copy, order, undo and redo use one schema model', () => {
  const model = new FloBuilderModel(schema());
  model.update('business_name', { label: 'Registered legal name' });
  assert.equal(model.value.stages[0].fields[0].id, 'business_name');
  const copy = model.duplicate('business_name');
  assert.notEqual(copy, 'business_name');
  assert.equal(model.value.stages[0].fields[1].id, copy);
  const afterCopy = model.json;
  model.move(copy, 0); assert.equal(model.value.stages[0].fields[0].id, copy);
  model.undo(); assert.equal(model.json, afterCopy);
  model.redo(); assert.equal(model.value.stages[0].fields[0].id, copy);
  model.markSaved(); assert.equal(model.dirty, false);
  assert.deepEqual(validateWorkflowSchema(model.value), model.value);
});

test('dependent conditions reject unsafe moves and deletes', () => {
  const model = new FloBuilderModel(schema());
  assert.throws(() => model.move('entity_type', 2), /depends on entity_type/);
  assert.throws(() => model.remove('entity_type'), /depends on entity_type/);
  assert.equal(model.value.stages[0].fields[1].id, 'entity_type');
  model.update('licence_number', { show_if: undefined });
  model.update('trade_licence', { show_if: undefined });
  model.remove('entity_type');
  assert.ok(!model.value.stages[0].fields.some((field) => field.id === 'entity_type'));
  assert.deepEqual(model.value.checks, ['uae-trade-licence']);
  model.remove('trade_licence');
  assert.deepEqual(model.value.checks, ['uae-trade-licence'], 'an invalid check dependency stays visible as a publish blocker');
  assert.throws(() => validateWorkflowSchema(model.value), /evidence/);
});

test('stage copy regenerates nested IDs and preserves internal condition meaning', () => {
  const model = new FloBuilderModel(schema()); const copyId = model.duplicate('identity');
  assert.equal(model.value.stages.length, 2);
  const copied = model.value.stages[1]; assert.equal(copied.id, copyId);
  assert.notEqual(copied.fields[1].id, 'entity_type');
  assert.equal(copied.fields[2].show_if.field, copied.fields[1].id);
  assert.equal(copied.documents[0].show_if.field, copied.fields[1].id);
  assert.equal(dependencyProblem(model.value), null);
  assert.deepEqual(validateWorkflowSchema(model.value), model.value);
});

test('all field types create unique IDs and respect stage and field limits', () => {
  const model = new FloBuilderModel(schema());
  for (const type of ['text', 'email', 'url', 'date', 'select', 'textarea', 'number', 'people']) model.add('fields', 0, type);
  const ids = model.value.stages[0].fields.map((field) => field.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(model.value.stages[0].fields.at(-1).type, 'people');
  for (let i = 0; i < 6; i++) model.add('stages');
  assert.equal(model.value.stages.length, 7);
  model.add('stages'); assert.equal(model.value.stages.length, 8);
  assert.throws(() => validateWorkflowSchema({ ...model.value, stages: [...model.value.stages, model.value.stages[0]] }), /invalid_schema/);
});

test('every approved check dependency can be added with its canonical ID without JSON editing', () => {
  for (const check of visibleCheckCatalog()) {
    const current = schema(); current.checks = [check.id];
    current.stages[0].fields = []; current.stages[0].documents = [];
    const model = new FloBuilderModel(current);
    for (const id of check.required_fields) {
      assert.ok(CANONICAL_COMPONENTS.fields[id], `${check.id} field ${id} has no visual component`);
      assert.equal(model.addCanonical('fields', id), id);
    }
    for (const id of check.required_documents) {
      assert.ok(CANONICAL_COMPONENTS.documents[id], `${check.id} document ${id} has no visual component`);
      assert.equal(model.addCanonical('documents', id), id);
    }
    assert.deepEqual(validateWorkflowSchema(model.value), model.value, check.id);
  }
  const model = new FloBuilderModel(schema());
  assert.throws(() => model.addCanonical('documents', 'trade_licence'), /already in this workflow/);
  assert.throws(() => model.addCanonical('fields', 'unapproved_field'), /Unknown required input/);
});
