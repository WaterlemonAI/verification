import { pathToFileURL } from 'node:url';

function enabled(value, name) {
  if (value == null || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false`);
}

export function resolveCaseManagerDeployment({ desired = '', emergencyOff = '', maintenance = '' } = {}) {
  const desiredEnabled = enabled(desired, 'CASE_MANAGER_DESIRED_ENABLED');
  const emergencyDisabled = enabled(emergencyOff, 'CASE_MANAGER_EMERGENCY_OFF');
  const maintenanceEnabled = enabled(maintenance, 'CASE_MANAGER_MAINTENANCE_ENABLED');
  if (desiredEnabled && !maintenanceEnabled) throw new Error('Case Manager maintenance must remain enabled after approval');
  return { enabled: desiredEnabled && !emergencyDisabled, maintenance: maintenanceEnabled };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const state = resolveCaseManagerDeployment({
    desired: process.env.CASE_MANAGER_DESIRED_ENABLED,
    emergencyOff: process.env.CASE_MANAGER_EMERGENCY_OFF,
    maintenance: process.env.CASE_MANAGER_MAINTENANCE_ENABLED
  });
  process.stdout.write(`enabled=${state.enabled}\nmaintenance=${state.maintenance}\n`);
}
