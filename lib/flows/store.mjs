import { randomUUID } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { TableClient, odata } from '@azure/data-tables';
import { ContainerAppsManagedIdentityCredential } from '../azure-managed-identity.mjs';
import { decryptBytes, decryptJson, encryptBytes, encryptJson, sha256 } from './crypto.mjs';
import { FLOW_ID, caseBucket } from './contract.mjs';
import { latestTemplate } from './registry.mjs';

const now = () => new Date().toISOString();
const missing = (error) => error?.statusCode === 404;
const conflict = (error) => error?.statusCode === 409 || error?.statusCode === 412;
const validId = (value) => /^[0-9a-f-]{36}$/i.test(value || '');
const validWorkspace = (value) => /^[a-f0-9]{16}$/i.test(value || '');

function newCase(workspaceId, input, idempotencyHash, linkHash, config, template, actor = 'customer_api') {
  const time = now();
  return { application_id: randomUUID(), workspace_id: workspaceId, flow_id: template.flow_id,
    template_version: template.version, definition_hash: template.definition_hash,
    check_catalog_version: template.catalog_version || null,
    application_revision: 1, revisions: [], workflow_schema: template.supplierBundle === 'renderer' ? template.definition : null,
    customer_reference: input.customer_reference,
    supplier_email: input.supplier_email, prefill: input.prefill, status: 'link_issued',
    created_at: time, updated_at: time, submitted_at: null, expires_at: null,
    link_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    link_hash: linkHash, link_redeemed_at: null, session_hash: null, session_expires_at: null,
    idempotency_hash: idempotencyHash, configuration: config, draft: {}, documents: [], declarations: {},
    link_delivery: 'not_attempted',
    facts: [], subjects: [], checks: [], comparisons: [], reports: [], events: [
      { event_id: randomUUID(), type: 'link_issued', at: time, actor }
    ] };
}

