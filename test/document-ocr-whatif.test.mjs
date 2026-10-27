import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const subscription = '11111111-1111-4111-8111-111111111111';
const group = 'rg-ai7uae-web-uaen-001';
const base = `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.App/containerApps/`;
function preview(changes) {
  return spawnSync(process.execPath, ['scripts/guard-document-ocr-whatif.mjs'], {
    input: JSON.stringify({ changes }), encoding: 'utf8',
    env: { ...process.env, AZURE_SUBSCRIPTION_ID: subscription, AZURE_RESOURCE_GROUP: group }
  });
}

test('OCR release what-if accepts only exact API and OCR worker modifications', () => {
  const safeDelta = [{ path: 'properties.template.containers[0].image', propertyChangeType: 'Modify' },
    { path: 'properties.template.containers[0].env[42]', propertyChangeType: 'Create',
      after: { name: 'DOCUMENT_OCR_WORKER_IMAGE', value: 'image@sha256:example' } }];
  assert.equal(preview([{ resourceId: `${base}ca-ai7uae-api`, changeType: 'Modify', delta: safeDelta },
    { resourceId: `${base}ca-ai7uae-document-ocr-worker`, changeType: 'Modify', delta: safeDelta }]).status, 0);
  assert.notEqual(preview([{ resourceId: `${base}ca-ai7uae-bsa-worker`, changeType: 'Modify' }]).status, 0);
  assert.notEqual(preview([{ resourceId: `${base}ca-ai7uae-document-ocr-worker`, changeType: 'Delete' }]).status, 0);
  assert.notEqual(preview([{ resourceId: `${base}ca-ai7uae-api`, changeType: 'Create' }]).status, 0);
  assert.notEqual(preview([{ resourceId: `${base}ca-ai7uae-api/extra`, changeType: 'Modify', delta: safeDelta }]).status, 0);
  assert.notEqual(preview([{ resourceId: `${base}ca-ai7uae-api`, changeType: 'Modify', delta: [
    { path: 'properties.configuration.ingress.external', propertyChangeType: 'Modify' }
  ] }]).status, 0);
  assert.equal(preview([]).status, 0);
});
