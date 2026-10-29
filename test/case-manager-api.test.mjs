import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { MemoryCustomerUsageStore, validateCasePolicy } from '../lib/customer-usage.mjs';
import { MemoryCaseManagerStore } from '../lib/case-manager-store.mjs';
import { MemoryAdverseMediaReportStore } from '../lib/adverse-media-report-store.mjs';
import { createPortalAccount, createPortalSession, PORTAL_COOKIE } from '../lib/portal-auth.mjs';

process.env.NODE_ENV = 'test';
const { createAppServer } = await import('../server.mjs');

test('feature off touches no case store; feature on captures exact dynamic response once', async (t) => {
  const store = new EnvironmentStore();
  const usageStore = new MemoryCustomerUsageStore();
  await store.upsertIntegration({ id: 'synthetic-check', name: 'Synthetic Check', publicPath: '/service/synthetic_check',
    method: 'POST', upstreamUrl: 'https://supplier.test/check', authType: 'none',
    acceptedContentTypes: ['application/json'], enabled: true }, '');
  const issued = await store.createClient('Synthetic Workspace');
  const workspaceId = issued.client.workspaceId;
  const caseStore = new MemoryCaseManagerStore();
  let providerCalls = 0;
  const finalBody = { status: 'partial', nested: [{ name: '<script>alert(1)</script>', values: Array.from({ length: 500 }, (_, i) => i) }] };
  const server = createAppServer({ store, usageStore, caseStore, startWorker: false,
    deepResearchQueue: null, formsQueue: null,
    fetchImpl: async () => { providerCalls++; return new Response(JSON.stringify(finalBody), {
      status: 200, headers: { 'content-type': 'application/json' }
    }); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); delete process.env.CASE_MANAGER_ENABLED; });
  const url = `http://127.0.0.1:${server.address().port}/service/synthetic_check`;
  const call = () => fetch(url, { method: 'POST', headers: {
    authorization: `Bearer ${issued.apiKey}`, 'content-type': 'application/json'
  }, body: '{}' });
  const off = await call();
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), finalBody);
  assert.equal(caseStore.rows.size, 0);
  await usageStore.updateCasePolicy(workspaceId, validateCasePolicy({ version: 0, enabled: true, ttl_days: 45 }));
  process.env.CASE_MANAGER_ENABLED = 'true';
  const on = await call();
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), finalBody);
  assert.equal(providerCalls, 2);
  assert.equal(caseStore.rows.size, 1);
  const [row] = caseStore.rows.values();
  const found = await caseStore.getCase(workspaceId, row.caseId, { activePolicyVersion: 1 });
  assert.equal(found.outcome, 'unclassified');
  assert.deepEqual(found.payload.final_response, finalBody);
  assert.equal(found.final_http_status, 200);
  assert.equal((await caseStore.getCase('other-workspace', row.caseId)), null);
  const wrongMethod = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${issued.apiKey}` } });
  assert.equal(wrongMethod.status, 405);
  assert.equal(providerCalls, 2);
  assert.equal(caseStore.rows.size, 2);
  const rejected = [...caseStore.rows.values()].find((item) => item.finalHttpStatus === 405);
  assert.equal(rejected.outcome, 'not_run');
});

test('portal cases and PDFs require the signed workspace; expired and retired cases return 404', async (t) => {
  process.env.CASE_MANAGER_ENABLED = 'true';
  t.after(() => { delete process.env.CASE_MANAGER_ENABLED; });
  const store = new EnvironmentStore();
  const usageStore = new MemoryCustomerUsageStore();
  const caseStore = new MemoryCaseManagerStore();
  const reportStore = new MemoryAdverseMediaReportStore();
  const signingKey = 'synthetic-portal-signing-key';
  await store.setPortalSessionKey(signingKey);
  const a = createPortalAccount('a@example.test', 'StrongPass!234', { id: 'workspace-a', name: 'A' });
  const b = createPortalAccount('b@example.test', 'StrongPass!234', { id: 'workspace-b', name: 'B' });
  const colleague = createPortalAccount('colleague@example.test', 'StrongPass!234', { id: 'workspace-a', name: 'A' });
  await store.setPortalUser(a);
  await store.setPortalUser(b);
  await store.setPortalUser(colleague);
  await usageStore.updateCasePolicy('workspace-a', validateCasePolicy({ version: 0, enabled: true, ttl_days: 1 }));
  await usageStore.updateCasePolicy('workspace-b', validateCasePolicy({ version: 0, enabled: true, ttl_days: 1 }));
  const transactionId = '33333333-3333-4333-8333-333333333333';
  const intent = await caseStore.createIntent({ workspaceId: 'workspace-a', serviceId: 'adverse-media',
    transactionId, acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyVersion: 1 });
  const reportId = '11111111-1111-4111-8111-111111111111';
  await reportStore.save({ ownerId: 'original-key-owner', reportId, bytes: Buffer.from('%PDF-synthetic'),
    metadata: { report_id: reportId, report_type: 'adverse_media' } });
  await caseStore.captureFinal('workspace-a', intent.id, { response: { status: 'completed' },
    contentType: 'application/json', httpStatus: 200, outcome: 'review_required',
    originalArtifactOwner: 'original-key-owner', artifactRefs: [{ type: 'adverse_media', report_id: reportId }] });
  const server = createAppServer({ store, usageStore, caseStore, reportStore, startWorker: false,
    deepResearchQueue: null, formsQueue: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/portal/api/cases`;
  const cookie = (account) => `${PORTAL_COOKIE}=${encodeURIComponent(createPortalSession(account, signingKey).token)}`;
  const path = `${base}/${intent.id}`;
  assert.equal((await fetch(path)).status, 401);
  assert.equal((await fetch(path, { headers: { authorization: 'Bearer synthetic-api-key' } })).status, 401);
  assert.equal((await fetch(path, { headers: { cookie: cookie(b) } })).status, 404);
  assert.equal((await fetch(path, { headers: { cookie: cookie(colleague) } })).status, 200);
  const detail = await fetch(path, { headers: { cookie: cookie(a) } });
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get('cache-control'), 'private, no-store');
  const detailJson = await detail.json();
  assert.equal(detailJson.response.status, 'completed');
  assert.equal(JSON.stringify(detailJson).includes('original-key-owner'), false);
  const lookup = await fetch(`${base}?transaction_id=${transactionId}`, { headers: { cookie: cookie(a) } });
  assert.equal(lookup.status, 200);
  assert.deepEqual((await lookup.json()).cases.map((item) => item.id), [intent.id]);
  const unfiltered = await fetch(base, { headers: { cookie: cookie(a) } });
  assert.equal(unfiltered.status, 200);
  assert.deepEqual((await unfiltered.json()).cases.map((item) => item.id), [intent.id]);
  const otherWorkspaceLookup = await fetch(`${base}?transaction_id=${transactionId}`, { headers: { cookie: cookie(b) } });
  assert.deepEqual((await otherWorkspaceLookup.json()).cases, []);
  assert.equal((await fetch(`${base}?transaction_id=invalid`, { headers: { cookie: cookie(a) } })).status, 400);
  const pdf = await fetch(`${path}/artifacts/0`, { headers: { cookie: cookie(a) } });
  assert.equal(pdf.status, 200);
  assert.equal(await pdf.text(), '%PDF-synthetic');
  assert.equal((await fetch(`${path}/artifacts/0`, { headers: { cookie: cookie(b) } })).status, 404);
  caseStore.rows.get(intent.id).expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal((await fetch(path, { headers: { cookie: cookie(a) } })).status, 404);
  const expiredLookup = await fetch(`${base}?transaction_id=${transactionId}`, { headers: { cookie: cookie(a) } });
  assert.deepEqual((await expiredLookup.json()).cases, []);
  caseStore.rows.get(intent.id).expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  await usageStore.updateCasePolicy('workspace-a', validateCasePolicy({ version: 1, enabled: false, ttl_days: 1 }));
  assert.equal((await fetch(path, { headers: { cookie: cookie(a) } })).status, 404);
});
