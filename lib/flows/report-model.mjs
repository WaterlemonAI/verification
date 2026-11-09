export function buildFloReportModel(item) {
  const label = (value) => value == null || value === '' ? 'Not supplied' : String(value);
  const licence = item.documents?.findLast((doc) => doc.type === 'trade_licence')?.extraction_result?.data || {};
  const formation = item.documents?.findLast((doc) => doc.type === 'formation_document')?.extraction_result?.data || {};
  const ibanCheck = item.checks?.find((check) => check.service_id === 'iban-verification');
  const sections = [
    { title: 'Business identity', lines: [
      `Business name: ${label(item.draft.business_name)}`, `Trade licence: ${label(item.draft.licence_number)}`,
      `Company type: ${label(item.draft.company_type)}`, `Activities: ${label(item.draft.activities)}`,
      `Registered address: ${label(item.draft.registered_address)}`, `Operating address: ${label(item.draft.operating_address)}`,
      `Trade licence status: ${label(licence.license_status)}`, `Trade licence expiry: ${label(licence.expiry_date)}`
    ] },
    { title: 'Ownership and signing authorities', lines: (item.draft.stakeholders || []).length
      ? item.draft.stakeholders.map((person) => `${person.name} · ${person.role} · ${person.ownership_percentage ?? 'unknown'}%`)
      : ['No stakeholders declared'] },
    { title: 'Organisation chart and UBOs', lines: [
      `Applicant entity: ${label(item.draft.business_name)}`,
      ...(item.draft.stakeholders || []).map((person) =>
        `${label(item.draft.business_name)} → ${person.name} (${person.role}, ${person.ownership_percentage ?? 'unknown'}% declared)`),
      ...((Array.isArray(formation.shareholders) ? formation.shareholders : []).map((person) =>
        `Formation source: ${person.name} (${person.shareholding_percent || 'percentage unavailable'})`))
    ] },
    { title: 'Document inventory', lines: (item.documents || []).map((doc) =>
      `${doc.type}: ${doc.document_id} · SHA-256 ${doc.sha256} · scan ${doc.scan_result} · extraction ${doc.extraction_state}`) },
    { title: 'Verification and screening matrix', lines: (item.checks || []).map((check) =>
      `${check.service_id} / ${check.subject_id}: ${check.transport}; coverage ${check.coverage}; result ${check.business_result}; reasons ${(check.reason_codes || []).join(', ')}`) },
    { title: 'Cross-document comparisons', lines: (item.comparisons || []).length
      ? item.comparisons.map((comparison) => `${comparison.rule}: ${comparison.outcome} (${comparison.reason}); sources ${comparison.left_fact_id || 'unavailable'} / ${comparison.right_fact_id || 'unavailable'}`)
      : ['Not available; extraction and source links incomplete'] },
    { title: 'Risk profile and IBAN', lines: [
      `IBAN supplied: ${item.draft.iban ? 'yes' : 'no'}`,
      `IBAN API: ${ibanCheck?.transport || 'not_run'}; ${ibanCheck?.business_result || 'could_not_complete'}`,
      'Bank letter authenticity: not_run; no documented authenticity endpoint is configured.',
      'No automated acceptance conclusion is available. Buyer review is required.',
      `Incomplete checks: ${(item.checks || []).filter((check) => check.coverage !== 'complete').map((check) => check.service_id).join(', ') || 'none'}`
    ] },
    { title: 'Gemini evidence review', lines: item.gemini_review?.status === 'completed'
      ? [item.gemini_review.output.narrative,
        ...item.gemini_review.output.issues.map((issue) => `${issue.title}: ${issue.detail}; evidence ${issue.evidence_ids.join(', ')}`),
        ...item.gemini_review.output.extraction_gaps.map((gap) => `Extraction gap ${gap.document_id}: ${gap.field}`)]
      : [`Not completed: ${(item.gemini_review?.reason_codes || item.gemini_review?.validation_errors || ['unavailable']).join(', ')}`] },
    { title: 'Adverse-media response appendix', lines: (item.checks || []).filter((check) => /adverse-media/.test(check.service_id))
      .flatMap((check) => [`Subject ${check.subject_id} · ${check.service_id}`, JSON.stringify(check.raw_response ?? { status: check.transport, reason_codes: check.reason_codes }, null, 2)]) }
  ];
  return { title: 'Business Onboarding & Due Diligence Report', schema_version: '1.0.0',
    application_id: item.application_id, workspace_id: item.workspace_id, generated_at: new Date().toISOString(),
    status: item.status, sections };
}
