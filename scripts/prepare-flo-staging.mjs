import { writeFileSync } from 'node:fs';

const names = {
  resourceGroup: 'STAGING_RESOURCE_GROUP', environmentId: 'STAGING_ENVIRONMENT_ID',
  runtimeIdentityResourceId: 'STAGING_RUNTIME_IDENTITY_RESOURCE_ID',
  runtimeIdentityClientId: 'STAGING_RUNTIME_IDENTITY_CLIENT_ID',
  acrLoginServer: 'STAGING_ACR_LOGIN_SERVER', keyVaultUri: 'STAGING_KEY_VAULT_URI',
  apiHost: 'STAGING_API_HOST', appHost: 'STAGING_APP_HOST', floHost: 'STAGING_FLO_HOST',
  apiCertificateId: 'STAGING_API_CERTIFICATE_ID', appCertificateId: 'STAGING_APP_CERTIFICATE_ID',
  floCertificateId: 'STAGING_FLO_CERTIFICATE_ID', containerAppName: 'STAGING_API_APP_NAME',
  merchantScreenshotWorkerName: 'STAGING_MERCHANT_WORKER_NAME',
  bankStatementWorkerName: 'STAGING_BSA_WORKER_NAME',
  documentOcrWorkerName: 'STAGING_OCR_WORKER_NAME',
  documentOcrPurgeJobName: 'STAGING_OCR_PURGE_JOB_NAME',
  ejariWorkerName: 'STAGING_EJARI_WORKER_NAME', ejariPurgeJobName: 'STAGING_EJARI_PURGE_JOB_NAME',
  merchantScreenshotWorkerIdentityName: 'STAGING_MERCHANT_IDENTITY_NAME',
  bankStatementWorkerIdentityName: 'STAGING_BSA_IDENTITY_NAME',
  documentOcrWorkerIdentityName: 'STAGING_OCR_IDENTITY_NAME',
  ejariWorkerIdentityName: 'STAGING_EJARI_IDENTITY_NAME',
  bankStatementStorageName: 'STAGING_BSA_STORAGE_NAME',
  documentOcrStorageName: 'STAGING_OCR_STORAGE_NAME',
  caseManagerStorageName: 'STAGING_FLO_STORAGE_NAME',
  ejariStorageName: 'STAGING_EJARI_STORAGE_NAME',
  deepResearchStorageName: 'STAGING_DEEP_RESEARCH_STORAGE_NAME',
  gdeltStorageName: 'STAGING_GDELT_STORAGE_NAME',
  reportStorageName: 'STAGING_REPORT_STORAGE_NAME',
  adverseJsonStorageName: 'STAGING_ADVERSE_JSON_STORAGE_NAME',
  logAnalyticsWorkspaceName: 'STAGING_LOG_WORKSPACE_NAME',
  bankStatementDocumentEndpoint: 'STAGING_BSA_DOCUMENT_ENDPOINT',
  documentOcrEndpoint: 'STAGING_OCR_ENDPOINT',
  apiAlertEmail: 'STAGING_API_ALERT_EMAIL', alertResourcePrefix: 'STAGING_ALERT_RESOURCE_PREFIX',
  alertGroupShortName: 'STAGING_ALERT_GROUP_SHORT_NAME',
  billingNotificationsJobName: 'STAGING_BILLING_JOB_NAME',
  peppolIngestJobName: 'STAGING_PEPPOL_JOB_NAME',
  platformSmtpUser: 'STAGING_SMTP_USER'
};
const workerImages = {
  merchantScreenshotWorkerImage: 'STAGING_MERCHANT_IMAGE',
  bankStatementWorkerImage: 'STAGING_BSA_IMAGE',
  documentOcrWorkerImage: 'STAGING_OCR_IMAGE',
  ejariWorkerImage: 'STAGING_EJARI_IMAGE'
};
export const stagingVariableNames = Object.freeze([...Object.values(names), ...Object.values(workerImages)]);

function stageName(value) { return /(?:staging|stg)/i.test(value); }
function fail(reason) { throw new Error(`flo_staging_config_${reason}`); }
function inGroup(id, group) {
  return id.toLowerCase().includes(`/resourcegroups/${group.toLowerCase()}/`);
}