export class MemoryFloStore {
  constructor() { this.templates = new Map(); this.configs = new Map(); this.cases = new Map(); this.idempotency = new Map(); this.links = new Map(); this.evidence = new Map(); this.workflows = new Map(); this.versions = new Map(); this.assignments = new Map(); }
  async getWorkflow(flowId) { return structuredClone(this.workflows.get(flowId) || null); }
  async listWorkflows() { return [...this.workflows.values()].map((item) => structuredClone(item)); }
  async saveWorkflow(record, expectedRevision = null) {
    const prior = this.workflows.get(record.flow_id);
    if (prior && prior.draft_revision !== expectedRevision || !prior && expectedRevision != null) throw new Error('workflow_conflict');
    const next = { ...structuredClone(record), draft_revision: (prior?.draft_revision || 0) + 1, updated_at: now() };
    this.workflows.set(record.flow_id, next); return structuredClone(next);
  }
  async putWorkflowVersion(flowId, version, schema) {
    const key = `${flowId}@${version}`;
    if (this.versions.has(key)) {
      if (sha256(JSON.stringify(this.versions.get(key))) === sha256(JSON.stringify(schema))) return;
      throw new Error('workflow_version_conflict');
    }
    this.versions.set(key, structuredClone(schema));
  }
  async getWorkflowVersion(flowId, version) { return structuredClone(this.versions.get(`${flowId}@${version}`) || null); }
  async getAssignment(workspaceId, flowId) { return structuredClone(this.assignments.get(`${workspaceId}:${flowId}`) || null); }
  async putAssignment(workspaceId, flowId, state) {
    const item = { workspace_id: workspaceId, flow_id: flowId, state, updated_at: now() };
    this.assignments.set(`${workspaceId}:${flowId}`, item); return structuredClone(item);
  }
  async listAssignments(workspaceId = null) {
    return [...this.assignments.values()].filter((item) => !workspaceId || item.workspace_id === workspaceId).map((item) => structuredClone(item));
  }
  async getTemplate(flowId = FLOW_ID) { return this.templates.get(flowId) || null; }
  async putTemplate(value, flowId = FLOW_ID) {
    const template = latestTemplate(flowId); if (!template) throw new Error('unknown_flow');
    const item = { flow_id: flowId, version: template.version, definition_hash: template.definition_hash,
      enabled: value.enabled === true, updated_at: now() };
    this.templates.set(flowId, item); return item;
  }
  async getConfig(workspaceId, flowId = FLOW_ID) {
    return this.configs.get(`${workspaceId}:${flowId}`) || (flowId === FLOW_ID ? this.configs.get(workspaceId) : null) || null;
  }
  async putConfig(workspaceId, value, flowId = FLOW_ID) {
    if (!validWorkspace(workspaceId) || !latestTemplate(flowId) && !await this.getWorkflow(flowId)) throw new Error('invalid_workspace_or_flow');
    this.configs.set(`${workspaceId}:${flowId}`, value); return value;
  }
  async createCase(workspaceId, input, idempotencyKey, linkHash, config,
    template = latestTemplate(FLOW_ID), actor = 'customer_api') {
    if (!validWorkspace(workspaceId)) throw new Error('invalid_workspace');
    if (!template || template.supplierBundle !== 'renderer' && !latestTemplate(template.flow_id)) throw new Error('unknown_flow');
    const idempotencyHash = sha256(`${workspaceId}:${template.flow_id}:${idempotencyKey}`);
    const key = `${workspaceId}:${idempotencyHash}`;
    const fingerprint = sha256(JSON.stringify(input));
    const prior = this.idempotency.get(key) || (template.flow_id === FLOW_ID
      ? this.idempotency.get(`${workspaceId}:${sha256(`${workspaceId}:${idempotencyKey}`)}`) : null);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('idempotency_conflict');
      return { case: await this.getCase(workspaceId, prior.application_id), reused: true };
    }
    const item = newCase(workspaceId, input, idempotencyHash, linkHash, config, template, actor);
    this.cases.set(`${workspaceId}:${item.application_id}`, item);
    this.idempotency.set(key, { application_id: item.application_id, fingerprint });
    this.links.set(linkHash, { workspaceId, applicationId: item.application_id });
    return { case: structuredClone(item), reused: false };
  }
  async getCase(workspaceId, applicationId) {
    if (!validWorkspace(workspaceId) || !validId(applicationId)) return null;
    const item = this.cases.get(`${workspaceId}:${applicationId}`);
    return item ? structuredClone(item) : null;
  }
  async updateCase(workspaceId, applicationId, mutate) {
    const item = await this.getCase(workspaceId, applicationId);
    if (!item) return null;
    const updated = await mutate(item);
    if (!updated) return item;
    updated.updated_at = now();
    this.cases.set(`${workspaceId}:${applicationId}`, structuredClone(updated));
    return structuredClone(updated);
  }
  async findLink(linkHash) { return this.links.get(linkHash) || null; }
  async putLink(workspaceId, applicationId, linkHash) {
    this.links.set(linkHash, { workspaceId, applicationId });
  }
  async listCases(workspaceId) {
    return [...this.cases.values()].filter((item) => item.workspace_id === workspaceId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(({ application_id, flow_id, template_version, customer_reference, status, created_at, updated_at, submitted_at, application_revision, link_delivery, restart }) =>
        ({ application_id, flow_id, template_version, customer_reference, status, created_at, updated_at, submitted_at,
          application_revision: application_revision || 1, link_delivery: link_delivery || 'not_attempted', restart: restart || null }));
  }
  async putEvidence(workspaceId, applicationId, documentId, bytes) {
    const ref = `${workspaceId}/${applicationId}/${documentId}`;
    this.evidence.set(ref, encryptBytes(bytes));
    return ref;
  }
  async putWorkflowAsset(workspaceId, flowId, assetId, bytes) {
    if (!validWorkspace(workspaceId) || !validId(assetId)) throw new Error('invalid_workflow_asset');
    this.evidence.set(`workflow-asset:${workspaceId}:${flowId}:${assetId}`, encryptBytes(bytes));
  }
  async getWorkflowAsset(workspaceId, flowId, assetId) {
    const value = this.evidence.get(`workflow-asset:${workspaceId}:${flowId}:${assetId}`);
    return value ? decryptBytes(value) : null;
  }
  async getEvidence(workspaceId, applicationId, documentId) {
    const value = this.evidence.get(`${workspaceId}/${applicationId}/${documentId}`);
    return value ? decryptBytes(value) : null;
  }
}

