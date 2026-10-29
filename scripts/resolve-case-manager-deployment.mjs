import { pathToFileURL } from 'node:url';

function enabled(value, name) {
  if (value == null || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false`);
}

export function resolveCaseManagerDeployment({ desired = '', emergencyOff = '', maintenance = '', privatePathVerified = '' } = {}) {
  const desiredEnabled = enabled(desired, 'CASE_MANAGER_DESIRED_ENABLED');
  const emergencyDisabled = enabled(emergencyOff, 'CASE_MANAGER_EMERGENCY_OFF');
  const maintenanceEnabled = enabled(maintenance, 'CASE_MANAGER_MAINTENANCE_ENABLED');
  const privateVerified = enabled(privatePathVerified, 'CASE_MANAGER_PRIVATE_PATH_VERIFIED');
  if (desiredEnabled && !maintenanceEnabled) throw new Error('Case Manager maintenance must remain enabled after approval');
  if ((maintenanceEnabled || (desiredEnabled && !emergencyDisabled)) && !privateVerified) {
    throw new Error('Case Manager capture and maintenance require a verified private-network data path');
  }
  return { enabled: desiredEnabled && !emergencyDisabled, maintenance: maintenanceEnabled };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const state = resolveCaseManagerDeployment({
    desired: process.env.CASE_MANAGER_DESIRED_ENABLED,
    emergencyOff: process.env.CASE_MANAGER_EMERGENCY_OFF,
    maintenance: process.env.CASE_MANAGER_MAINTENANCE_ENABLED,
    privatePathVerified: process.env.CASE_MANAGER_PRIVATE_PATH_VERIFIED
  });
  process.stdout.write(`enabled=${state.enabled}\nmaintenance=${state.maintenance}\n`);
}
