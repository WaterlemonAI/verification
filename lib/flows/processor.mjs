import { randomUUID } from 'node:crypto';
import { executeCheck, unavailableCheck } from './checks.mjs';
import { callbackEvent } from './callback.mjs';
import { sha256 } from './crypto.mjs';
import { triangulateCase } from './triangulation.mjs';
import { discoverSupplierSubjects } from './templates/supplier-onboarding-v1/subjects.mjs';
import { reviewSupplierCase } from './templates/supplier-onboarding-v1/review.mjs';
import { diagnosticCaseAllowed } from './diagnostic.mjs';
import { CHECK_CATALOG } from './checks-catalog.mjs';

const amlInput = (name, type) => ({ name, type, alias: [], country: 'AE', gender: '', dob: '', identifier: [],
  search_type: ['pep', 'sanction', 'watchlist'],
  fields_weightage: ['name', 'alias', 'country', 'dob', 'address', 'gender', 'identifier']
    .map((field) => ({ field, weightage: field === 'name' ? 1 : 0 })), fuzziness: 0.8 });

const ocrService = {
  trade_licence: 'uae-trade-license-ocr', formation_document: 'moa-analysis',
  utility_bill: 'uae-utility-bill-ocr', power_of_attorney: 'uae-poa-ocr',
  identity_document: 'emirates-id-ocr', tradeLicenceFile: 'uae-trade-license-ocr',
  moaFile: 'moa-analysis', aoaFile: 'articles-of-association-ocr', poaFile: 'uae-poa-ocr',
  identityFile: 'emirates-id-ocr'
};

const supplierFlow = (item) => item.flow_id === 'supplier-onboarding-v1';
function serviceForDocument(item, doc) {
  if (doc.type === 'identityFile' && item.draft?.identityType === 'passport') return 'passport-icao-ocr';
  if (doc.type === 'locationEvidenceFile' && item.draft?.locationEvidenceType === 'utility') return 'uae-utility-bill-ocr';
  return ocrService[doc.type];
}
const isEjariDocument = (item, doc) => doc.type === 'ejari'
  || doc.type === 'locationEvidenceFile' && item.draft?.locationEvidenceType === 'ejari';
const bankDocument = (doc) => ['bank_letter', 'bankConfirmationFile'].includes(doc.type);
const supplementalDocument = (item, doc) => ['vatFile', 'brFile', 'incorporationFile'].includes(doc.type)
  || doc.type === 'locationEvidenceFile' && !['ejari', 'utility'].includes(item.draft?.locationEvidenceType);