export class AzureFloStore {
  constructor({ blobUrl = process.env.FLO_BLOB_URL, tableUrl = process.env.FLO_TABLE_URL,
    tableName = process.env.FLO_TABLE_NAME || 'FloCases', containerName = process.env.FLO_CONTAINER_NAME || 'flo-evidence',
    credential = new ContainerAppsManagedIdentityCredential(), table, container } = {}) {
    if (!(table && container) && (!blobUrl || !tableUrl)) throw new Error('flo_storage_unavailable');
    this.table = table || new TableClient(tableUrl, tableName, credential);
    this.container = container || new BlobServiceClient(blobUrl, credential).getContainerClient(containerName);
  }
  blob(path) { return this.container.getBlockBlobClient(path); }
  async download(path) {
    try { const response = await this.blob(path).download(); const chunks = []; for await (const chunk of response.readableStreamBody) chunks.push(chunk); return Buffer.concat(chunks); }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  workflowBlob(flowId, suffix) { return `workflows/${flowId}/${suffix}.json.enc`; }
  async getWorkflow(flowId) {
    try {
      const row = await this.table.getEntity('flo-workflows', flowId);
      const draft = await this.download(this.workflowBlob(flowId, `drafts/${row.draftRevision}`))
        || await this.download(this.workflowBlob(flowId, 'draft'));
      return { flow_id: flowId, name: row.name, owner_workspace_id: row.ownerWorkspaceId || null,
        source_flow_id: row.sourceFlowId || null, source_version: row.sourceVersion || null,
        lifecycle: row.lifecycle, published_version: row.publishedVersion || null,
        definition_hash: row.definitionHash || null, schema_version: row.schemaVersion || '1.0.0',
        draft_revision: row.draftRevision, draft: draft ? decryptJson(draft) : null,
        updated_at: row.updatedAt };
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  async listWorkflows() {
    const result = [];
    for await (const row of this.table.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${'flo-workflows'}` } })) {
      result.push({ flow_id: row.rowKey, name: row.name, owner_workspace_id: row.ownerWorkspaceId || null,
        source_flow_id: row.sourceFlowId || null, source_version: row.sourceVersion || null,
        lifecycle: row.lifecycle, published_version: row.publishedVersion || null,
        definition_hash: row.definitionHash || null, schema_version: row.schemaVersion || '1.0.0',
        draft_revision: row.draftRevision, updated_at: row.updatedAt });
    }
    return result;
  }
  async saveWorkflow(record, expectedRevision = null) {
    const prior = await this.getWorkflow(record.flow_id);
    if (prior && prior.draft_revision !== expectedRevision || !prior && expectedRevision != null) throw new Error('workflow_conflict');
    const revision = (prior?.draft_revision || 0) + 1;
    const row = { partitionKey: 'flo-workflows', rowKey: record.flow_id, name: record.name,
      ownerWorkspaceId: record.owner_workspace_id || '', sourceFlowId: record.source_flow_id || '',
      sourceVersion: record.source_version || '', lifecycle: record.lifecycle,
      publishedVersion: record.published_version || '', definitionHash: record.definition_hash || '',
      schemaVersion: record.schema_version || '1.0.0', draftRevision: revision, updatedAt: now() };
    if (record.draft) {
      const path = this.workflowBlob(record.flow_id, `drafts/${revision}`);
      try { await this.blob(path).uploadData(encryptJson(record.draft), { conditions: { ifNoneMatch: '*' } }); }
      catch (error) {
        if (!conflict(error)) throw error;
        const existing = await this.download(path);
        if (!existing || sha256(JSON.stringify(decryptJson(existing))) !== sha256(JSON.stringify(record.draft)))
          throw new Error('workflow_conflict');
      }
    }
    if (prior) {
      const current = await this.table.getEntity('flo-workflows', record.flow_id);
      if (current.draftRevision !== expectedRevision) throw new Error('workflow_conflict');
      await this.table.updateEntity(row, 'Replace', { etag: current.etag });
    } else await this.table.createEntity(row);
    return { ...record, draft_revision: revision, updated_at: row.updatedAt };
  }
  async putWorkflowVersion(flowId, version, schema) {
    const path = this.workflowBlob(flowId, `versions/${version}`);
    try { await this.blob(path).uploadData(encryptJson(schema),
      { conditions: { ifNoneMatch: '*' } }); }
    catch (error) { if (!conflict(error)) throw error;
      const existing = await this.download(path);
      if (!existing || sha256(JSON.stringify(decryptJson(existing))) !== sha256(JSON.stringify(schema)))
        throw new Error('workflow_version_conflict'); }
  }
  async getWorkflowVersion(flowId, version) {
    const value = await this.download(this.workflowBlob(flowId, `versions/${version}`));
    return value ? decryptJson(value) : null;
  }
  async getAssignment(workspaceId, flowId) {
    try { const row = await this.table.getEntity(`flo-assign-${workspaceId}`, flowId);
      return { workspace_id: workspaceId, flow_id: flowId, state: row.state, updated_at: row.updatedAt }; }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  async putAssignment(workspaceId, flowId, state) {
    if (!validWorkspace(workspaceId)) throw new Error('invalid_workspace');
    const updated_at = now();
    await this.table.upsertEntity({ partitionKey: `flo-assign-${workspaceId}`, rowKey: flowId,
      state, updatedAt: updated_at }, 'Replace');
    return { workspace_id: workspaceId, flow_id: flowId, state, updated_at };
  }
  async listAssignments(workspaceId = null) {
    const result = [];
    const filter = workspaceId ? odata`PartitionKey eq ${`flo-assign-${workspaceId}`}`
      : odata`PartitionKey ge ${'flo-assign-'} and PartitionKey lt ${'flo-assign.'}`;
    for await (const row of this.table.listEntities({ queryOptions: { filter } })) result.push({
      workspace_id: row.partitionKey.slice(11), flow_id: row.rowKey, state: row.state, updated_at: row.updatedAt });
    return result;
  }
  async getTemplate(flowId = FLOW_ID) {
    try { const row = await this.table.getEntity('platform', flowId); return { flow_id: flowId, version: row.version,
      definition_hash: row.definitionHash || latestTemplate(flowId)?.definition_hash || null,
      enabled: row.enabled, updated_at: row.updatedAt }; }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  async putTemplate(value, flowId = FLOW_ID) {
    const template = latestTemplate(flowId); if (!template) throw new Error('unknown_flow');
    const item = { flow_id: flowId, version: template.version, definition_hash: template.definition_hash,
      enabled: value.enabled === true, updated_at: now() };
    await this.table.upsertEntity({ partitionKey: 'platform', rowKey: flowId, version: item.version,
      definitionHash: item.definition_hash, enabled: item.enabled, updatedAt: item.updated_at }, 'Replace');
    return item;
  }
  async getConfig(workspaceId, flowId = FLOW_ID) {
    if (!validWorkspace(workspaceId)) return null;
    const bytes = await this.download(`${workspaceId}/config.${flowId}.json.enc`)
      || (flowId === FLOW_ID ? await this.download(`${workspaceId}/config.json.enc`) : null);
    return bytes ? decryptJson(bytes) : null;
  }
  async putConfig(workspaceId, value, flowId = FLOW_ID) {
    if (!validWorkspace(workspaceId) || !latestTemplate(flowId) && !await this.getWorkflow(flowId)) throw new Error('invalid_workspace_or_flow');
    await this.blob(`${workspaceId}/config.${flowId}.json.enc`).uploadData(encryptJson(value), { blobHTTPHeaders: { blobContentType: 'application/octet-stream' } });
    return value;
  }
  async getCase(workspaceId, applicationId) {
    if (!validWorkspace(workspaceId) || !validId(applicationId)) return null;
    const bytes = await this.download(`${workspaceId}/${applicationId}/case.json.enc`);
    return bytes ? decryptJson(bytes) : null;
  }
  async createCase(workspaceId, input, idempotencyKey, linkHash, config,
    template = latestTemplate(FLOW_ID), actor = 'customer_api') {
    if (!validWorkspace(workspaceId)) throw new Error('invalid_workspace');
    if (!template || template.supplierBundle !== 'renderer' && !latestTemplate(template.flow_id)) throw new Error('unknown_flow');
    const idempotencyHash = sha256(`${workspaceId}:${template.flow_id}:${idempotencyKey}`);
    const fingerprint = sha256(JSON.stringify(input));
    const idemRow = `idem-${idempotencyHash}`;
    if (template.flow_id === FLOW_ID) {
      try {
        const legacy = await this.table.getEntity(workspaceId, `idem-${sha256(`${workspaceId}:${idempotencyKey}`)}`);
        if (legacy.fingerprint !== fingerprint) throw new Error('idempotency_conflict');
        const priorCase = await this.getCase(workspaceId, legacy.applicationId);
        if (!priorCase) throw new Error('flo_case_incomplete');
        return { case: priorCase, reused: true };
      } catch (error) { if (!missing(error)) throw error; }
    }
    try {
      const prior = await this.table.getEntity(workspaceId, idemRow);
      if (prior.fingerprint !== fingerprint) throw new Error('idempotency_conflict');
      if (prior.ready !== true) {
        // A concurrent request must not replace a link while its creator is still writing.
        if (Date.now() - Date.parse(prior.createdAt || 0) < 30_000) throw new Error('flo_case_incomplete');
        let item = await this.getCase(workspaceId, prior.applicationId);
        if (!item) {
          item = { ...newCase(workspaceId, input, idempotencyHash, linkHash, config, template, actor), application_id: prior.applicationId };
          try { await this.blob(`${workspaceId}/${item.application_id}/case.json.enc`).uploadData(encryptJson(item),
            { conditions: { ifNoneMatch: '*' } }); }
          catch (error) { if (!conflict(error)) throw error; item = await this.getCase(workspaceId, prior.applicationId); }
        }
        item = await this.updateCase(workspaceId, prior.applicationId, (current) => {
          current.link_hash = linkHash; current.link_redeemed_at = null;
          current.link_expires_at = new Date(Date.now() + 7 * 86400_000).toISOString();
          return current;
        });
        await this.table.upsertEntity({ partitionKey: workspaceId, rowKey: `case-${item.application_id}`,
          applicationId: item.application_id, status: item.status,
          flowId: item.flow_id, templateVersion: item.template_version,
          customerReference: item.customer_reference, submittedAt: item.submitted_at || '',
          linkDelivery: item.link_delivery || 'not_attempted',
          bucket: caseBucket(item), applicationRevision: item.application_revision || 1,
          createdAt: item.created_at, updatedAt: item.updated_at }, 'Replace');
        await this.table.upsertEntity({ partitionKey: 'links', rowKey: linkHash,
          workspaceId, applicationId: item.application_id }, 'Replace');
        await this.table.updateEntity({ partitionKey: workspaceId, rowKey: idemRow,
          applicationId: item.application_id, fingerprint, createdAt: prior.createdAt, ready: true }, 'Merge');
        return { case: item, reused: false };
      }
      const item = await this.getCase(workspaceId, prior.applicationId);
      if (!item) throw new Error('flo_case_incomplete');
      return { case: item, reused: true };
    } catch (error) { if (!missing(error)) throw error; }
    const item = newCase(workspaceId, input, idempotencyHash, linkHash, config, template, actor);
    try {
      await this.table.createEntity({ partitionKey: workspaceId, rowKey: idemRow, applicationId: item.application_id,
        fingerprint, createdAt: now(), ready: false });
    } catch (error) {
      if (conflict(error)) return this.createCase(workspaceId, input, idempotencyKey, linkHash, config, template, actor);
      throw error;
    }
    try {
      await this.blob(`${workspaceId}/${item.application_id}/case.json.enc`).uploadData(encryptJson(item));
      await this.table.createEntity({ partitionKey: workspaceId, rowKey: `case-${item.application_id}`, applicationId: item.application_id,
        status: item.status, flowId: item.flow_id, templateVersion: item.template_version,
        customerReference: item.customer_reference, submittedAt: '', linkDelivery: 'not_attempted',
        bucket: caseBucket(item), applicationRevision: 1,
        createdAt: item.created_at, updatedAt: item.updated_at });
      await this.table.createEntity({ partitionKey: 'links', rowKey: linkHash, workspaceId, applicationId: item.application_id });
      await this.table.updateEntity({ partitionKey: workspaceId, rowKey: idemRow,
        applicationId: item.application_id, fingerprint, ready: true }, 'Merge');
      return { case: item, reused: false };
    } catch (error) { throw new Error('flo_case_incomplete', { cause: error }); }
  }
  async updateCase(workspaceId, applicationId, mutate) {
    const path = `${workspaceId}/${applicationId}/case.json.enc`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const blob = this.blob(path);
      let response;
      try { response = await blob.download(); } catch (error) { if (missing(error)) return null; throw error; }
      const chunks = []; for await (const chunk of response.readableStreamBody) chunks.push(chunk);
      const item = decryptJson(Buffer.concat(chunks));
      const updated = await mutate(item);
      if (!updated) return item;
      updated.updated_at = now();
      try {
        await blob.uploadData(encryptJson(updated), { conditions: { ifMatch: response.etag } });
        await this.table.upsertEntity({ partitionKey: workspaceId, rowKey: `case-${applicationId}`, applicationId,
          status: updated.status, flowId: updated.flow_id, templateVersion: updated.template_version,
          customerReference: updated.customer_reference, submittedAt: updated.submitted_at || '',
          linkDelivery: updated.link_delivery || 'not_attempted', bucket: caseBucket(updated),
          applicationRevision: updated.application_revision || 1,
          createdAt: updated.created_at, updatedAt: updated.updated_at }, 'Replace');
        return updated;
      } catch (error) { if (!conflict(error)) throw error; }
    }
    throw new Error('flo_case_concurrent_update');
  }
  async findLink(linkHash) {
    try { const row = await this.table.getEntity('links', linkHash); return { workspaceId: row.workspaceId, applicationId: row.applicationId }; }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  async putLink(workspaceId, applicationId, linkHash) {
    await this.table.createEntity({ partitionKey: 'links', rowKey: linkHash, workspaceId, applicationId });
  }
  async listCases(workspaceId) {
    if (!validWorkspace(workspaceId)) return [];
    const rows = [];
    for await (const row of this.table.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${workspaceId} and RowKey ge ${'case-'} and RowKey lt ${'case.'}` } }))
      rows.push({ application_id: row.applicationId, status: row.status,
        flow_id: row.flowId || null, template_version: row.templateVersion || null,
        customer_reference: row.customerReference || null, submitted_at: row.submittedAt || null,
        application_revision: row.applicationRevision || 1, link_delivery: row.linkDelivery || 'not_attempted',
        created_at: row.createdAt, updated_at: row.updatedAt });
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const cases = [];
    for (let offset = 0; offset < rows.length; offset += 16) {
      const batch = await Promise.all(rows.slice(offset, offset + 16).map(async (row) => {
        if (row.flow_id) return row;
        const item = await this.getCase(workspaceId, row.application_id);
        return item ? { ...row, flow_id: item.flow_id, template_version: item.template_version,
          customer_reference: item.customer_reference, submitted_at: item.submitted_at,
          application_revision: item.application_revision || 1,
          link_delivery: item.link_delivery || 'not_attempted', restart: item.restart || null } : null;
      }));
      cases.push(...batch.filter(Boolean));
    }
    return cases;
  }
  async putEvidence(workspaceId, applicationId, documentId, bytes) {
    if (!validWorkspace(workspaceId) || !validId(applicationId) || !validId(documentId)) throw new Error('invalid_document');
    const ref = `${workspaceId}/${applicationId}/${documentId}`;
    await this.blob(ref).uploadData(encryptBytes(bytes), { blobHTTPHeaders: { blobContentType: 'application/octet-stream' } });
    return ref;
  }
  async putWorkflowAsset(workspaceId, flowId, assetId, bytes) {
    if (!validWorkspace(workspaceId) || !validId(assetId)) throw new Error('invalid_workflow_asset');
    await this.blob(`${workspaceId}/workflow-assets/${flowId}/${assetId}`).uploadData(encryptBytes(bytes),
      { conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: 'application/octet-stream' } });
  }
  async getWorkflowAsset(workspaceId, flowId, assetId) {
    if (!validWorkspace(workspaceId) || !validId(assetId)) return null;
    const value = await this.download(`${workspaceId}/workflow-assets/${flowId}/${assetId}`);
    return value ? decryptBytes(value) : null;
  }
  async getEvidence(workspaceId, applicationId, documentId) {
    if (!validWorkspace(workspaceId) || !validId(applicationId) || !validId(documentId)) return null;
    const bytes = await this.download(`${workspaceId}/${applicationId}/${documentId}`);
    return bytes ? decryptBytes(bytes) : null;
  }
}

export function createFloStore() {
  if (process.env.FLO_ENABLED !== 'true') return null;
  return process.env.NODE_ENV === 'test' ? new MemoryFloStore() : new AzureFloStore();
}
