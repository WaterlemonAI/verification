import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { QueueClient } from '@azure/storage-queue';
import { odata } from '@azure/data-tables';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryCustomerUsageStore, validateCasePolicy } from '../lib/customer-usage.mjs';
import { AzureCaseManagerStore } from '../lib/case-manager-store.mjs';
import { AzureLoginOtpStore } from '../lib/login-otp.mjs';
import { AzureAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';
import { ContainerAppsManagedIdentityCredential } from '../lib/azure-managed-identity.mjs';
import { createPortalAccount, createPortalSession, PORTAL_COOKIE } from '../lib/portal-auth.mjs';
import { createAdminAccount } from '../lib/admin-auth.mjs';
import { drainCaseReconciliation } from './reconcile-cases.mjs';
import { recoverCaseRetirements } from '../lib/case-manager-retirement.mjs';
import { createAppServer } from '../server.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quantile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] || 0);
};
const ownAccount = 'stai7uaecasesuaen001';

async function retireAll(store, workspaceId) {
  let cursor = '';
  let passes = 0;
  do {
    const result = await store.retireWorkspaceCases(workspaceId, 2, { cursor, limit: 100 });
    cursor = result.done ? '' : result.cursor;
    if (++passes > 100) throw new Error('qa_cleanup_limit');
  } while (cursor);
}

export async function cleanupLegacySyntheticCases() {
  if (process.env.CASE_MANAGER_QA_MODE !== 'true' ||
      !process.env.CASE_MANAGER_TABLE_URL?.startsWith(`https://${ownAccount}.table.`)) {
    throw new Error('case_manager_qa_isolation_required');
  }
  const bounds = [Date.parse('2026-10-29T22:00:00Z'), Date.parse('2026-10-30T02:00:00Z')];
  const targets = [
    { tableName: 'CaseManagerMetadata', containerName: 'case-manager-private',
      services: new Set(['qa-synthetic-check']) },
    { tableName: 'CaseManagerQaMetadata', containerName: 'case-manager-qa-private',
      services: new Set(['qa-synthetic-check', 'passport-icao-ocr', 'bank-statement-analysis']) }
  ];
  const plans = [];
  for (const target of targets) {
    const store = new AzureCaseManagerStore(target);
    const rows = [];
    for await (const row of store.table.listEntities({ queryOptions: {
      filter: odata`RowKey gt ${'case-'} and RowKey lt ${'casf-'}`
    } })) {
      const acceptedAt = Date.parse(row.acceptedAt);
      if (!target.services.has(row.serviceId) || !Number.isFinite(acceptedAt) ||
          acceptedAt < bounds[0] || acceptedAt > bounds[1] ||
          !/^[0-9a-f-]{36}$/.test(row.caseId || '') || rows.length >= 1000) {
        throw new Error('qa_cleanup_unexpected_case');
      }
      rows.push(row);
    }
    plans.push({ store, tableName: target.tableName, rows });
  }
  const result = {};
  for (const plan of plans) {
    for (let offset = 0; offset < plan.rows.length; offset += 16) {
      await Promise.all(plan.rows.slice(offset, offset + 16).map((row) => plan.store.deleteCaseRow(row)));
    }
    let remaining = 0;
    for await (const _row of plan.store.table.listEntities({ queryOptions: {
      filter: odata`RowKey gt ${'case-'} and RowKey lt ${'casf-'}`
    } })) remaining++;
    if (remaining) throw new Error('qa_cleanup_incomplete');
    result[plan.tableName] = plan.rows.length;
  }
  console.info('case_manager_qa_cleanup_verified', JSON.stringify(result));
  return result;
}

async function countCases(store, workspaceId) {
  let count = 0;
  let cursor = '';
  for (let page = 0; page < 100; page++) {
    const result = await store.listCases(workspaceId, { cursor, limit: 100 });
    count += result.cases.length;
    if (!result.next_cursor) return count;
    cursor = result.next_cursor;
  }
  throw new Error('qa_list_limit');
}

