import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFloStagingParameters, stagingVariableNames } from '../scripts/prepare-flo-staging.mjs';

function fixture() {
  const env = Object.fromEntries(stagingVariableNames.map((name) => [name, `flo-staging-${name.toLowerCase()}`]));
  env.STAGING_RESOURCE_GROUP = 'rg-flo-staging';
  const resource = (type, name) => `/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/rg-flo-staging/providers/${type}/${name}`;
  env.STAGING_ENVIRONMENT_ID = resource('Microsoft.App/managedEnvironments', 'aca-flo-staging');
  env.STAGING_RUNTIME_IDENTITY_RESOURCE_ID = resource('Microsoft.ManagedIdentity/userAssignedIdentities', 'id-flo-staging');
  env.STAGING_API_CERTIFICATE_ID = resource('Microsoft.App/managedEnvironments', 'aca-flo-staging/managedCertificates/api-staging');
  env.STAGING_APP_CERTIFICATE_ID = resource('Microsoft.App/managedEnvironments', 'aca-flo-staging/managedCertificates/app-staging');
  env.STAGING_FLO_CERTIFICATE_ID = resource('Microsoft.App/managedEnvironments', 'aca-flo-staging/managedCertificates/flo-staging');
  env.STAGING_API_HOST = 'api-staging.ai7uae.com';
  env.STAGING_APP_HOST = 'app-staging.kycprobe.com';
  env.STAGING_FLO_HOST = 'flo-staging.ai7uae.com';
  env.STAGING_ACR_LOGIN_SERVER = 'acrflo.azurecr.io';
  env.STAGING_KEY_VAULT_URI = 'https://kv-flo-staging.vault.azure.net/';
  env.STAGING_BSA_DOCUMENT_ENDPOINT = 'https://doc-bsa-staging.cognitiveservices.azure.com/';
  env.STAGING_OCR_ENDPOINT = 'https://doc-ocr-staging.cognitiveservices.azure.com/';
  env.STAGING_API_ALERT_EMAIL = 'flo-staging@example.com';
  env.STAGING_ALERT_GROUP_SHORT_NAME = 'FLOSTGAPI';
  env.STAGING_SMTP_USER = 'flo-staging@example.com';
  for (const [index, name] of stagingVariableNames.filter((value) => value.endsWith('STORAGE_NAME')).entries())
    env[name] = `flostg${index}storage`;
  for (const name of stagingVariableNames.filter((value) => value.endsWith('_IMAGE')))
    env[name] = `acrflo.azurecr.io/${name.toLowerCase()}@sha256:${'a'.repeat(64)}`;
  env.STAGING_API_IMAGE = `acrflo.azurecr.io/api@sha256:${'b'.repeat(64)}`;
  return env;
}

test('staging parameters use separate hosts, storage and digest-pinned images with full OCR enabled', () => {
  const parameters = buildFloStagingParameters(fixture());
  assert.equal(parameters.apiHost, 'api-staging.ai7uae.com');
  assert.equal(parameters.floHost, 'flo-staging.ai7uae.com');
  assert.equal(parameters.parallelDeployment, false);
  assert.equal(parameters.enableDocumentOcr, true);
  assert.equal(parameters.enableFlo, true);
  assert.equal(parameters.enableFloWorkflowPlatform, true);
  assert.equal(parameters.enableBillingNotifications, false);
  assert.equal(parameters.image.endsWith(`@sha256:${'b'.repeat(64)}`), true);
});

test('staging parameters reject production hosts, resource groups, shared storage and mutable images', () => {
  for (const [key, value] of [
    ['STAGING_RESOURCE_GROUP', 'rg-ai7uae-production'],
    ['STAGING_API_HOST', 'api.ai7uae.com'],
    ['STAGING_APP_HOST', 'app.kycprobe.com'],
    ['STAGING_FLO_HOST', 'flo.ai7uae.com'],
    ['STAGING_KEY_VAULT_URI', 'https://kv-ai7uae-prod.vault.azure.net/'],
    ['STAGING_API_IMAGE', 'acrflo.azurecr.io/api:latest'],
    ['STAGING_FLO_STORAGE_NAME', 'flostg0storage']
  ]) {
    const env = fixture(); env[key] = value;
    assert.throws(() => buildFloStagingParameters(env), /flo_staging_config_/, key);
  }
});