export function buildFloStagingParameters(env, { imageRequired = true } = {}) {
  const params = {};
  for (const [parameter, variable] of Object.entries(names)) {
    const value = String(env[variable] || '').trim();
    if (!value) fail(`missing_${variable}`);
    params[parameter] = value;
  }
  const group = params.resourceGroup;
  if (!stageName(group) || /(?:^|[-_])production(?:$|[-_])/i.test(group)) fail('resource_group');
  for (const parameter of ['apiHost', 'appHost', 'floHost']) {
    if (!/^[a-z0-9-]+-staging\.[a-z0-9.-]+$/i.test(params[parameter])) fail(parameter);
  }
  if (new Set([params.apiHost, params.appHost, params.floHost]).size !== 3) fail('duplicate_hosts');
  for (const parameter of ['environmentId', 'runtimeIdentityResourceId', 'apiCertificateId',
    'appCertificateId', 'floCertificateId']) {
    if (!inGroup(params[parameter], group) || !stageName(params[parameter])) fail(parameter);
  }
  for (const parameter of Object.keys(names).filter((key) => /(?:Name|Prefix)$/.test(key)
    && !['resourceGroup'].includes(key))) {
    if (!stageName(params[parameter])) fail(parameter);
  }
  for (const parameter of Object.keys(names).filter((key) => /StorageName$/.test(key))) {
    if (!/^[a-z0-9]{3,24}$/.test(params[parameter]) || !stageName(params[parameter])) fail(parameter);
  }
  const dedicatedStorage = ['bankStatementStorageName', 'documentOcrStorageName', 'caseManagerStorageName', 'ejariStorageName'];
  if (new Set(dedicatedStorage.map((key) => params[key])).size !== dedicatedStorage.length
    || Object.keys(names).filter((key) => /StorageName$/.test(key) && key !== 'caseManagerStorageName')
      .some((key) => params[key] === params.caseManagerStorageName)) fail('shared_storage');
  const vault = new URL(params.keyVaultUri);
  if (vault.protocol !== 'https:' || !stageName(vault.hostname) || !vault.hostname.endsWith('.vault.azure.net')
    || vault.username || vault.password || vault.search || vault.hash || vault.pathname !== '/') fail('key_vault');
  for (const parameter of ['bankStatementDocumentEndpoint', 'documentOcrEndpoint']) {
    const endpoint = new URL(params[parameter]);
    if (endpoint.protocol !== 'https:' || !stageName(endpoint.hostname)
      || !endpoint.hostname.endsWith('.cognitiveservices.azure.com')) fail(parameter);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(params.apiAlertEmail)
    || params.apiAlertEmail === 'notify@kycprobe.com') fail('alert_email');
  if (params.alertGroupShortName.length > 12) fail('alert_group_short_name');
  for (const [parameter, variable] of Object.entries(workerImages)) {
    const value = String(env[variable] || '').trim();
    if (!value) fail(`missing_${variable}`);
    params[parameter] = value;
  }
  const apiImage = String(env.STAGING_API_IMAGE || '').trim();
  if (imageRequired && !apiImage) fail('missing_STAGING_API_IMAGE');
  if (apiImage) params.image = apiImage;
  for (const [parameter, value] of Object.entries(params).filter(([key]) => key === 'image' || key.endsWith('Image'))) {
    if (!value.startsWith(`${params.acrLoginServer}/`) || !/@sha256:[a-f0-9]{64}$/.test(value)) fail(parameter);
  }
  return {
    ...params,
    enableFlo: true, enableFloWorkflowPlatform: true,
    enableDocumentOcr: true, enableDocumentOcrWorker: true, enableEjari: true,
    enableTaedMoa: true, enableTaedTradeLicense: true,
    enableCaseManager: false, maintainCaseManagerData: false,
    enableDeepResearchWorker: false, enableAdverseMediaSearchPlusGpt: false,
    enableBillingNotifications: false, parallelDeployment: false, parallelCaseManagerQa: false,
    apiTrafficCutover: true, preCutoverApiName: params.containerAppName
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  const parameters = buildFloStagingParameters(process.env, { imageRequired: Boolean(output) });
  if (output) writeFileSync(output, JSON.stringify({ $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
    contentVersion: '1.0.0.0', parameters: Object.fromEntries(Object.entries(parameters)
      .filter(([key]) => key !== 'resourceGroup').map(([key, value]) => [key, { value }])) }, null, 2));
  else process.stdout.write('Flo staging configuration validated.\n');
}
