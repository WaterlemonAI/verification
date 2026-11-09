import { randomUUID } from 'node:crypto';
import { validateWorkflowSchema, schemaHash, genericTemplate } from './template-schema.mjs';
import { validFlowId, resolveTemplate } from './registry.mjs';

const states = ['draft', 'active', 'paused', 'archived'];
const validWorkspace = (value) => /^[a-f0-9]{16}$/.test(value || '');
const nextVersion = (version) => version ? `1.0.${Number(version.split('.')[2]) + 1}` : '1.0.0';
const publicRecord = (item) => item && Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'draft'));

export class WorkflowService {
  constructor(store, { hasEntitlement = async () => true, hasFloPrice = async () => true,
    allowedChecks = async () => null } = {}) {
    this.store = store; this.hasEntitlement = hasEntitlement; this.hasFloPrice = hasFloPrice;
    this.allowedChecks = allowedChecks;
  }
  async get(flowId, workspaceId = null) {
    if (!validFlowId(flowId)) return null;
    const item = await this.store.getWorkflow(flowId);
    if (!item || item.owner_workspace_id && item.owner_workspace_id !== workspaceId) return null;
    if (!item.owner_workspace_id && workspaceId && !await this.store.getAssignment(workspaceId, flowId)) return null;
    return item;
  }
  async list(workspaceId = null) {
    const all = await this.store.listWorkflows();
    if (!workspaceId) return all.map(publicRecord);
    const assignments = await this.store.listAssignments(workspaceId);
    const assigned = new Set(assignments.map((item) => item.flow_id));
    return all.filter((item) => item.owner_workspace_id === workspaceId
      || !item.owner_workspace_id && assigned.has(item.flow_id)).map(publicRecord);
  }
  async create({ name, schema, owner_workspace_id = null, source_flow_id = null, source_version = null }) {
    if (owner_workspace_id && !validWorkspace(owner_workspace_id)) throw new Error('invalid_workspace');
    const checked = validateWorkflowSchema(schema, await this.allowedChecks(owner_workspace_id) || undefined);
    const flow_id = `flow-${randomUUID().replaceAll('-', '')}`;
    const record = { flow_id, name: name || checked.name, owner_workspace_id, source_flow_id, source_version,
      lifecycle: 'draft', schema_version: checked.schema_version, published_version: null,
      definition_hash: null, draft: checked };
    return this.store.saveWorkflow(record);
  }
  async copy(flowId, workspaceId = null) {
    const source = await this.get(flowId, workspaceId);
    if (workspaceId && source && !source.owner_workspace_id
      && (await this.store.getAssignment(workspaceId, flowId))?.state !== 'active') throw new Error('workflow_not_assigned');
    let schema; let version;
    if (source?.published_version) {
      schema = await this.store.getWorkflowVersion(flowId, source.published_version);
      version = source.published_version;
    } else if (!source && resolveTemplate(flowId, '1.0.0') && workspaceId
      && (await this.store.getConfig(workspaceId, flowId))?.enabled) {
      throw new Error('legacy_workflow_requires_schema_migration');
    }
    if (!schema) throw new Error('workflow_not_found');
    return this.create({ name: `${source.name} copy`, schema, owner_workspace_id: workspaceId,
      source_flow_id: flowId, source_version: version });
  }
  async saveDraft(flowId, workspaceId, schema, expectedRevision) {
    const item = await this.get(flowId, workspaceId);
    if (!item || item.owner_workspace_id !== workspaceId) throw new Error('workflow_not_found');
    if (item.lifecycle === 'archived') throw new Error('workflow_archived');
    if (!Number.isInteger(expectedRevision)) throw new Error('workflow_revision_required');
    const checked = validateWorkflowSchema(schema, await this.allowedChecks(workspaceId) || undefined);
    return this.store.saveWorkflow({ ...item, name: checked.name, draft: checked }, expectedRevision);
  }
  async publish(flowId, workspaceId, expectedRevision) {
    const item = await this.get(flowId, workspaceId);
    if (!item || item.owner_workspace_id !== workspaceId) throw new Error('workflow_not_found');
    if (item.lifecycle === 'archived') throw new Error('workflow_archived');
    if (item.draft_revision !== expectedRevision) throw new Error('workflow_conflict');
    if (workspaceId && !(await this.hasEntitlement(workspaceId))) throw new Error('flo_not_entitled');
    if (workspaceId && !(await this.hasFloPrice(workspaceId))) throw new Error('flo_price_missing');
    const checked = validateWorkflowSchema(item.draft, await this.allowedChecks(workspaceId) || undefined);
    const version = nextVersion(item.published_version);
    await this.store.putWorkflowVersion(flowId, version, checked);
    return this.store.saveWorkflow({ ...item, lifecycle: 'active', published_version: version,
      definition_hash: schemaHash(checked), schema_version: checked.schema_version }, expectedRevision);
  }
  async lifecycle(flowId, workspaceId, state, expectedRevision) {
    if (!states.includes(state) || state === 'draft') throw new Error('invalid_lifecycle');
    const item = await this.get(flowId, workspaceId);
    if (!item || item.owner_workspace_id !== workspaceId) throw new Error('workflow_not_found');
    if (item.lifecycle === 'archived' || state === 'active' && !item.published_version) throw new Error('invalid_lifecycle');
    if (item.draft_revision !== expectedRevision) throw new Error('workflow_conflict');
    return this.store.saveWorkflow({ ...item, lifecycle: state }, expectedRevision);
  }
  async assign(flowId, workspaceId, state) {
    if (!validWorkspace(workspaceId) || !['active', 'paused'].includes(state)) throw new Error('invalid_assignment');
    const item = await this.store.getWorkflow(flowId);
    if (!item || item.owner_workspace_id) throw new Error('workflow_not_found');
    return this.store.putAssignment(workspaceId, flowId, state);
  }
  async effective(flowId, workspaceId) {
    const item = await this.get(flowId, workspaceId);
    if (!item || item.lifecycle !== 'active' || !item.published_version
      || !(await this.hasEntitlement(workspaceId)) || !(await this.hasFloPrice(workspaceId))) return null;
    if (!item.owner_workspace_id && (await this.store.getAssignment(workspaceId, flowId))?.state !== 'active') return null;
    let ancestor = item; const seen = new Set([flowId]);
    while (ancestor.source_flow_id) {
      if (seen.has(ancestor.source_flow_id)) throw new Error('workflow_lineage_cycle');
      seen.add(ancestor.source_flow_id);
      ancestor = await this.store.getWorkflow(ancestor.source_flow_id);
      if (!ancestor || ['paused', 'archived'].includes(ancestor.lifecycle)) return null;
    }
    const schema = await this.store.getWorkflowVersion(flowId, item.published_version);
    if (!schema || schemaHash(schema) !== item.definition_hash) throw new Error('workflow_hash_mismatch');
    return { workflow: item, template: genericTemplate(flowId, item.published_version, schema) };
  }
}