async function processDocuments(job, { floStore, documentOcrStore, ejariStore, extractBank, extractSupplement, enqueue }) {
  const workspaceId = job.workspace_id; const applicationId = job.application_id;
  const item = await floStore.getCase(workspaceId, applicationId);
  if (!item) return false;
  for (const doc of item.documents) {
    if (isEjariDocument(item, doc) && doc.extraction_state === 'not_run') {
      if (!ejariStore || doc.mime_type !== 'application/pdf') {
        await floStore.updateCase(workspaceId, applicationId, (current) => {
          const target = current.documents.find((value) => value.document_id === doc.document_id);
          target.extraction_reason = ejariStore ? 'ejari_pdf_required' : 'ejari_unavailable'; return current;
        });
        continue;
      }
      try {
        const bytes = await floStore.getEvidence(workspaceId, applicationId, doc.document_id);
        if (!bytes) throw new Error('evidence_missing');
        const created = await ejariStore.createJob({ workspaceId,
          idempotencyKey: `flo_${applicationId}_${doc.document_id}`,
          fields: { contract_number: null, dewa_number: null, input_pdf: true }, pdfBytes: bytes });
        await floStore.updateCase(workspaceId, applicationId, (current) => {
          const target = current.documents.find((value) => value.document_id === doc.document_id);
          target.extraction_state = 'queued'; target.ejari_job_id = created.job.id; return current;
        });
      } catch {
        await floStore.updateCase(workspaceId, applicationId, (current) => {
          const target = current.documents.find((value) => value.document_id === doc.document_id);
          target.extraction_state = 'failed'; target.extraction_reason = 'ejari_submission_failed'; return current;
        });
      }
      continue;
    }
    const serviceId = serviceForDocument(item, doc);
    if (bankDocument(doc) && doc.extraction_state === 'not_run') {
      const bytes = await floStore.getEvidence(workspaceId, applicationId, doc.document_id);
      const extracted = extractBank ? await extractBank(bytes, doc.mime_type)
        : { status: 'not_run', reason_codes: ['gemini_unconfigured'] };
      await floStore.updateCase(workspaceId, applicationId, (current) => {
        const target = current.documents.find((value) => value.document_id === doc.document_id);
        target.extraction_state = extracted.status;
        target.extraction_reason = extracted.reason_codes?.join(',') || null;
        target.extraction_result = extracted.status === 'completed' ? { data: extracted.data,
          model_id: extracted.model_id, schema_version: extracted.schema_version, input_sha256: extracted.input_sha256 } : null;
        return current;
      });
      continue;
    }
    if (supplementalDocument(item, doc) && doc.extraction_state === 'not_run') {
      const bytes = await floStore.getEvidence(workspaceId, applicationId, doc.document_id);
      const extracted = extractSupplement ? await extractSupplement(bytes, doc.mime_type, doc.type)
        : { status: 'not_run', reason_codes: ['gemini_unconfigured'] };
      await floStore.updateCase(workspaceId, applicationId, (current) => {
        const target = current.documents.find((value) => value.document_id === doc.document_id);
        target.extraction_state = extracted.status;
        target.extraction_reason = extracted.reason_codes?.join(',') || null;
        target.extraction_result = extracted.status === 'completed' ? { data: extracted.data,
          model_id: extracted.model_id, schema_version: extracted.schema_version, input_sha256: extracted.input_sha256 } : null;
        return current;
      });
      continue;
    }
    if (doc.extraction_state !== 'not_run') continue;
    if (!serviceId) {
      await floStore.updateCase(workspaceId, applicationId, (current) => {
        const target = current.documents.find((value) => value.document_id === doc.document_id);
        target.extraction_reason = 'extraction_adapter_unavailable'; return current;
      });
      continue;
    }
    if (!documentOcrStore) {
      await floStore.updateCase(workspaceId, applicationId, (current) => {
        const target = current.documents.find((value) => value.document_id === doc.document_id);
        target.extraction_state = 'not_run'; target.extraction_reason = 'ocr_unavailable'; return current;
      });
      continue;
    }
    let created;
    try {
      const bytes = await floStore.getEvidence(workspaceId, applicationId, doc.document_id);
      if (!bytes) throw new Error('evidence_missing');
      created = await documentOcrStore.createJob({ ownerId: workspaceId, serviceId,
        files: [{ bytes, mediaType: doc.mime_type }],
        idempotencyKey: `flo_${applicationId}_${doc.document_id}`, transactionId: randomUUID(), pipeline: 'legacy' });
    } catch {
      await floStore.updateCase(workspaceId, applicationId, (current) => {
        const target = current.documents.find((value) => value.document_id === doc.document_id);
        target.extraction_state = 'failed'; target.extraction_reason = 'ocr_submission_failed'; return current;
      });
      continue;
    }
    await floStore.updateCase(workspaceId, applicationId, (current) => {
      const target = current.documents.find((value) => value.document_id === doc.document_id);
      if (target.extraction_state === 'not_run') {
        target.extraction_state = 'queued'; target.ocr_job_id = created.job.id;
      }
      return current;
    });
  }
  const latest = await floStore.getCase(workspaceId, applicationId);
  let pending = false;
  for (const doc of latest.documents.filter((value) => value.extraction_state === 'queued')) {
    if (isEjariDocument(latest, doc)) {
      let response;
      try { response = await ejariStore?.getResult(doc.ejari_job_id, workspaceId); }
      catch { response = { job: { status: 'failed', reasonCode: 'ejari_result_unavailable' } }; }
      if (!response?.result && !['failed', 'not_found', 'could_not_complete'].includes(response?.job?.status)
        && job.attempt < 30) { pending = true; continue; }
      let certificateId = null;
      let certificateBytes = null;
      if (response?.result?.certificateAvailable) {
        try { certificateBytes = await ejariStore.getCertificate(doc.ejari_job_id, workspaceId); }
        catch { certificateBytes = null; }
        if (certificateBytes) { certificateId = randomUUID(); await floStore.putEvidence(workspaceId, applicationId, certificateId, certificateBytes); }
      }
      await floStore.updateCase(workspaceId, applicationId, (current) => {
        const target = current.documents.find((value) => value.document_id === doc.document_id);
        target.extraction_state = response?.result ? 'completed' : 'failed';
        target.extraction_reason = response?.result ? null : response?.job?.reasonCode || 'ejari_timeout';
        target.extraction_result = response?.result ? { data: response.result, source: 'dubai_land_department' } : null;
        if (certificateId) {
          target.certificate_document_id = certificateId;
          current.documents.push({ document_id: certificateId, type: 'ejari_certificate',
            mime_type: 'application/pdf', size: certificateBytes.length, sha256: sha256(certificateBytes),
            source_document_id: doc.document_id, scan_result: 'source_generated',
            uploaded_at: new Date().toISOString(), extraction_state: 'not_applicable' });
        }
        return current;
      });
      continue;
    }
    let response;
    try { response = await documentOcrStore.getResult(workspaceId, doc.ocr_job_id); }
    catch { response = { job: { status: 'failed', reason_code: 'ocr_result_unavailable' } }; }
    const done = response?.result || ['failed', 'review_required'].includes(response?.job?.status);
    if (!done && job.attempt < 30) { pending = true; continue; }
    await floStore.updateCase(workspaceId, applicationId, (current) => {
      const target = current.documents.find((value) => value.document_id === doc.document_id);
      target.extraction_state = response?.result ? 'completed' : 'failed';
      target.extraction_reason = response?.result ? null : response?.job?.reason_code || 'ocr_timeout';
      target.extraction_result = response?.result || null;
      return current;
    });
  }
  if (pending) {
    await enqueue?.({ workspace_id: workspaceId, application_id: applicationId,
      job_type: job.job_type, attempt: job.attempt + 1, delay_seconds: 20 });
    return false;
  }
  return true;
}

