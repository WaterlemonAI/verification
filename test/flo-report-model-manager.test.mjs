import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFloReportModel } from '../lib/flows/report-model.mjs';

test('manager-only evidence is visible without claiming owner coverage', () => {
  const item = {
    application_id: 'case-1', workspace_id: 'workspace-1', flow_id: 'al-naboodah',
    status: 'pending_review', draft: { business_name: 'Example LLC' }, documents: [],
    workflow_schema: { stages: [] }, checks: [
      { service_id: 'stakeholder-aml', subject_id: 'manager-1', transport: 'completed', coverage: 'complete' },
      { service_id: 'stakeholder-adverse-media', subject_id: 'manager-1', transport: 'completed', coverage: 'complete' }
    ],
    subjects: [{ subject_id: 'manager-1', name: 'Sam Manager', roles: ['verified business manager'],
      source_ids: ['tlv-1'] }]
  };
  const sections = buildFloReportModel(item).sections;
  assert.ok(sections.find((section) => section.title === 'Business manager identification')
    .lines.some((line) => line.includes('Sam Manager') && line.includes('AML completed')
      && line.includes('adverse media completed')));
  assert.ok(sections.find((section) => section.title === 'Ownership and signing authorities')
    .lines.some((line) => line.includes('Owner/director names were not identified')));
});
