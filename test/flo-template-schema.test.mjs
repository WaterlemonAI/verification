import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflowSchema, diagnoseWorkflowSchema, schemaDraft, schemaSubmissionGaps, schemaHash } from '../lib/flows/template-schema.mjs';
import { visibleCheckCatalog } from '../lib/flows/checks-catalog.mjs';

const schema = () => ({ schema_version: '1.0.0', name: 'Supplier details', stages: [
  { id: 'identity', title: 'Identity', fields: [
    { id: 'business_name', label: 'Business name', type: 'text', required: true },
    { id: 'entity_type', label: 'Entity type', type: 'select', options: ['Company', 'Individual'], required: true },
    { id: 'licence_number', label: 'Licence number', type: 'text', required: true,
      show_if: { field: 'entity_type', equals: 'Company' } }],
  documents: [{ id: 'trade_licence', label: 'Trade licence', required: true,
    show_if: { field: 'entity_type', equals: 'Company' } }], declarations: [] }],
  checks: ['entity-aml', 'uae-trade-licence'], report_sections: ['Business identity'], tokens: { primary_color: '#064b79' } });

test('validated JSON schema rejects executable content, cycles, unknown checks and unpriced evidence gaps', () => {
  const good = validateWorkflowSchema(schema()); assert.equal(schemaHash(good).length, 64);
  const script = schema(); script.stages[0].title = '<script>alert(1)</script>';
  assert.throws(() => validateWorkflowSchema(script), /invalid_schema/);
  const cycle = schema(); cycle.stages[0].fields[0].show_if = { field: 'licence_number', equals: 'x' };
  assert.throws(() => validateWorkflowSchema(cycle), /invalid_schema/);
  const unknown = schema(); unknown.checks = ['unknown-provider'];
  assert.throws(() => validateWorkflowSchema(unknown), /unknown_check/);
  const noLicence = schema(); noLicence.stages[0].documents = [];
  assert.throws(() => validateWorkflowSchema(noLicence), /evidence/);
  const foreign = schema(); foreign.injected = 'data';
  assert.throws(() => validateWorkflowSchema(foreign), /invalid_schema/);
});

test('server submission rules enforce conditional fields and documents', () => {
  const good = validateWorkflowSchema(schema());
  const draft = schemaDraft(good, { business_name: 'Example LLC', entity_type: 'Company', licence_number: '123' });
  assert.deepEqual(schemaSubmissionGaps(good, { draft, documents: [] }), ['trade_licence']);
  assert.deepEqual(schemaSubmissionGaps(good, { draft: { business_name: 'Example LLC', entity_type: 'Individual' }, documents: [] }), []);
  assert.throws(() => schemaDraft(good, { injected: 'bad' }), /invalid_draft_field/);
});

test('workflow URL fields reject private and non-HTTPS destinations', () => {
  const website = schema(); website.stages[0].fields.push({ id: 'website_url', label: 'Website', type: 'url', required: false });
  const good = validateWorkflowSchema(website);
  for (const value of ['http://example.com', 'https://127.0.0.1', 'https://localhost']) {
    assert.throws(() => schemaDraft(good, { website_url: value }), /invalid_draft:website_url/);
  }
  assert.equal(schemaDraft(good, { website_url: 'https://example.com' }).website_url, 'https://example.com');
});

test('builder diagnostics have bounded paths and catalog metadata exposes only approved checks', () => {
  const valid = diagnoseWorkflowSchema(schema());
  assert.equal(valid.valid, true); assert.equal(schemaHash(valid.schema), schemaHash(schema()));
  const missing = schema(); missing.stages[0].documents = [];
  assert.deepEqual(diagnoseWorkflowSchema(missing).issues, [{ path: 'checks.uae-trade-licence.evidence',
    code: 'invalid_schema', message: 'Review this workflow property and the supported schema limits.' }]);
  const catalog = visibleCheckCatalog(['entity-aml']);
  assert.equal(catalog.length, 1); assert.equal(catalog[0].id, 'entity-aml');
  assert.deepEqual(catalog[0].required_fields, ['business_name']);
  assert.equal(Object.hasOwn(catalog[0], 'adapter'), false);
});

test('builder contract enforces stage, field and document slot bounds', () => {
  const tooManyStages = schema();
  tooManyStages.stages = Array.from({ length: 9 }, (_, index) => ({ id: `stage_${index}`,
    title: `Stage ${index}`, fields: [], documents: [], declarations: [] }));
  assert.equal(diagnoseWorkflowSchema(tooManyStages).issues[0].path, 'root');
  const tooManyFields = schema();
  tooManyFields.stages[0].fields.push(...Array.from({ length: 78 }, (_, index) => ({
    id: `extra_field_${index}`, label: `Extra field ${index}`, type: 'text', required: false })));
  assert.equal(diagnoseWorkflowSchema(tooManyFields).issues[0].path, 'limits');
  const tooManyDocs = schema();
  tooManyDocs.stages[0].documents.push(...Array.from({ length: 30 }, (_, index) => ({
    id: `extra_doc_${index}`, label: `Extra document ${index}`, required: false })));
  assert.equal(diagnoseWorkflowSchema(tooManyDocs).issues[0].path, 'limits');
});