async function supplierPreviewChecks(workspaceId, applicationId, floStore, callProvider) {
  const item = await floStore.getCase(workspaceId, applicationId);
  const licence = item.documents.findLast((doc) => doc.type === 'tradeLicenceFile')?.extraction_result?.data || {};
  const bank = item.documents.findLast((doc) => doc.type === 'bankConfirmationFile')?.extraction_result?.data || {};
  const businessName = licence.company_name_english || item.draft.tradingName || null;
  const subjects = discoverSupplierSubjects(item);
  await floStore.updateCase(workspaceId, applicationId, (current) => {
    current.subjects = subjects; return current;
  });
  const checks = [
    ['uae-trade-licence', applicationId, licence.company_name_english && licence.license_number
      ? { company_name: licence.company_name_english, licence_number: licence.license_number } : null],
    ['iban-verification', applicationId, bank.iban && businessName
      ? { completeName: bank.account_holder || businessName, iban: bank.iban, country: 'AE' } : null]
  ];
  for (const subject of subjects) {
    if (subject.subject_id === applicationId) {
      checks.push(['entity-aml', applicationId, amlInput(subject.name,
        subject.type === 'individual' ? 'Individual' : 'Organization')]);
      checks.push(['entity-adverse-media', applicationId,
        { entity_type: subject.type, name: subject.name, country: 'AE' }]);
    } else {
      checks.push(['stakeholder-aml', subject.subject_id, amlInput(subject.name, 'Individual')]);
      checks.push(['stakeholder-adverse-media', subject.subject_id,
        { entity_type: 'individual', name: subject.name, country: 'AE' }]);
    }
  }
  for (const [serviceId, subjectId, input] of checks) {
    const current = await floStore.getCase(workspaceId, applicationId);
    if (current.checks.some((check) => check.service_id === serviceId && check.subject_id === subjectId)) continue;
    const check = input && callProvider ? await executeCheck(serviceId, subjectId, input, callProvider)
      : unavailableCheck(serviceId, subjectId, input ? 'adapter_unavailable' : 'extracted_input_missing');
    await floStore.updateCase(workspaceId, applicationId, (record) => {
      if (!record.checks.some((entry) => entry.service_id === serviceId && entry.subject_id === subjectId))
        record.checks.push(check);
      return record;
    });
  }
}

