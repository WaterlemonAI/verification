import { caseOutcome } from './case-manager-outcomes.mjs';
import { presentBsaResult } from './bsa-store.mjs';
import { DOCUMENT_OCR_BY_ID } from './document-ocr-contracts.mjs';
import { documentOcrArtifactUrl } from './document-ocr-artifact-url.mjs';

export async function reconcileCaseMessage(message, { caseStore, usageStore, documentOcrStore, getBsaResult }) {
  if (message?.version !== 1 || !message.workspaceId || !message.caseId || !message.sourceId) return 'invalid';
  const policy = await usageStore.casePolicy(message.workspaceId);
  if (!policy.enabled) return 'retired';
  const record = await caseStore.getCase(message.workspaceId, message.caseId, { activePolicyVersion: policy.visible_from_version });
  if (!record) return 'retired';
  if (record.state === 'complete') return 'captured';
  if (record.state === 'incomplete') return 'incomplete';
  let source;
  if (message.serviceId === 'bank-statement-analysis') {
    source = await getBsaResult(message.sourceId, message.originalOwner);
  } else if (message.serviceId?.endsWith('-ocr') || message.serviceId === 'moa-analysis') {
    source = await documentOcrStore.getResult(message.workspaceId, message.sourceId);
  } else return 'invalid';
  if (!source?.job) return 'pending';
  if (!source.result && source.job.status === 'failed' && message.serviceId !== 'bank-statement-analysis') {
    const body = { job: source.job };
    const mapping = caseOutcome(message.serviceId, body, { httpStatus: 422 });
    await caseStore.captureFinal(message.workspaceId, message.caseId, { response: body,
      contentType: 'application/json', httpStatus: 422, outcome: mapping.outcome,
      reasonCodes: mapping.reasonCodes, originalArtifactOwner: message.originalOwner, sourceId: message.sourceId });
    return 'captured';
  }
  if (!source.result) return 'pending';
  let response = message.serviceId === 'bank-statement-analysis'
    ? presentBsaResult(source, message.sourceId) : { ...source.result };
  if (message.serviceId !== 'bank-statement-analysis' && Array.isArray(response.artifacts)) {
    const definition = DOCUMENT_OCR_BY_ID.get(message.serviceId);
    response.artifacts = response.artifacts.map((item) => ({ ...item,
      download_url: documentOcrArtifactUrl(definition, message.workspaceId, message.sourceId, item.name) }));
  }
  const mapping = caseOutcome(message.serviceId, response, { httpStatus: 200 });
  await caseStore.captureFinal(message.workspaceId, message.caseId, { response,
    contentType: 'application/json', httpStatus: 200, outcome: mapping.outcome,
    reasonCodes: mapping.reasonCodes, originalArtifactOwner: message.originalOwner,
    sourceId: message.sourceId,
    artifactRefs: Array.isArray(response.artifacts) ? response.artifacts.map((item) => ({
      type: message.serviceId, name: item.name || item.filename
    })).filter((item) => item.name) : [] });
  return 'captured';
}
