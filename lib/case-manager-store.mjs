import { createHash, randomUUID } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { TableClient, odata } from '@azure/data-tables';
import { QueueClient } from '@azure/storage-queue';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';
import { CASE_SCHEMA_VERSION, caseIsReadable } from './case-manager-contract.mjs';
import { decryptCasePayload, encryptCasePayload } from './case-manager-crypto.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const workspacePartition = (workspaceId) => `w-${sha256(`case-manager:${workspaceId}`)}`;
const transactionIndexKey = (transactionId) => `tx-${sha256(String(transactionId).toLowerCase())}`;
const reverseDate = (date) => String(9_999_999_999_999 - Date.parse(date)).padStart(13, '0');
const indexToken = (value) => value === '*' ? 'all' : sha256(value).slice(0, 20);
const indexPrefix = (service, outcome) => `idx-${indexToken(service)}-${indexToken(outcome)}-`;
const indexKeys = (row, outcome = row.outcome) => [
  ['*', '*'], [row.serviceId, '*'], ['*', outcome], [row.serviceId, outcome]
].map(([service, result]) => `${indexPrefix(service, result)}${reverseDate(row.acceptedAt)}-${row.caseId}`);
const isMissing = (error) => error?.statusCode === 404 || error?.code === 'ResourceNotFound';
const isConflict = (error) => [409, 412].includes(error?.statusCode);
const metadata = (row) => ({ id: row.caseId, service_id: row.serviceId, accepted_at: row.acceptedAt,
  expires_at: row.expiresAt, state: row.state, outcome: row.outcome, outcome_reason_codes: JSON.parse(row.reasonCodesJson || '[]'),
  attempt_ids: JSON.parse(row.attemptIdsJson || '[]'), final_http_status: row.finalHttpStatus || null });
const sanitizeReasonCodes = (codes) => (Array.isArray(codes) ? codes : []).filter((code) => /^[A-Z0-9_]{1,64}$/.test(code)).slice(0, 20);

function newRow({ workspaceId, serviceId, acceptedAt, expiresAt, transactionId, policyVersion, logicalKey }) {
  const caseId = randomUUID();
  return { partitionKey: workspacePartition(workspaceId), rowKey: `case-${caseId}`, caseId, serviceId,
    acceptedAt, expiresAt, state: 'pending', outcome: 'pending', reasonCodesJson: '[]',
    attemptIdsJson: JSON.stringify([transactionId]), policyVersion,
    logicalKeyHash: logicalKey ? sha256(`${workspaceId}:${logicalKey}`) : '',
    finalHttpStatus: 0, hasPayload: false, createdAt: new Date().toISOString() };
}

