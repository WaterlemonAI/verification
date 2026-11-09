export function diagnosticCaseAllowed(item) {
  return item?.flow_id === 'supplier-onboarding-v1'
    && /^[a-f0-9]{16}$/.test(process.env.FLO_DIAGNOSTIC_WORKSPACE_ID || '')
    && /^[0-9a-f-]{36}$/i.test(process.env.FLO_DIAGNOSTIC_APPLICATION_ID || '')
    && item.workspace_id === process.env.FLO_DIAGNOSTIC_WORKSPACE_ID
    && item.application_id === process.env.FLO_DIAGNOSTIC_APPLICATION_ID;
}
