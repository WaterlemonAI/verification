import { createAdverseMediaIncidentReport } from './adverse-media-incident-final.mjs';

export const INCIDENT_SERVICE_ID = 'adverse-media-incident-screening';
export const INCIDENT_PUBLIC_PATH = '/service/adverse_media_incident_screening';

export function incidentQueueReceipt(row) {
  return { screening_id: row.screeningId, status: 'queued',
    status_url: `${INCIDENT_PUBLIC_PATH}/jobs/${row.screeningId}` };
}

export async function processIncidentReportJob(job, {
  store, reportStore, jsonStore, usageStore, fetchImpl = fetch,
  archiveSearch, archivePage, onAudit = null,
  createReport = createAdverseMediaIncidentReport
}) {
  if (!job || job.incident_report_v1 !== true
    || !/^[0-9a-f-]{36}$/i.test(job.screening_id || '')
    || !/^[0-9a-f-]{36}$/i.test(job.report_id || '')
    || !/^[a-f0-9]{16}$/i.test(job.workspace_id || '')
    || job.owner_id !== `workspace-${job.workspace_id}`
    || typeof job.billing_log_key !== 'string' || !job.billing_log_key)
    throw new Error('invalid_incident_job');
  const ownerId = job.owner_id;
  const screeningId = job.screening_id;
  const workspaceId = job.workspace_id;
  const saved = await jsonStore.get({ ownerId, screeningId });
  if (saved?.response) {
    await usageStore.settleAsyncResult(workspaceId, job.billing_log_key, { successful: true });
    await reportStore.saveDeepResearchState({ ownerId, screeningId,
      state: { stage: 'completed', report_id: job.report_id } });
    return;
  }
  const prior = await reportStore.getDeepResearchState({ ownerId, screeningId });
  if (prior) {
    if (prior.stage === 'processing') {
      await usageStore.settleAsyncResult(workspaceId, job.billing_log_key,
        { successful: false, reason: 'incident_processing_interrupted' });
      await reportStore.saveDeepResearchState({ ownerId, screeningId,
        state: { stage: 'failed', reason: 'processing_interrupted' } });
    }
    if (prior.stage === 'failed') await usageStore.settleAsyncResult(workspaceId, job.billing_log_key,
      { successful: false, reason: 'incident_report_unavailable' });
    return;
  }
  await reportStore.saveDeepResearchState({ ownerId, screeningId,
    state: { stage: 'processing', started_at: new Date().toISOString() } });
  let resultSaved = false;
  try {
    const result = await createReport(job.input_payload, {
      screeningDependencies: {
        braveApiKey: await store.getMasterKey('adverse-media'),
        eventRegistryApiKey: await store.getMasterKey('adverse-media-article-extraction')
          || process.env.EVENT_REGISTRY_API_KEY || '',
        jevApiKey: await store.getMasterKey('adverse-media-jev'),
        fetchImpl, archiveSearch, archivePage
      },
      summaryApiKey: await store.getMasterKey('adverse-media-summary')
        || process.env.MISTRAL_API_KEY || '',
      signing: null, allowUnsignedPdf: true, fetchImpl
    });
    const response = { ...result.response, report: {
      ...result.response.report,
      report_id: job.report_id,
      pdf_url: `${INCIDENT_PUBLIC_PATH}/reports/${job.report_id}.pdf`
    } };
    delete response.report.pdf_base64;
    await reportStore.save({ ownerId, reportId: job.report_id, bytes: result.pdf,
      metadata: { report_id: job.report_id, transaction_id: job.transaction_id,
        generated_at: new Date().toISOString(), sha256: result.response.report.sha256,
        filename: result.response.report.filename, report_type: INCIDENT_SERVICE_ID },
      publicReport: false });
    await jsonStore.save({ ownerId, screeningId, transactionId: job.transaction_id,
      input: job.input_payload, response });
    resultSaved = true;
    await usageStore.settleAsyncResult(workspaceId, job.billing_log_key, { successful: true });
    await reportStore.saveDeepResearchState({ ownerId, screeningId,
      state: { stage: 'completed', report_id: job.report_id } });
    if (onAudit) {
      try { await onAudit({ transaction_id: job.transaction_id,
        timings_ms: result.audit.timings_ms, usage: result.audit.usage, costs: result.audit.costs }); }
      catch { console.warn('incident_report_audit_failed'); }
    }
  } catch (error) {
    if (resultSaved) throw error;
    await usageStore.settleAsyncResult(workspaceId, job.billing_log_key,
      { successful: false, reason: 'incident_report_unavailable' });
    await reportStore.saveDeepResearchState({ ownerId, screeningId,
      state: { stage: 'failed', reason: 'report_unavailable' } });
    if (onAudit) {
      try { await onAudit({ transaction_id: job.transaction_id, error: 'report_unavailable' }); }
      catch { console.warn('incident_report_audit_failed'); }
    }
    throw error;
  }
}