async function download(blob) {
  const response = await blob.download();
  const chunks = [];
  for await (const chunk of response.readableStreamBody) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export class MemoryCaseManagerStore {
  constructor({ keys = { 1: 'a'.repeat(64) } } = {}) {
    this.keys = keys;
    this.rows = new Map();
    this.payloads = new Map();
    this.logical = new Map();
    this.transactions = new Map();
    this.reconcileMessages = [];
    this.retirementTasks = new Map();
  }
  async createIntent(input) {
    const logicalId = input.logicalKey && sha256(`${input.workspaceId}:${input.logicalKey}`);
    const existing = logicalId && this.logical.get(logicalId);
    if (existing) {
      const row = this.rows.get(existing);
      if (!row) this.logical.delete(logicalId);
      else if (!JSON.parse(row.attemptIdsJson).includes(input.transactionId)) {
        row.attemptIdsJson = JSON.stringify([...JSON.parse(row.attemptIdsJson), input.transactionId]);
        this.transactions.set(`${row.partitionKey}:${transactionIndexKey(input.transactionId)}`, row.caseId);
      }
      if (row) return { ...metadata(row), reused: true };
    }
    const row = newRow(input);
    this.rows.set(row.caseId, row);
    this.transactions.set(`${row.partitionKey}:${transactionIndexKey(input.transactionId)}`, row.caseId);
    if (logicalId) this.logical.set(logicalId, row.caseId);
    return { ...metadata(row), reused: false };
  }
  async captureFinal(workspaceId, caseId, { response, contentType, httpStatus, outcome,
    reasonCodes = [], artifactRefs = [], originalArtifactOwner = null, sourceId = null, state = 'complete' }) {
    const row = this.rows.get(caseId);
    if (!row || row.partitionKey !== workspacePartition(workspaceId) || !caseIsReadable({ expires_at: row.expiresAt })) return null;
    if (row.state === 'complete') return metadata(row);
    const payload = { schema_version: CASE_SCHEMA_VERSION, case_id: caseId, workspace_id: workspaceId,
      service_id: row.serviceId, accepted_at: row.acceptedAt, expires_at: row.expiresAt,
      state, outcome, outcome_reason_codes: sanitizeReasonCodes(reasonCodes), attempt_ids: JSON.parse(row.attemptIdsJson),
      final_response: response, final_content_type: contentType || null, final_http_status: httpStatus,
      original_artifact_owner: originalArtifactOwner, artifact_refs: artifactRefs, source_id: sourceId };
    this.payloads.set(caseId, encryptCasePayload(payload, { workspaceId, caseId, keys: this.keys }));
    Object.assign(row, { state, outcome, reasonCodesJson: JSON.stringify(sanitizeReasonCodes(reasonCodes)),
      finalHttpStatus: httpStatus, hasPayload: true });
    return metadata(row);
  }
  async agedPending(at = new Date(Date.now() - 2 * 60 * 60 * 1000), limit = 100) {
    return [...this.rows.values()].filter((row) => row.state === 'pending' && Date.parse(row.acceptedAt) <= new Date(at).getTime()).slice(0, limit).length;
  }
  async markIncomplete(workspaceId, caseId, reasonCode = 'CAPTURE_FAILED') {
    const row = this.rows.get(caseId);
    if (!row || row.partitionKey !== workspacePartition(workspaceId)) return null;
    Object.assign(row, { state: 'incomplete', outcome: 'could_not_complete', reasonCodesJson: JSON.stringify(sanitizeReasonCodes([reasonCode])) });
    return metadata(row);
  }
  async linkAsync(workspaceId, caseId, { sourceId, originalOwner }) {
    const row = this.rows.get(caseId);
    if (!row || row.partitionKey !== workspacePartition(workspaceId)) return null;
    this.reconcileMessages.push({ version: 1, workspaceId, caseId, serviceId: row.serviceId,
      sourceId, originalOwner, attempt: 0 });
    return metadata(row);
  }
  async getCase(workspaceId, caseId, { activePolicyVersion } = {}) {
    const row = this.rows.get(caseId);
    if (!row || row.partitionKey !== workspacePartition(workspaceId) || !caseIsReadable({ expires_at: row.expiresAt })
      || (activePolicyVersion != null && row.policyVersion < activePolicyVersion)) return null;
    const encrypted = this.payloads.get(caseId);
    return { ...metadata(row), payload: encrypted ? decryptCasePayload(encrypted, { workspaceId, caseId, keys: this.keys }) : null };
  }
  async findByTransaction(workspaceId, transactionId, { activePolicyVersion } = {}) {
    const partition = workspacePartition(workspaceId);
    const caseId = this.transactions.get(`${partition}:${transactionIndexKey(transactionId)}`);
    const row = caseId ? this.rows.get(caseId) : null;
    return row && caseIsReadable({ expires_at: row.expiresAt })
      && (activePolicyVersion == null || row.policyVersion >= activePolicyVersion) ? metadata(row) : null;
  }
  async listCases(workspaceId, { serviceId, outcome, from, to, limit = 25, cursor = '', activePolicyVersion } = {}) {
    const rows = [...this.rows.values()].filter((row) => row.partitionKey === workspacePartition(workspaceId)
      && caseIsReadable({ expires_at: row.expiresAt })
      && (activePolicyVersion == null || row.policyVersion >= activePolicyVersion)
      && (!serviceId || row.serviceId === serviceId) && (!outcome || row.outcome === outcome)
      && (!from || row.acceptedAt >= from) && (!to || row.acceptedAt <= to))
      .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) || b.caseId.localeCompare(a.caseId));
    const start = cursor ? rows.findIndex((row) => row.caseId === cursor) + 1 : 0;
    const page = rows.slice(start, start + Math.min(Math.max(limit, 1), 100));
    return { cases: page.map(metadata), next_cursor: rows[start + page.length] ? page.at(-1)?.caseId || null : null };
  }
  async purgeExpired(at = new Date(), limit = 100) {
    let removed = 0;
    for (const [caseId, row] of this.rows) {
      if (Date.parse(row.expiresAt) > new Date(at).getTime()) continue;
      this.rows.delete(caseId);
      this.payloads.delete(caseId);
      for (const transactionId of JSON.parse(row.attemptIdsJson)) {
        this.transactions.delete(`${row.partitionKey}:${transactionIndexKey(transactionId)}`);
      }
      if (row.logicalKeyHash) this.logical.delete(row.logicalKeyHash);
      removed++;
      if (removed >= limit) break;
    }
    return removed;
  }
  async scheduleRetirement(workspaceId, beforeVersion) {
    this.reconcileMessages.push({ version: 1, kind: 'retire', workspaceId, beforeVersion, cursor: '' });
  }
  async prepareRetirement(workspaceId, beforeVersion) {
    const task = { partitionKey: 'retirement', rowKey: `due-${new Date().toISOString()}-${randomUUID()}`,
      workspaceId, beforeVersion, cursor: '', createdAt: new Date().toISOString() };
    this.retirementTasks.set(task.rowKey, task);
    return task;
  }
  async pendingRetirements(limit = 8, at = new Date()) {
    return [...this.retirementTasks.values()]
      .filter((task) => task.rowKey < `due-${new Date(at).toISOString()}~`)
      .sort((a, b) => a.rowKey.localeCompare(b.rowKey)).slice(0, limit);
  }
  async advanceRetirementTask(task, { done, cursor = '' }, { delayMs = 120_000 } = {}) {
    if (!this.retirementTasks.has(task.rowKey)) return;
    this.retirementTasks.delete(task.rowKey);
    if (done) return;
    const next = { ...task, rowKey: `due-${new Date(Date.now() + delayMs).toISOString()}-${randomUUID()}`, cursor };
    this.retirementTasks.set(next.rowKey, next);
  }
  async retireWorkspaceCases(workspaceId, beforeVersion, { cursor = '', limit = 10_000 } = {}) {
    const rows = [...this.rows.values()].filter((row) => row.partitionKey === workspacePartition(workspaceId)
      && (!cursor || row.rowKey > cursor)).sort((a, b) => a.rowKey.localeCompare(b.rowKey));
    const page = rows.slice(0, limit);
    for (const row of page) {
      if (Number(row.policyVersion || 0) >= beforeVersion) continue;
      this.rows.delete(row.caseId);
      this.payloads.delete(row.caseId);
      for (const transactionId of JSON.parse(row.attemptIdsJson)) {
        this.transactions.delete(`${row.partitionKey}:${transactionIndexKey(transactionId)}`);
      }
      if (row.logicalKeyHash) this.logical.delete(row.logicalKeyHash);
    }
    return rows.length > page.length ? { done: false, cursor: page.at(-1).rowKey } : { done: true, cursor: '' };
  }
}

