// Fail closed before deployment when this release changes anything beyond the
// API and its isolated document OCR worker. Accept only an exact scoped ID.
import { readFileSync } from 'node:fs';

const preview = JSON.parse(readFileSync(0, 'utf8'));
const changes = preview.changes || preview.properties?.changes;
if (!Array.isArray(changes)) throw new Error('document_ocr_whatif_missing_changes');
const group = process.env.AZURE_RESOURCE_GROUP;
const subscription = process.env.AZURE_SUBSCRIPTION_ID;
if (!/^rg-ai7uae-web-uaen-001$/.test(group || '') || !/^[0-9a-f-]{36}$/i.test(subscription || ''))
  throw new Error('document_ocr_whatif_scope_invalid');
const prefix = `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.App/containerApps/`.toLowerCase();
const allowed = new Set(['ca-ai7uae-api', 'ca-ai7uae-document-ocr-worker'].map((name) => prefix + name));
const unexpected = changes.filter((item) => {
  const kind = item.changeType || item.change_type;
  if (kind === 'NoChange') return false;
  if (kind !== 'Modify' || !allowed.has(String(item.resourceId || item.resource_id || '').toLowerCase())) return true;
  if (!Array.isArray(item.delta) || !item.delta.length) return true;
  return item.delta.some((change) => {
    const path = String(change.path || '');
    if (path === 'properties.template.containers[0].image' && change.propertyChangeType === 'Modify') return false;
    if (/^properties\.template\.containers\[0\]\.env\[\d+\]$/.test(path)
      && change.propertyChangeType === 'Create'
      && change.after?.name === 'DOCUMENT_OCR_WORKER_IMAGE') return false;
    return true;
  });
});
if (unexpected.length) {
  // Resource IDs and change types only; do not print properties or secrets.
  for (const item of unexpected) console.error(`${item.changeType || item.change_type}: ${item.resourceId || item.resource_id}`);
  throw new Error('document_ocr_whatif_unrelated_change');
}
console.log(`Document OCR what-if accepted: ${changes.filter((item) => item.changeType === 'Modify').length} scoped modifications.`);