async function runPhase(url, apiKey, { seconds, qpm, label }) {
  const total = Math.ceil(seconds * qpm / 60);
  const interval = 60_000 / qpm;
  const start = performance.now();
  const calls = Array.from({ length: total }, async (_, index) => {
    const wait = start + index * interval - performance.now();
    if (wait > 0) await sleep(wait);
    const began = performance.now();
    try {
      const response = await fetch(url, { method: 'POST', headers: {
        authorization: `Bearer ${apiKey}`, 'content-type': 'application/json'
      }, body: '{}' });
      const body = await response.json();
      return { ms: performance.now() - began, ok: response.status === 200 && body?.marker === 'synthetic' };
    } catch { return { ms: performance.now() - began, ok: false }; }
  });
  const results = await Promise.all(calls);
  const elapsed = performance.now() - start;
  return { label, requests: total, failures: results.filter((result) => !result.ok).length,
    elapsed_ms: Math.round(elapsed), actual_qpm: Math.round(total * 60_000 / elapsed),
    p95_ms: quantile(results.map((result) => result.ms), 0.95),
    p99_ms: quantile(results.map((result) => result.ms), 0.99) };
}

async function runAsyncPhase({ usageStore, workspaceId, seconds, qpm }) {
  const credential = new ContainerAppsManagedIdentityCredential();
  const base = process.env.CASE_MANAGER_QUEUE_URL.replace(/\/$/, '');
  const client = new QueueClient(`${base}/case-manager-qa-load`, credential);
  const deadLetters = new QueueClient(`${base}/case-manager-qa-dead-letter`, credential);
  if ((await client.getProperties()).approximateMessagesCount) throw new Error('qa_load_queue_not_empty');
  const deadLettersBefore = (await deadLetters.getProperties()).approximateMessagesCount || 0;
  const ages = [];
  const queue = {
    sendMessage: (...args) => client.sendMessage(...args),
    deleteMessage: (...args) => client.deleteMessage(...args),
    receiveMessages: async (...args) => {
      const batch = await client.receiveMessages(...args);
      for (const item of batch.receivedMessageItems || []) {
        const inserted = new Date(item.insertedOn).getTime();
        if (Number.isFinite(inserted)) ages.push(Math.max(0, Date.now() - inserted));
      }
      return batch;
    }
  };
  const caseStore = new AzureCaseManagerStore({ queue });
  const total = Math.ceil(seconds * qpm / 60);
  const interval = 60_000 / qpm;
  const started = performance.now();
  let produced = 0;
  let producerDone = false;
  let captured = 0;
  let errors = 0;
  let batches = 0;
  let producerElapsed = 0;
  const producer = Promise.all(Array.from({ length: total }, async (_, index) => {
    const wait = started + index * interval - performance.now();
    if (wait > 0) await sleep(wait);
    const serviceId = index % 2 ? 'bank-statement-analysis' : 'passport-icao-ocr';
    const intent = await caseStore.createIntent({ workspaceId, serviceId, transactionId: randomUUID(),
      acceptedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
    await caseStore.linkAsync(workspaceId, intent.id, { sourceId: `${index % 2 ? 'bsa' : 'ocr'}_${randomUUID()}`,
      originalOwner: workspaceId });
    produced++;
  })).finally(() => { producerDone = true; producerElapsed = performance.now() - started; });
  const consumer = (async () => {
    const deadline = Date.now() + 12 * 60_000;
    while ((!producerDone || captured < produced) && Date.now() < deadline) {
      const counts = await drainCaseReconciliation({ queue, deadLetterQueue: deadLetters, caseStore,
        usageStore, documentOcrStore: { getResult: async () => ({ job: { status: 'completed' },
          result: { status: 'completed', data: { marker: 'synthetic' }, artifacts: [] } }) },
        getBsaResultImpl: async () => ({ job: { status: 'completed' },
          result: { status: 'partial', decisionEligible: false, artifacts: [] } }),
        maxMessages: 512, maxBatches: 16, maxRunMs: 60_000 });
      captured += counts.captured;
      errors += counts.errors;
      batches += counts.batches_received;
      if (!counts.messages_processed) await sleep(500);
    }
  })();
  await Promise.all([producer, consumer]);
  let queueRemaining = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    queueRemaining = (await client.getProperties()).approximateMessagesCount || 0;
    if (!queueRemaining) break;
    await sleep(1000);
  }
  const deadLettersAfter = (await deadLetters.getProperties()).approximateMessagesCount || 0;
  assert.equal(produced, total);
  assert.equal(captured, total);
  assert.equal(errors, 0);
  assert.equal(queueRemaining, 0);
  assert.equal(deadLettersAfter, deadLettersBefore);
  return { requests: total, offered_qpm: Math.round(total * 60_000 / producerElapsed),
    completed_qpm: Math.round(total * 60_000 / (performance.now() - started)),
    captured, errors, batches, queue_remaining: queueRemaining,
    dead_letters_added: deadLettersAfter - deadLettersBefore,
    queue_age_p95_ms: quantile(ages, 0.95), queue_age_p99_ms: quantile(ages, 0.99),
    queue_age_max_ms: Math.round(Math.max(0, ...ages)) };
}

export async function runQa({ load = false, asyncQueue = false, seconds = 120, qpm = 180 } = {}) {
  if (process.env.CASE_MANAGER_QA_MODE !== 'true' ||
      ![process.env.CASE_MANAGER_BLOB_URL, process.env.CASE_MANAGER_TABLE_URL, process.env.CASE_MANAGER_QUEUE_URL]
        .every((url) => url?.startsWith(`https://${ownAccount}.`))) {
    throw new Error('case_manager_qa_isolation_required');
  }
  if ((load || asyncQueue) && (!(Number.isInteger(seconds) && seconds >= 30 && seconds <= 300) ||
      !(Number.isInteger(qpm) && qpm >= 1 && qpm <= 180))) throw new Error('case_manager_qa_load_bounds');

  const store = new EnvironmentStore();
  const usageStore = new MemoryCustomerUsageStore();
  const caseStore = new AzureCaseManagerStore();
  const otpStore = new AzureLoginOtpStore({ table: caseStore.table });
  const sentCodes = [];
  const mailer = { configured: true, sendLoginCode: async (message) => { sentCodes.push(message); } };
  const reportStore = new AzureAdverseMediaReportStore({ blobServiceUrl: process.env.CASE_MANAGER_BLOB_URL,
    tableServiceUrl: process.env.CASE_MANAGER_TABLE_URL,
    containerName: 'case-manager-qa-artifacts', tableName: 'CaseManagerQaArtifacts' });
  const purgeFixtureWorkspaceId = `qa-${randomUUID()}`;
  const retirementWorkspaceId = `qa-${randomUUID()}`;
  const otherWorkspaceId = `qa-${randomUUID()}`;
  const signingKey = randomUUID();
  const payload = { marker: 'synthetic', status: 'partial', items: Array.from({ length: 256 }, (_, i) =>
    ({ id: i, text: 'synthetic-response-pad'.repeat(40) })) };
  let supplierCalls = 0;
  let server;
  let artifact;
  await store.upsertIntegration({ id: 'qa-synthetic-check', name: 'Synthetic Check',
    publicPath: '/service/qa_synthetic_check', method: 'POST', upstreamUrl: 'https://supplier.invalid/check',
    authType: 'none', acceptedContentTypes: ['application/json'], enabled: true }, '');
  const client = await store.createClient('Disposable QA Workspace');
  assert.equal(client.client.workspaceId !== otherWorkspaceId, true);
  await usageStore.updateCasePolicy(client.client.workspaceId,
    validateCasePolicy({ version: 0, enabled: true, ttl_days: 1 }));
  await store.setPortalSessionKey(signingKey);
  await store.setAdminSessionKey(signingKey);
  await store.setAdminAccount(createAdminAccount('qa-admin@example.invalid', 'SyntheticOnly!234'));
  const account = createPortalAccount('qa@example.invalid', 'SyntheticOnly!234',
    { id: client.client.workspaceId, name: 'Disposable QA Workspace' });
  const other = createPortalAccount('other@example.invalid', 'SyntheticOnly!234',
    { id: otherWorkspaceId, name: 'Other QA Workspace' });
  await store.setPortalUser(account);
  await store.setPortalUser(other);
  const cookie = (user) => `${PORTAL_COOKIE}=${encodeURIComponent(createPortalSession(user, signingKey).token)}`;

  try {
    server = createAppServer({ store, usageStore, caseStore, reportStore, otpStore, mailer, startWorker: false,
      deepResearchQueue: null, formsQueue: null,
      fetchImpl: async () => { supplierCalls++; return new Response(JSON.stringify(payload), {
        status: 200, headers: { 'content-type': 'application/json' }
      }); } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = `${base}/service/qa_synthetic_check`;
    process.env.CASE_MANAGER_ENABLED = 'true';
    for (const [kind, email] of [['portal', 'qa@example.invalid'], ['admin', 'qa-admin@example.invalid']]) {
      const path = kind === 'portal' ? '/portal/api/auth' : '/admin/api/auth';
      const login = await fetch(`${base}${path}/login`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'SyntheticOnly!234' }) });
      assert.equal(login.status, 202);
      assert.equal(login.headers.get('set-cookie'), null);
      const challengeId = (await login.json()).challenge_id;
      assert.equal(sentCodes.at(-1)?.to, email);
      const verification = { email, challenge_id: challengeId, code: sentCodes.at(-1).code };
      const verified = await fetch(`${base}${path}/verify-code`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(verification) });
      assert.equal(verified.status, 200);
      assert.ok(verified.headers.get('set-cookie'));
      assert.equal((await fetch(`${base}${path}/verify-code`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(verification) })).status, 401);
    }
    const response = await fetch(url, { method: 'POST', headers: {
      authorization: `Bearer ${client.apiKey}`, 'content-type': 'application/json'
    }, body: '{}' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), payload);
    const listed = await caseStore.listCases(client.client.workspaceId);
    assert.equal(listed.cases.length, 1);
    const caseId = listed.cases[0].id;
    const casePath = `${base}/portal/api/cases/${caseId}`;
    assert.equal((await fetch(casePath)).status, 401);
    assert.equal((await fetch(casePath, { headers: { authorization: `Bearer ${client.apiKey}` } })).status, 401);
    assert.equal((await fetch(casePath, { headers: { cookie: cookie(other) } })).status, 404);
    const detail = await fetch(casePath, { headers: { cookie: cookie(account) } });
    assert.equal(detail.status, 200);
    assert.deepEqual((await detail.json()).response, payload);
    assert.equal((await caseStore.getCase(otherWorkspaceId, caseId)), null);

    const ownerId = `qa-artifact-${randomUUID()}`;
    const reportId = randomUUID();
    const pdf = Buffer.from('%PDF-1.4\n% synthetic Case Manager QA artifact\n');
    const ownerPartition = createHash('sha256').update(ownerId).digest('hex');
    artifact = { reportId, ownerPartition, blobName: `${ownerPartition}/${reportId}.pdf` };
    await reportStore.save({ ownerId, reportId, bytes: pdf, publicReport: false,
      metadata: { report_id: reportId, transaction_id: randomUUID(), generated_at: new Date().toISOString(),
        sha256: createHash('sha256').update(pdf).digest('hex'), filename: 'synthetic.pdf', report_type: 'adverse_media' } });
    const artifactCase = await caseStore.createIntent({ workspaceId: client.client.workspaceId,
      serviceId: 'adverse-media', transactionId: randomUUID(), acceptedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
    await caseStore.captureFinal(client.client.workspaceId, artifactCase.id, { response: { marker: 'synthetic' },
      contentType: 'application/json', httpStatus: 200, outcome: 'unclassified',
      originalArtifactOwner: ownerId, artifactRefs: [{ type: 'adverse_media', report_id: reportId }] });
    const artifactPath = `${base}/portal/api/cases/${artifactCase.id}/artifacts/0`;
    assert.equal((await fetch(artifactPath)).status, 401);
    assert.equal((await fetch(artifactPath, { headers: { cookie: cookie(other) } })).status, 404);
    const downloaded = await fetch(artifactPath, { headers: { cookie: cookie(account) } });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), pdf);

    await usageStore.updateCasePolicy(retirementWorkspaceId,
      validateCasePolicy({ version: 0, enabled: true, ttl_days: 1 }));
    const retiring = await caseStore.createIntent({ workspaceId: retirementWorkspaceId,
      serviceId: 'qa-synthetic-check', transactionId: randomUUID(), acceptedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
    await caseStore.captureFinal(retirementWorkspaceId, retiring.id, { response: { marker: 'synthetic' },
      contentType: 'application/json', httpStatus: 200, outcome: 'unclassified' });
    const retiringRow = await caseStore.row(retirementWorkspaceId, retiring.id);
    await caseStore.prepareRetirement(retirementWorkspaceId, 2);
    await usageStore.updateCasePolicy(retirementWorkspaceId,
      validateCasePolicy({ version: 1, enabled: false, ttl_days: 1 }));
    const queueFailureStore = new AzureCaseManagerStore({ queue: {
      sendMessage: async () => { throw new Error('synthetic_queue_failure'); }
    } });
    await assert.rejects(queueFailureStore.scheduleRetirement(retirementWorkspaceId, 2), /synthetic_queue_failure/);
    const recovered = await recoverCaseRetirements({ usageStore, caseStore });
    assert.equal(recovered.completed, 1);
    assert.equal(await caseStore.row(retirementWorkspaceId, retiring.id), null);
    assert.equal(await caseStore.blob(retiringRow.partitionKey, retiring.id).exists(), false);
    assert.equal((await caseStore.pendingRetirements()).length, 0);

    const baseline = load ? await (async () => {
      process.env.CASE_MANAGER_ENABLED = 'false';
      return runPhase(url, client.apiKey, { seconds, qpm, label: 'capture_off' });
    })() : null;
    const beforeCount = load ? await countCases(caseStore, client.client.workspaceId) : 2;
    process.env.CASE_MANAGER_ENABLED = 'true';
    const captured = load ? await runPhase(url, client.apiKey, { seconds, qpm, label: 'capture_on' }) : null;
    const afterCount = load ? await countCases(caseStore, client.client.workspaceId) : 2;
    if (load) assert.equal(afterCount - beforeCount, captured.requests - captured.failures);
    const asyncResult = asyncQueue ? await runAsyncPhase({ usageStore, workspaceId: client.client.workspaceId,
      seconds, qpm }) : null;

    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    const expiring = await caseStore.createIntent({ workspaceId: purgeFixtureWorkspaceId, serviceId: 'qa-synthetic-check',
      transactionId: randomUUID(), acceptedAt: new Date().toISOString(),
      expiresAt: futureExpiry, policyVersion: 1 });
    await caseStore.captureFinal(purgeFixtureWorkspaceId, expiring.id, { response: payload,
      contentType: 'application/json', httpStatus: 200, outcome: 'unclassified' });
    assert.ok(await caseStore.getCase(purgeFixtureWorkspaceId, expiring.id));
    const removed = await caseStore.purgeExpired(new Date(Date.parse(futureExpiry) + 1000), 10);
    assert.ok(removed >= 1);
    assert.equal(await caseStore.row(purgeFixtureWorkspaceId, expiring.id), null);
    assert.equal((await caseStore.listCases(purgeFixtureWorkspaceId)).cases.some((item) => item.id === expiring.id), false);

    const result = { private_azure_store: true, authenticated_portal: true, workspace_isolation: true,
      azure_otp_challenges: true, portal_email_code: true, admin_email_code: true,
      api_key_history_denied: true, exact_response: true, physical_purge: true,
      azure_artifact_download: true,
      queue_failure_retirement: true,
      supplier_calls: supplierCalls, response_bytes: Buffer.byteLength(JSON.stringify(payload)),
      baseline, captured, captured_cases: afterCount - beforeCount,
      async_queue: asyncResult,
      p95_added_ms: load ? captured.p95_ms - baseline.p95_ms : null,
      p99_added_ms: load ? captured.p99_ms - baseline.p99_ms : null };
    console.info('case_manager_azure_qa_verified', JSON.stringify(result));
    return result;
  } finally {
    process.env.CASE_MANAGER_ENABLED = 'false';
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const [kind, email] of [['portal', 'qa@example.invalid'], ['admin', 'qa-admin@example.invalid']]) {
      const key = createHash('sha256').update(`${kind}:${email}`).digest('hex');
      await caseStore.table.deleteEntity('login-otp-v1', key).catch((error) => {
        if (error.statusCode !== 404) throw error;
      });
    }
    try {
      await retireAll(caseStore, client.client.workspaceId);
      await retireAll(caseStore, purgeFixtureWorkspaceId);
      await retireAll(caseStore, retirementWorkspaceId);
      assert.equal(await countCases(caseStore, client.client.workspaceId), 0);
      assert.equal(await countCases(caseStore, purgeFixtureWorkspaceId), 0);
      if (artifact) assert.ok(await reportStore.table.getEntity(artifact.ownerPartition, artifact.reportId));
    } finally {
      if (artifact) {
        await reportStore.container.getBlockBlobClient(artifact.blobName).deleteIfExists();
        await reportStore.table.deleteEntity(artifact.ownerPartition, artifact.reportId).catch(() => {});
      }
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    if (process.env.CASE_MANAGER_QA_CLEANUP === 'true') await cleanupLegacySyntheticCases();
    else await runQa({ load: process.env.CASE_MANAGER_QA_LOAD === 'true',
      asyncQueue: process.env.CASE_MANAGER_QA_ASYNC === 'true',
      seconds: Number(process.env.CASE_MANAGER_QA_SECONDS || 120),
      qpm: Number(process.env.CASE_MANAGER_QA_QPM || 180) });
  } catch (error) {
    const code = String(error?.code || error?.message || 'unknown');
    console.warn('case_manager_azure_qa_failed', /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : 'unknown');
    process.exitCode = 1;
  }
}