export class AzureCaseManagerStore {
  constructor({ blobUrl = process.env.CASE_MANAGER_BLOB_URL, tableUrl = process.env.CASE_MANAGER_TABLE_URL,
    tableName = 'CaseManagerMetadata', containerName = 'case-manager-private',
    queueUrl = process.env.CASE_MANAGER_QUEUE_URL, credential = new ContainerAppsManagedIdentityCredential(), table, container, queue } = {}) {
    if (!(table && container) && (!blobUrl || !tableUrl)) throw new Error('case_manager_storage_unavailable');
    this.table = table || new TableClient(tableUrl, tableName, credential);
    this.container = container || new BlobServiceClient(blobUrl, credential).getContainerClient(containerName);
    this.queue = queue || (queueUrl ? new QueueClient(`${queueUrl.replace(/\/$/, '')}/case-manager-reconcile`, credential) : null);
  }
  blob(partitionKey, caseId) { return this.container.getBlockBlobClient(`${partitionKey}/${caseId}.bin`); }
  async row(workspaceId, caseId) {
    if (!/^[0-9a-f-]{36}$/.test(caseId)) return null;
    try { return await this.table.getEntity(workspacePartition(workspaceId), `case-${caseId}`); }
    catch (error) { if (isMissing(error)) return null; throw error; }
  }
  async createIntent(input) {
    const row = newRow(input);
    const logicalRowKey = row.logicalKeyHash ? `idem-${row.logicalKeyHash}` : '';
    if (logicalRowKey) {
      try {
        const prior = await this.table.getEntity(row.partitionKey, logicalRowKey);
        return this.addAttempt(input.workspaceId, prior.caseId, input.transactionId);
      } catch (error) { if (!isMissing(error)) throw error; }
    }
    const expiryKey = `${row.expiresAt}-${row.caseId}`;
    await this.table.createEntity({ partitionKey: 'expiry', rowKey: expiryKey,
      ownerPartition: row.partitionKey, caseId: row.caseId, acceptedAt: row.acceptedAt });
    try {
      await this.table.createEntity({ partitionKey: 'pending', rowKey: `${row.acceptedAt}-${row.caseId}`,
        ownerPartition: row.partitionKey, caseId: row.caseId });
    } catch (error) {
      await this.table.deleteEntity('expiry', expiryKey).catch(() => {});
      throw error;
    }
    const actions = [['create', row], ...indexKeys(row).map((rowKey) => ['create', {
      partitionKey: row.partitionKey, rowKey, caseId: row.caseId }])];
    actions.push(['create', { partitionKey: row.partitionKey, rowKey: transactionIndexKey(input.transactionId), caseId: row.caseId }]);
    if (logicalRowKey) actions.push(['create', { partitionKey: row.partitionKey, rowKey: logicalRowKey, caseId: row.caseId }]);
    try { await this.table.submitTransaction(actions); }
    catch (error) {
      if (isConflict(error) && logicalRowKey) {
        await Promise.all([
          this.table.deleteEntity('expiry', expiryKey).catch(() => {}),
          this.table.deleteEntity('pending', `${row.acceptedAt}-${row.caseId}`).catch(() => {})
        ]);
        const prior = await this.table.getEntity(row.partitionKey, logicalRowKey);
        return this.addAttempt(input.workspaceId, prior.caseId, input.transactionId);
      }
      throw error;
    }
    return { ...metadata(row), reused: false };
  }
  async addAttempt(workspaceId, caseId, transactionId) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await this.row(workspaceId, caseId);
      if (!row) throw new Error('case_manager_intent_missing');
      const ids = JSON.parse(row.attemptIdsJson);
      if (ids.includes(transactionId)) return { ...metadata(row), reused: true };
      try {
        await this.table.submitTransaction([
          ['update', { partitionKey: row.partitionKey, rowKey: row.rowKey,
            attemptIdsJson: JSON.stringify([...ids, transactionId]) }, 'Merge', { etag: row.etag }],
          ['create', { partitionKey: row.partitionKey, rowKey: transactionIndexKey(transactionId), caseId }]
        ]);
        return { ...metadata({ ...row, attemptIdsJson: JSON.stringify([...ids, transactionId]) }), reused: true };
      } catch (error) { if (!isConflict(error) || attempt === 7) throw error; }
    }
  }
  async linkAsync(workspaceId, caseId, { sourceId, originalOwner }) {
    const row = await this.row(workspaceId, caseId);
    if (!row || !this.queue) throw new Error('case_manager_reconcile_unavailable');
    if (!/^(?:ocr_|bsa_)[0-9a-f-]{36}$/.test(sourceId)) throw new Error('case_manager_source_invalid');
    const message = { version: 1, workspaceId, caseId, serviceId: row.serviceId,
      sourceId, originalOwner, attempt: 0 };
    await this.queue.sendMessage(Buffer.from(JSON.stringify(message)).toString('base64'), { messageTimeToLive: 7 * 24 * 60 * 60 });
    return metadata(row);
  }
  async markIncomplete(workspaceId, caseId, reasonCode = 'CAPTURE_FAILED') {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await this.row(workspaceId, caseId);
      if (!row || !caseIsReadable({ expires_at: row.expiresAt }) || row.state === 'complete') return row ? metadata(row) : null;
      const next = { ...row, state: 'incomplete', outcome: 'could_not_complete',
        reasonCodesJson: JSON.stringify(sanitizeReasonCodes([reasonCode])) };
      const { etag, timestamp, ...entity } = next;
      const oldKeys = indexKeys(row).slice(2);
      const newKeys = indexKeys(next).slice(2);
      try {
        await this.table.submitTransaction([['update', entity, 'Replace', { etag: row.etag }],
          ...oldKeys.filter((key) => !newKeys.includes(key)).map((rowKey) => ['delete', { partitionKey: row.partitionKey, rowKey }]),
          ...newKeys.filter((key) => !oldKeys.includes(key)).map((rowKey) => ['create', { partitionKey: row.partitionKey, rowKey, caseId }])]);
        await this.table.deleteEntity('pending', `${row.acceptedAt}-${row.caseId}`).catch((error) => { if (!isMissing(error)) throw error; });
        return metadata(next);
      } catch (error) { if (!isConflict(error) || attempt === 7) throw error; }
    }
  }
  async captureFinal(workspaceId, caseId, { response, contentType, httpStatus, outcome,
    reasonCodes = [], artifactRefs = [], originalArtifactOwner = null, sourceId = null, state = 'complete' }) {
    const row = await this.row(workspaceId, caseId);
    if (!row || !caseIsReadable({ expires_at: row.expiresAt })) return null;
    if (row.state === 'complete') return metadata(row);
    const codes = sanitizeReasonCodes(reasonCodes);
    const payload = { schema_version: CASE_SCHEMA_VERSION, case_id: caseId, workspace_id: workspaceId,
      service_id: row.serviceId, accepted_at: row.acceptedAt, expires_at: row.expiresAt,
      state, outcome, outcome_reason_codes: codes, attempt_ids: JSON.parse(row.attemptIdsJson),
      final_response: response, final_content_type: contentType || null, final_http_status: httpStatus,
      original_artifact_owner: originalArtifactOwner, artifact_refs: artifactRefs, source_id: sourceId };
    const blob = this.blob(row.partitionKey, caseId);
    const bytes = encryptCasePayload(payload, { workspaceId, caseId });
    let saved = payload;
    try {
      await blob.uploadData(bytes, {
        conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' }
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      // The first encrypted final response wins even if its metadata update was interrupted.
      saved = decryptCasePayload(await download(blob), { workspaceId, caseId });
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.row(workspaceId, caseId);
      if (!current || !caseIsReadable({ expires_at: current.expiresAt })) return null;
      if (current.state === 'complete') return metadata(current);
      const updated = { ...current, state: saved.state, outcome: saved.outcome,
        reasonCodesJson: JSON.stringify(saved.outcome_reason_codes),
        finalHttpStatus: saved.final_http_status, hasPayload: true };
      const { etag, timestamp, ...entity } = updated;
      const oldOutcomeKeys = indexKeys(current).slice(2);
      const newOutcomeKeys = indexKeys(updated).slice(2);
      const actions = [['update', entity, 'Replace', { etag: current.etag }],
        ...oldOutcomeKeys.filter((key) => !newOutcomeKeys.includes(key)).map((rowKey) => ['delete', { partitionKey: current.partitionKey, rowKey }]),
        ...newOutcomeKeys.filter((key) => !oldOutcomeKeys.includes(key)).map((rowKey) => ['create', {
          partitionKey: current.partitionKey, rowKey, caseId }])];
      try {
        await this.table.submitTransaction(actions);
        await this.table.deleteEntity('pending', `${row.acceptedAt}-${row.caseId}`).catch((error) => { if (!isMissing(error)) throw error; });
        return metadata(updated);
      }
      catch (error) { if (!isConflict(error) || attempt === 7) throw error; }
    }
  }
  async getCase(workspaceId, caseId, { activePolicyVersion } = {}) {
    const row = await this.row(workspaceId, caseId);
    if (!row || !caseIsReadable({ expires_at: row.expiresAt })
      || (activePolicyVersion != null && row.policyVersion < activePolicyVersion)) return null;
    const payload = row.hasPayload ? decryptCasePayload(await download(this.blob(row.partitionKey, caseId)), { workspaceId, caseId }) : null;
    return { ...metadata(row), payload };
  }
  async findByTransaction(workspaceId, transactionId, { activePolicyVersion } = {}) {
    const partition = workspacePartition(workspaceId);
    let index;
    try { index = await this.table.getEntity(partition, transactionIndexKey(transactionId)); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    const row = await this.row(workspaceId, index.caseId);
    return row && caseIsReadable({ expires_at: row.expiresAt })
      && (activePolicyVersion == null || row.policyVersion >= activePolicyVersion) ? metadata(row) : null;
  }
  async listCases(workspaceId, { serviceId, outcome, from, to, limit = 25, cursor = '', activePolicyVersion } = {}) {
    const partition = workspacePartition(workspaceId);
    const prefix = indexPrefix(serviceId || '*', outcome || '*');
    const dateLower = to ? `${prefix}${reverseDate(to)}` : prefix;
    const dateUpper = from ? `${prefix}${reverseDate(from)}~` : `${prefix}~`;
    const lower = cursor && cursor.startsWith(prefix) && cursor > dateLower ? cursor : dateLower;
    const rows = this.table.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${partition} and RowKey gt ${lower} and RowKey lt ${dateUpper}` } });
    const cases = [];
    let nextCursor = null;
    let lastScannedKey = null;
    let scanned = 0;
    for await (const index of rows) {
      if (++scanned > 1000) { nextCursor = lastScannedKey; break; }
      const row = await this.row(workspaceId, index.caseId);
      if (!row || !caseIsReadable({ expires_at: row.expiresAt }) || (activePolicyVersion != null && row.policyVersion < activePolicyVersion)
        || (serviceId && row.serviceId !== serviceId) || (outcome && row.outcome !== outcome)
        || (from && row.acceptedAt < from) || (to && row.acceptedAt > to)) {
        lastScannedKey = index.rowKey;
        continue;
      }
      if (cases.length >= Math.min(Math.max(limit, 1), 100)) { nextCursor = lastScannedKey; break; }
      cases.push(metadata(row));
      lastScannedKey = index.rowKey;
    }
    return { cases, next_cursor: nextCursor };
  }
  async deleteCaseRow(row) {
    await this.blob(row.partitionKey, row.caseId).deleteIfExists();
    const remove = async (partitionKey, rowKey) => this.table.deleteEntity(partitionKey, rowKey)
      .catch((error) => { if (!isMissing(error)) throw error; });
    await Promise.all(indexKeys(row).map((rowKey) => remove(row.partitionKey, rowKey)));
    await Promise.all(JSON.parse(row.attemptIdsJson || '[]')
      .map((transactionId) => remove(row.partitionKey, transactionIndexKey(transactionId))));
    if (row.logicalKeyHash) await remove(row.partitionKey, `idem-${row.logicalKeyHash}`);
    await remove(row.partitionKey, row.rowKey);
    try { await this.table.deleteEntity('pending', `${row.acceptedAt}-${row.caseId}`); }
    catch (error) { if (!isMissing(error)) throw error; }
    // Keep the expiry marker until all other deletion steps succeed, so purge can retry safely.
    await remove('expiry', `${row.expiresAt}-${row.caseId}`);
  }
  async agedPending(at = new Date(Date.now() - 2 * 60 * 60 * 1000), limit = 100) {
    const cutoff = `${new Date(at).toISOString()}~`;
    const rows = this.table.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${'pending'} and RowKey lt ${cutoff}` } });
    let aged = 0;
    let scanned = 0;
    for await (const index of rows) {
      if (++scanned > limit) break;
      let row;
      try { row = await this.table.getEntity(index.ownerPartition, `case-${index.caseId}`); }
      catch (error) { if (!isMissing(error)) throw error; }
      if (row?.state === 'pending' && Date.parse(row.acceptedAt) <= new Date(at).getTime()) aged++;
      else if (!row || row.state !== 'pending') await this.table.deleteEntity('pending', index.rowKey)
        .catch((error) => { if (!isMissing(error)) throw error; });
    }
    return aged;
  }
  async purgeExpired(at = new Date(), limit = 100) {
    const cutoff = `${new Date(at).toISOString()}~`;
    const rows = this.table.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${'expiry'} and RowKey lt ${cutoff}` } });
    let removed = 0;
    for await (const index of rows) {
      if (removed >= limit) break;
      let row;
      try { row = await this.table.getEntity(index.ownerPartition, `case-${index.caseId}`); }
      catch (error) { if (!isMissing(error)) throw error; }
      if (row && Date.parse(row.expiresAt) <= new Date(at).getTime()) await this.deleteCaseRow(row);
      else if (!row) {
        await this.table.deleteEntity('expiry', index.rowKey).catch((error) => { if (!isMissing(error)) throw error; });
        if (index.acceptedAt) await this.table.deleteEntity('pending', `${index.acceptedAt}-${index.caseId}`)
          .catch((error) => { if (!isMissing(error)) throw error; });
      }
      removed++;
    }
    return removed;
  }
  async retireWorkspaceCases(workspaceId, beforeVersion, { cursor = '', limit = 10_000 } = {}) {
    const partition = workspacePartition(workspaceId);
    const lower = cursor && cursor.startsWith('case-') ? cursor : 'case-';
    const rows = this.table.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${partition} and RowKey gt ${lower} and RowKey lt ${'casf-'}` } });
    const batch = [];
    let lastCursor = '';
    let hasMore = false;
    for await (const row of rows) {
      if (batch.length >= limit) { hasMore = true; break; }
      batch.push(row);
      lastCursor = row.rowKey;
    }
    for (let offset = 0; offset < batch.length; offset += 32) {
      await Promise.all(batch.slice(offset, offset + 32)
        .filter((row) => Number(row.policyVersion || 0) < beforeVersion)
        .map((row) => this.deleteCaseRow(row)));
    }
    return hasMore ? { done: false, cursor: lastCursor } : { done: true, cursor: '' };
  }
  async scheduleRetirement(workspaceId, beforeVersion) {
    if (!this.queue) throw new Error('case_manager_reconcile_unavailable');
    const message = { version: 1, kind: 'retire', workspaceId, beforeVersion, cursor: '' };
    await this.queue.sendMessage(Buffer.from(JSON.stringify(message)).toString('base64'), { messageTimeToLive: 7 * 24 * 60 * 60 });
  }
  async prepareRetirement(workspaceId, beforeVersion) {
    const task = { partitionKey: 'retirement', rowKey: `due-${new Date().toISOString()}-${randomUUID()}`,
      workspaceId, beforeVersion, cursor: '', createdAt: new Date().toISOString() };
    await this.table.createEntity(task);
    return task;
  }
  async pendingRetirements(limit = 8, at = new Date()) {
    const upper = `due-${new Date(at).toISOString()}~`;
    const rows = this.table.listEntities({ queryOptions: {
      filter: odata`PartitionKey eq ${'retirement'} and RowKey gt ${'due-'} and RowKey lt ${upper}`
    } });
    const tasks = [];
    for await (const task of rows) {
      tasks.push(task);
      if (tasks.length >= limit) break;
    }
    return tasks;
  }
  async advanceRetirementTask(task, { done, cursor = '' }, { delayMs = 120_000 } = {}) {
    if (done) {
      await this.table.deleteEntity('retirement', task.rowKey).catch((error) => { if (!isMissing(error)) throw error; });
      return;
    }
    const next = { partitionKey: 'retirement', rowKey: `due-${new Date(Date.now() + delayMs).toISOString()}-${randomUUID()}`,
      workspaceId: task.workspaceId, beforeVersion: task.beforeVersion, cursor,
      createdAt: task.createdAt };
    await this.table.submitTransaction([['create', next], ['delete', { partitionKey: 'retirement', rowKey: task.rowKey }]]);
  }
}

export function createCaseManagerStore() {
  if (process.env.CASE_MANAGER_ENABLED !== 'true') return null;
  return process.env.NODE_ENV === 'test' ? new MemoryCaseManagerStore() : new AzureCaseManagerStore();
}
