import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const openapi = JSON.parse(readFileSync(new URL('../api/openapi.json', import.meta.url), 'utf8'));
const ejari = JSON.parse(readFileSync(new URL('../api/ejari-openapi.json', import.meta.url), 'utf8'));

test('published contracts include the response discrepancies found in the one-call audit', () => {
  const adverse = openapi.components.schemas.AdverseMediaResult;
  assert.ok(adverse.required.includes('evidence_assessment'));
  assert.deepEqual(adverse.properties.evidence_assessment.type, ['string', 'null']);

  const merchant = openapi.components.schemas.MerchantScreeningResponse;
  assert.equal(merchant.properties.request.$ref, '#/components/schemas/MerchantScreeningNormalizedRequest');
  const echoed = openapi.components.schemas.MerchantScreeningNormalizedRequest;
  for (const field of ['declared_merchant_name', 'declared_mcc', 'customer_logo_url']) {
    assert.deepEqual(echoed.properties[field].type, ['string', 'null']);
  }

  assert.ok(openapi.paths['/service/entity_search'].post.responses['403']);
  assert.equal(openapi.paths['/service/peppol_check'].post.responses['403'].content['application/json'].schema.$ref,
    '#/components/schemas/Error');
  assert.equal(openapi.paths['/service/peppol_check'].post.responses['503'].content['application/json'].schema.$ref,
    '#/components/schemas/PeppolGlobalResult');
  assert.ok(openapi.paths['/service/dubai_ejari_verification'].$ref);
  assert.equal(ejari.paths['/service/dubai_ejari_verification'].post.responses['202'].content['application/json'].schema.$ref,
    '#/components/schemas/Receipt');
  assert.ok(ejari.paths['/service/dubai_ejari_verification/jobs/{jobId}'].get.responses['200'].content);
  assert.ok(ejari.paths['/service/dubai_ejari_verification/jobs/{jobId}/result'].get.responses['202'].content);
});
