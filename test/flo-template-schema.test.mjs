import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflowSchema, schemaDraft, schemaSubmissionGaps, schemaHash } from '../lib/flows/template-schema.mjs';

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