export async function processFloApplication(job, { floStore, documentOcrStore, ejariStore, enqueue, callProvider, runGeminiReview,
  extractBank, extractSupplement, createReport, enqueueCallback }) {
  const { workspace_id: workspaceId, application_id: applicationId } = job;
  const diagnostic = job.job_type === 'diagnostic';
  if (job.job_type === 'preview') {
    const current = await floStore.getCase(workspaceId, applicationId);
    if (!current || !['in_progress', 'restarted'].includes(current.status)) return;
    if (!await processDocuments(job, { floStore, documentOcrStore, ejariStore, extractBank, extractSupplement, enqueue })) return;
    if (supplierFlow(current)) await supplierPreviewChecks(workspaceId, applicationId, floStore, callProvider);
    const latest = await floStore.getCase(workspaceId, applicationId);
    const mapped = supplierFlow(latest) ? reviewSupplierCase(latest) : triangulateCase(latest);
    await floStore.updateCase(workspaceId, applicationId, (item) => {
      if (!['in_progress', 'restarted'].includes(item.status)) return null;
      item.facts = mapped.facts; item.comparisons = mapped.comparisons;
      item.preview_issues = mapped.preview_issues || [];
      item.preview_ready_at = new Date().toISOString(); return item;
    });
    return;
  }
  const starting = await floStore.updateCase(workspaceId, applicationId, (item) => {
    if (diagnostic) {
      if (!diagnosticCaseAllowed(item) || item.status !== 'in_progress'
        || !['queued', 'running'].includes(item.diagnostic?.state)) return null;
      item.diagnostic.state = 'running'; return item;
    }
    if (item.status !== 'submitted' && item.status !== 'processing') return null;
    item.status = 'processing'; return item;
  });
  if (!starting || !['submitted', 'processing'].includes(starting.status) && !diagnostic) return;
  if (!await processDocuments(job, { floStore, documentOcrStore, ejariStore, extractBank, extractSupplement, enqueue })) return;
  const ready = await floStore.getCase(workspaceId, applicationId);
  const isSupplier = supplierFlow(ready);
  const licenceDoc = ready.documents.findLast((doc) => doc.type === (isSupplier ? 'tradeLicenceFile' : 'trade_licence'));
  const licence = licenceDoc?.extraction_result?.data?.data || licenceDoc?.extraction_result?.data || {};
  const bankDoc = ready.documents.findLast((doc) => doc.type === (isSupplier ? 'bankConfirmationFile' : 'bank_letter'));
  const bank = bankDoc?.extraction_result?.data?.data || bankDoc?.extraction_result?.data || {};
  const businessName = isSupplier ? licence.company_name_english || ready.draft.tradingName || null : ready.draft.business_name;
  const licenceNumber = isSupplier ? licence.license_number || null : ready.draft.licence_number;
  const iban = isSupplier ? bank.iban || null : ready.draft.iban;
  const subjectId = applicationId;
  const required = [
    ['uae-trade-licence', businessName && licenceNumber && (!isSupplier || licence.company_name_english)
      ? { company_name: businessName, licence_number: licenceNumber } : null],
    ['iban-verification', iban && businessName ? { completeName: bank.account_holder || businessName,
      iban, country: 'AE' } : null],
    ['entity-aml', businessName ? amlInput(businessName, isSupplier && ready.draft.supplierType === 'natural_person' ? 'Individual' : 'Organization') : null],
    ['entity-adverse-media', businessName ? { entity_type: isSupplier && ready.draft.supplierType === 'natural_person' ? 'individual' : 'business',
      name: businessName, country: 'AE' } : null]
  ];
  const website = isSupplier ? ready.draft.website : ready.draft.website_url;
  if (website) required.push(['merchant-screening', {
    website_url: website, country_code: 'AE', declared_merchant_name: businessName,
    get_pdf: false, customer_logo_url: ''
  }]);
  for (const [serviceId, input] of required) {
    const item = await floStore.getCase(workspaceId, applicationId);
    if (item.checks.some((check) => check.service_id === serviceId)) continue;
    const check = input && callProvider ? await executeCheck(serviceId, subjectId, input, callProvider)
      : unavailableCheck(serviceId, subjectId, input ? 'adapter_unavailable' : 'input_missing');
    await floStore.updateCase(workspaceId, applicationId, (current) => {
      if (!current.checks.some((value) => value.service_id === serviceId)) current.checks.push(check);
      return current;
    });
  }
  const ejariDocument = ready.documents.findLast((doc) => isEjariDocument(ready, doc));
  await floStore.updateCase(workspaceId, applicationId, (current) => {
      if (!current.checks.some((check) => check.service_id === 'ejari-verification')) {
        const result = ejariDocument?.extraction_result?.data;
        current.checks.push(result ? { check_id: randomUUID(), subject_id: subjectId,
          service_id: 'ejari-verification', started_at: ejariDocument.uploaded_at,
          completed_at: new Date().toISOString(), http_status: null,
          transport: result.status === 'could_not_complete' ? 'failed' : 'completed',
          coverage: result.status === 'verified' ? 'complete' : 'partial',
          business_result: 'requires_review', reason_codes: result.reasonCodes || [], raw_response: result }
          : unavailableCheck('ejari-verification', subjectId, ejariDocument?.extraction_reason || 'document_missing'));
      }
      return current;
  });
  if (isSupplier) {
    for (const serviceId of ['vat-verification', 'board-resolution-authenticity', 'bank-letter-authenticity']) {
      await floStore.updateCase(workspaceId, applicationId, (current) => {
        if (!current.checks.some((check) => check.service_id === serviceId))
          current.checks.push(unavailableCheck(serviceId, subjectId, 'documented_adapter_unavailable'));
        return current;
      });
    }
  }
  const subjects = isSupplier ? discoverSupplierSubjects(ready) : (ready.draft.stakeholders || []).map((person) => ({
    subject_id: sha256(`${applicationId}:${person.name.toLowerCase()}`).slice(0, 32),
    name: person.name, type: 'individual', roles: [person.role], source_ids: ['supplier']
  }));
  if (isSupplier) await floStore.updateCase(workspaceId, applicationId, (current) => {
    current.subjects = subjects; return current;
  });
  for (const stakeholder of subjects.filter((subject) => subject.subject_id !== subjectId)) {
    const personId = stakeholder.subject_id;
    for (const [serviceId, input] of [
      ['stakeholder-aml', amlInput(stakeholder.name, 'Individual')],
      ['stakeholder-adverse-media', { entity_type: 'individual', name: stakeholder.name, country: 'AE' }]
    ]) {
      const current = await floStore.getCase(workspaceId, applicationId);
      if (current.checks.some((check) => check.service_id === serviceId && check.subject_id === personId)) continue;
      const check = callProvider ? await executeCheck(serviceId, personId, input, callProvider)
        : unavailableCheck(serviceId, personId);
      await floStore.updateCase(workspaceId, applicationId, (current) => {
        if (!current.checks.some((check) => check.service_id === serviceId && check.subject_id === personId))
          current.checks.push(check);
        return current;
      });
    }
  }
  const current = await floStore.getCase(workspaceId, applicationId);
  const triangulation = isSupplier ? reviewSupplierCase(current) : triangulateCase(current);
  await floStore.updateCase(workspaceId, applicationId, (item) => {
    item.facts = triangulation.facts; item.comparisons = triangulation.comparisons;
    item.preview_issues = triangulation.preview_issues || []; return item;
  });
  const beforeGemini = await floStore.getCase(workspaceId, applicationId);
  const geminiReview = runGeminiReview ? await runGeminiReview(beforeGemini)
    : { status: 'not_run', reason_codes: ['gemini_unconfigured'], schema_version: '1.0.0' };
  await floStore.updateCase(workspaceId, applicationId, (item) => { item.gemini_review = geminiReview; return item; });
  const reviewed = await floStore.getCase(workspaceId, applicationId);
  const reviewStatus = reviewed.comparisons.some((comparison) => comparison.outcome === 'mismatch')
    || reviewed.preview_issues?.some((issue) => issue.severity === 'error')
    ? 'needs_correction' : 'pending_review';
  const report = await createReport({ ...reviewed, status: diagnostic ? 'diagnostic_review' : reviewStatus });
  const htmlId = randomUUID();
  const modelId = randomUUID();
  await floStore.putEvidence(workspaceId, applicationId, report.report_id, report.pdf);
  await floStore.putEvidence(workspaceId, applicationId, htmlId, Buffer.from(report.html));
  await floStore.putEvidence(workspaceId, applicationId, modelId, Buffer.from(JSON.stringify(report.model)));
  const finished = await floStore.updateCase(workspaceId, applicationId, (item) => {
    if (item.reports.some((value) => value.version === report.version)) return null;
    item.reports.push({ report_id: report.report_id, html_id: htmlId, model_id: modelId,
      version: report.version, sha256: report.sha256,
      application_revision: item.application_revision || 1,
      generated_at: report.generated_at, status: 'complete', branding: 'AI7EDD' });
    if (diagnostic) {
      item.diagnostic.state = 'complete'; item.diagnostic.completed_at = new Date().toISOString();
      item.diagnostic.finding = reviewStatus;
    } else item.status = reviewStatus;
    item.events.push(callbackEvent(item, diagnostic ? 'diagnostic_review_ready' : 'review_ready', 'flo_worker'));
    return item;
  });
  const event = finished?.events.at(-1);
  if (['review_ready', 'diagnostic_review_ready'].includes(event?.type) && enqueueCallback)
    await enqueueCallback({ workspace_id: workspaceId, application_id: applicationId,
      job_type: 'callback', attempt: 0, event_id: event.event_id });
}

