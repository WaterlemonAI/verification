import { buildFloReportModel } from '../../report-model.mjs';
import { supplierRequirements } from './rules.mjs';

export function buildSupplierReportModel(item) {
  const draft = item.draft || {};
  const licence = item.documents?.findLast((doc) => doc.type === 'tradeLicenceFile')?.extraction_result?.data || {};
  const bank = item.documents?.findLast((doc) => doc.type === 'bankConfirmationFile')?.extraction_result?.data || {};
  const base = buildFloReportModel({ ...item,
    draft: { ...draft, business_name: licence.company_name_english || draft.tradingName,
      licence_number: licence.license_number, iban: bank.iban,
      company_type: draft.supplierType, activities: draft.siteActivities,
      registered_address: draft.operatingAddress },
    documents: (item.documents || []).map((doc) => ({ ...doc, type: {
      tradeLicenceFile: 'trade_licence', moaFile: 'formation_document', bankConfirmationFile: 'bank_letter'
    }[doc.type] || doc.type }))
  });
  const required = supplierRequirements(draft).documents;
  const provided = new Set((item.documents || []).map((doc) => doc.type));
  const sections = [
    { title: 'Flow and application', lines: [
      `Flow: ${item.flow_id} version ${item.template_version}`,
      `Supplier type: ${draft.supplierType || 'Not supplied'}`,
      `Trading name: ${draft.tradingName || 'Extracted from identity or licence'}`,
      `Status: ${item.status}`
    ] },
    { title: 'Business activity, capacity and payment profile', lines: [
      `Supply: ${draft.supplyType || 'Not supplied'} · ${draft.supplyDescription || 'Not supplied'}`,
      `Site activities: ${draft.siteActivities || 'Not supplied'}`,
      `Staff: ${draft.staffCount || 'Not supplied'} · unusual capacity: ${draft.unusualCapacity || 'Not supplied'}`,
      `Third-party payments: ${draft.thirdPartyPayments || 'Not supplied'} · cash: ${draft.cashPayment || 'Not supplied'}`,
      `Intermediary: ${draft.intermediary || 'Not supplied'}`
    ] },
    { title: 'Required and provided documents', lines: [
      ...required.map((type) => `${type}: ${provided.has(type) ? 'provided' : 'missing'}`),
      ...(item.documents || []).filter((doc) => !required.includes(doc.type))
        .map((doc) => `${doc.type}: provided; extraction ${doc.extraction_state}`)
    ] },
    { title: 'Organisation, UBOs and signing authority', lines: (item.subjects || []).length
      ? item.subjects.map((subject) => `${subject.name} · ${subject.type} · ${(subject.roles || []).join(', ')} · sources ${(subject.source_ids || []).join(', ')}`)
      : ['No subjects could be identified; buyer review required'] },
    { title: 'Supplier-correctable evidence issues', lines: (item.preview_issues || []).length
      ? item.preview_issues.map((issue) => `${issue.code}: ${issue.message}`)
      : ['No deterministic correction issue recorded'] },
    { title: 'Incomplete or unavailable checks', lines: (item.checks || []).filter((check) => check.coverage !== 'complete')
      .map((check) => `${check.service_id} / ${check.subject_id}: ${check.transport}; ${(check.reason_codes || []).join(', ')}`) }
  ];
  return { ...base, title: 'Supplier Onboarding & Due Diligence Report',
    schema_version: 'supplier-onboarding-1.0.0', flow_id: item.flow_id,
    template_version: item.template_version, sections: [...sections, ...base.sections] };
}
