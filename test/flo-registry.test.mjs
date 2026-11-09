import test from 'node:test';
import assert from 'node:assert/strict';
import { latestTemplate, listTemplates, resolveTemplate } from '../lib/flows/registry.mjs';

test('reviewed packages resolve by exact flow ID and version', () => {
  assert.deepEqual(listTemplates().map((item) => item.flow_id).sort(), ['kys-v1', 'supplier-onboarding-v1']);
  const kys = latestTemplate('kys-v1');
  const supplier = latestTemplate('supplier-onboarding-v1');
  assert.equal(resolveTemplate('kys-v1', kys.version), kys);
  assert.equal(resolveTemplate('supplier-onboarding-v1', supplier.version), supplier);
  assert.equal(resolveTemplate('supplier-onboarding-v1', '2.0.0'), null);
  assert.equal(resolveTemplate('unknown-flow', '1.0.0'), null);
  assert.notEqual(kys.definition_hash, supplier.definition_hash);
  assert.notEqual(kys.supplierBundle, supplier.supplierBundle);
});