// Schema workflows execute only checks explicitly selected at publish time. A missing
// dependency is a recorded not_run result, never an implicit pass.
export async function processGenericFloApplication(job, { floStore, documentOcrStore, ejariStore, enqueue,
  callProvider, runGeminiReview, extractBank, extractSupplement, createReport, enqueueCallback }) {
  const workspaceId = job.workspace_id; const applicationId = job.application_id;
  const initial = await floStore.getCase(workspaceId, applicationId);
  if (!initial?.workflow_schema || !['submitted', 'processing'].includes(initial.status)) return;
  const revision = initial.application_revision || 1;
  if (initial.reports.some((report) => report.application_revision === revision)) return;
  await floStore.updateCase(workspaceId, applicationId, (item) => {
    if (item.application_revision !== revision || !['submitted', 'processing'].includes(item.status)) return null;
    item.status = 'processing'; return item;
  });
  if (!await processDocuments(job, { floStore, documentOcrStore, ejariStore, enqueue, extractBank, extractSupplement })) return;
  const ready = await floStore.getCase(workspaceId, applicationId);
  if (!ready || ready.application_revision !== revision) return;
  const draft = ready.draft || {};
  const licence = ready.documents.findLast((doc) => doc.type === 'trade_licence')?.extraction_result?.data || {};
  const bank = ready.documents.findLast((doc) => doc.type === 'bank_letter')?.extraction_result?.data || {};
  const name = draft.business_name || licence.company_name_english || null;
  const number = draft.licence_number || licence.license_number || null;
  const iban = draft.iban || bank.iban || null;
  const inputs = {
    'uae-trade-licence': name && number ? { company_name: name, licence_number: number } : null,
    'iban-verification': iban && name ? { completeName: bank.account_holder || name, iban, country: 'AE' } : null,
    'entity-aml': name ? amlInput(name, 'Organization') : null,
    'entity-adverse-media': name ? { entity_type: 'business', name, country: 'AE' } : null,
    'merchant-screening': draft.website_url ? { website_url: draft.website_url, country_code: 'AE',
      declared_merchant_name: name, get_pdf: false, customer_logo_url: '' } : null
  };
  const stakeholders = Array.isArray(draft.stakeholders) ? draft.stakeholders : [];
  for (const serviceId of ready.workflow_schema.checks) {
    const catalog = CHECK_CATALOG[serviceId];
    if (!catalog) throw new Error('unknown_published_check');
    if (serviceId.startsWith('stakeholder-')) {
      for (const person of stakeholders) {
        const personId = sha256(`${applicationId}:${person.name.toLowerCase()}`).slice(0, 32);
        const current = await floStore.getCase(workspaceId, applicationId);
        if (current.checks.some((check) => check.service_id === serviceId && check.subject_id === personId
          && check.application_revision === revision)) continue;
        const input = serviceId === 'stakeholder-aml' ? amlInput(person.name, 'Individual')
          : { entity_type: 'individual', name: person.name, country: 'AE' };
        const result = callProvider ? await executeCheck(serviceId, personId, input, callProvider)
          : unavailableCheck(serviceId, personId, 'adapter_unavailable');
        result.application_revision = revision;
        await floStore.updateCase(workspaceId, applicationId, (item) => {
          item.checks.push(result); return item;
        });
      }
      if (!stakeholders.length) await floStore.updateCase(workspaceId, applicationId, (item) => {
        item.checks.push({ ...unavailableCheck(serviceId, applicationId, 'stakeholders_missing'), application_revision: revision }); return item;
      });
      continue;
    }
    const current = await floStore.getCase(workspaceId, applicationId);
    if (current.checks.some((check) => check.service_id === serviceId && check.application_revision === revision)) continue;
    let result;
    if (serviceId === 'ejari-verification') {
      const doc = current.documents.findLast((entry) => entry.type === 'ejari');
      const data = doc?.extraction_result?.data;
      result = data ? { check_id: randomUUID(), subject_id: applicationId, service_id: serviceId,
        started_at: doc.uploaded_at, completed_at: new Date().toISOString(), transport: 'completed',
        coverage: data.status === 'verified' ? 'complete' : 'partial', business_result: 'requires_review',
        reason_codes: data.reasonCodes || [], raw_response: data }
        : unavailableCheck(serviceId, applicationId, doc?.extraction_reason || 'document_missing');
    } else {
      const missingDocument = catalog.documents.some((type) => !current.documents.some((doc) => doc.type === type));
      const input = inputs[serviceId];
      result = missingDocument ? unavailableCheck(serviceId, applicationId, 'document_missing')
        : input && callProvider ? await executeCheck(serviceId, applicationId, input, callProvider)
          : unavailableCheck(serviceId, applicationId, input ? 'adapter_unavailable' : 'input_missing');
    }
    result.application_revision = revision;
    await floStore.updateCase(workspaceId, applicationId, (item) => {
      if (item.application_revision !== revision) return null;
      if (!item.checks.some((check) => check.service_id === serviceId && check.application_revision === revision)) item.checks.push(result);
      return item;
    });
  }
  const checked = await floStore.getCase(workspaceId, applicationId);
  const triangulation = triangulateCase(checked);
  await floStore.updateCase(workspaceId, applicationId, (item) => {
    item.facts = triangulation.facts; item.comparisons = triangulation.comparisons;
    item.preview_issues = triangulation.preview_issues || []; return item;
  });
  const beforeGemini = await floStore.getCase(workspaceId, applicationId);
  const ai = runGeminiReview ? await runGeminiReview(beforeGemini)
    : { status: 'not_run', reason_codes: ['gemini_unconfigured'], schema_version: '1.0.0' };
  await floStore.updateCase(workspaceId, applicationId, (item) => { item.gemini_review = ai; return item; });
  const reviewed = await floStore.getCase(workspaceId, applicationId);
  const report = await createReport({ ...reviewed, status: 'pending_review' });
  const htmlId = randomUUID(); const modelId = randomUUID();
  await floStore.putEvidence(workspaceId, applicationId, report.report_id, report.pdf);
  await floStore.putEvidence(workspaceId, applicationId, htmlId, Buffer.from(report.html));
  await floStore.putEvidence(workspaceId, applicationId, modelId, Buffer.from(JSON.stringify(report.model)));
  const completed = await floStore.updateCase(workspaceId, applicationId, (item) => {
    if (item.application_revision !== revision || item.reports.some((entry) => entry.application_revision === revision)) return null;
    item.reports.push({ report_id: report.report_id, html_id: htmlId, model_id: modelId, version: report.version,
      application_revision: revision, template_version: item.template_version, definition_hash: item.definition_hash,
      sha256: report.sha256, generated_at: report.generated_at, status: 'complete', branding: 'AI7EDD' });
    item.status = 'pending_review';
    item.events.push(callbackEvent(item, 'review_ready', 'flo_worker'));
    return item;
  });
  if (completed?.events.at(-1)?.type === 'review_ready' && enqueueCallback && completed.configuration?.callback_url) {
    try { await enqueueCallback({ workspace_id: workspaceId, application_id: applicationId,
      job_type: 'callback', attempt: 0, event_id: completed.events.at(-1).event_id }); }
    catch { /* The durable event is retryable. */ }
  }
}
