import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFloStore } from '../lib/flows/store.mjs';
import { WorkflowService } from '../lib/flows/workflow-service.mjs';

const workspaceA = 'a'.repeat(16); const workspaceB = 'b'.repeat(16);
const schema = { schema_version: '1.0.0', name: 'Supplier profile', stages: [
  { id: 'identity', title: 'Identity', fields: [{ id: 'business_name', label: 'Business name', type: 'text', required: true }],
    documents: [], declarations: [] }], checks: ['entity-aml'], report_sections: [], tokens: {} };

test('platform assignment, private copy, immutable publish, pause and owner isolation', async () => {
  const store = new MemoryFloStore(); const service = new WorkflowService(store, { hasEntitlement: async (id) => id !== workspaceB });
  const platform = await service.create({ schema });
  assert.equal(await service.get(platform.flow_id, workspaceA), null);
  await service.publish(platform.flow_id, null, platform.draft_revision);
  await service.assign(platform.flow_id, workspaceA, 'active');
  assert.ok(await service.get(platform.flow_id, workspaceA));
  const copy = await service.copy(platform.flow_id, workspaceA);
  assert.notEqual(copy.flow_id, platform.flow_id);
  assert.equal(copy.owner_workspace_id, workspaceA);
  assert.equal(copy.source_flow_id, platform.flow_id);
  const unpriced = new WorkflowService(store, { hasEntitlement: async () => true, hasFloPrice: async () => false });
  await assert.rejects(unpriced.publish(copy.flow_id, workspaceA, copy.draft_revision), /flo_price_missing/);
  assert.equal(await service.get(copy.flow_id, workspaceB), null);
  assert.equal(await service.effective(copy.flow_id, workspaceA), null);
  const published = await service.publish(copy.flow_id, workspaceA, copy.draft_revision);
  assert.equal(published.published_version, '1.0.0');
  assert.ok(await service.effective(copy.flow_id, workspaceA));
  await service.assign(platform.flow_id, workspaceA, 'paused');
  assert.equal(await service.effective(copy.flow_id, workspaceA), null,
    'pausing a platform assignment must also stop links from its organisation copies');
  await service.assign(platform.flow_id, workspaceA, 'active');
  assert.ok(await service.effective(copy.flow_id, workspaceA));
  await assert.rejects(service.saveDraft(copy.flow_id, workspaceB, schema, published.draft_revision), /workflow_not_found/);
  const changed = structuredClone(schema); changed.name = 'New name';
  const edited = await service.saveDraft(copy.flow_id, workspaceA, changed, published.draft_revision);
  assert.equal((await store.getWorkflowVersion(copy.flow_id, '1.0.0')).name, 'Supplier profile');
  assert.equal((await service.publish(copy.flow_id, workspaceA, edited.draft_revision)).published_version, '1.0.1');
  const paused = await service.lifecycle(platform.flow_id, null, 'paused', 2);
  assert.equal(paused.lifecycle, 'paused');
  assert.equal(await service.effective(copy.flow_id, workspaceA), null);
});

test('unsaved validation uses workspace allowed checks without changing drafts or versions', async () => {
  const store = new MemoryFloStore();
  const service = new WorkflowService(store, { allowedChecks: async (workspaceId) => workspaceId === workspaceB ? [] : ['entity-aml'] });
  const platform = await service.create({ schema });
  const before = await store.getWorkflow(platform.flow_id);
  const good = await service.validateUnsaved(schema, workspaceA);
  assert.equal(good.valid, true); assert.equal(good.presentation.name, schema.name);
  const denied = await service.validateUnsaved(schema, workspaceB);
  assert.equal(denied.valid, false); assert.equal(denied.issues[0].code, 'check_not_entitled');
  assert.deepEqual(await service.catalog(workspaceB), []);
  assert.deepEqual(await store.getWorkflow(platform.flow_id), before);
});

test('stale editor cannot overwrite or publish a newer draft', async () => {
  const store = new MemoryFloStore(); const service = new WorkflowService(store);
  const created = await service.create({ schema });
  const changed = structuredClone(schema); changed.name = 'Updated in another tab';
  const saved = await service.saveDraft(created.flow_id, null, changed, created.draft_revision);
  await assert.rejects(service.saveDraft(created.flow_id, null, schema, created.draft_revision), /workflow_conflict/);
  await assert.rejects(service.publish(created.flow_id, null, created.draft_revision), /workflow_conflict/);
  assert.equal((await store.getWorkflow(created.flow_id)).draft.name, 'Updated in another tab');
  assert.equal((await service.publish(created.flow_id, null, saved.draft_revision)).published_version, '1.0.0');
});
