import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveCaseManagerDeployment } from '../scripts/resolve-case-manager-deployment.mjs';

test('routine deployments preserve the approved Case Manager state', () => {
  assert.deepEqual(resolveCaseManagerDeployment(), { enabled: false, maintenance: false });
  const approved = { desired: 'true', emergencyOff: 'false', maintenance: 'true', privatePathVerified: 'true' };
  assert.deepEqual(resolveCaseManagerDeployment(approved), { enabled: true, maintenance: true });
  // The same persisted environment variables are read on manual and ordinary push deployments.
  assert.deepEqual(resolveCaseManagerDeployment(approved), { enabled: true, maintenance: true });
  assert.deepEqual(resolveCaseManagerDeployment({ ...approved, emergencyOff: 'true' }),
    { enabled: false, maintenance: true });
  assert.throws(() => resolveCaseManagerDeployment({ desired: 'true', maintenance: 'false' }), /maintenance/);
  assert.throws(() => resolveCaseManagerDeployment({ desired: 'true', maintenance: 'true' }), /private-network/);
  assert.deepEqual(resolveCaseManagerDeployment({ desired: 'true', emergencyOff: 'true', maintenance: 'true', privatePathVerified: 'true' }),
    { enabled: false, maintenance: true });
  assert.throws(() => resolveCaseManagerDeployment({ desired: 'true', emergencyOff: 'true', maintenance: 'true' }), /private-network/);
  assert.throws(() => resolveCaseManagerDeployment({ maintenance: 'true' }), /private-network/);
  assert.throws(() => resolveCaseManagerDeployment({ desired: 'yes', maintenance: 'true' }), /true or false/);
});

test('both normal push preview and deployment use the persisted resolved state', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-api.yml', import.meta.url), 'utf8');
  assert.match(workflow, /Resolve persistent Case Manager deployment state/);
  assert.equal((workflow.match(/enableCaseManager="\$\{\{ steps\.case_manager_state\.outputs\.enabled \}\}"/g) || []).length, 2);
  assert.doesNotMatch(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.enableCaseManager/);
});

test('Case Manager provisioning stays blocked and enabled capture requires a fresh private-path proof', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-api.yml', import.meta.url), 'utf8');
  const platform = readFileSync(new URL('../infrastructure/api-case-manager-platform.bicep', import.meta.url), 'utf8');
  assert.match(platform, /publicNetworkAccess: 'Disabled'/);
  assert.match(workflow, /Block Case Manager provisioning until private connectivity is reviewed/);
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' && inputs\.provisionCaseManagerPlatform\n\s+run: \|\n[\s\S]*?exit 1/);
  assert.match(workflow, /Verify Case Manager private data-plane proof before capture/);
  assert.match(workflow, /verify-case-manager-private-release\.mjs/);
  assert.match(workflow, /CASE_MANAGER_PRIVATE_PATH_VERIFIED: \$\{\{ steps\.case_manager_private_path\.outputs\.verified \}\}/);
  assert.doesNotMatch(workflow, /--template-file infrastructure\/api-case-manager-(?:network|platform|private-probe)\.bicep/);
});

test('parallel VNet preview creates new app names with shared queue consumers disabled', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-api.yml', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../infrastructure/api.bicep', import.meta.url), 'utf8');
  assert.equal((workflow.match(/parallelDeployment="\$\{\{ vars\.CASE_MANAGER_PARALLEL_QA/g) || []).length, 2);
  assert.match(workflow, /Block parallel mode on the existing live environment/);
  assert.match(workflow, /test -z "\$\{API_CERTIFICATE_RESOURCE_ID\}"/);
  assert.match(api, /resource bankStatementWorker [^\n]+ = if \(!parallelDeployment\)/);
  assert.match(api, /resource caseManagerReconcileJob [^\n]+ = if \(!parallelDeployment/);
  assert.match(api, /external: !parallelDeployment/);
  assert.match(api, /parallelDeployment \? \[\] : \[\s*\{ name: 'ADVERSE_MEDIA_QUEUE_URL'/);
});
