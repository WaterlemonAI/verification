import { createDocumentOcrStore } from '../lib/document-ocr-store.mjs';
import { createCustomerUsageStore } from '../lib/customer-usage.mjs';

const store = createDocumentOcrStore();
if (!store) throw new Error('document_ocr_storage_unavailable');
const usageStore = createCustomerUsageStore();
const reconciled = await store.reconcileUsage(usageStore);
const count = await store.purgeExpired(new Date(), usageStore);
console.info('document_ocr_retention_purge', JSON.stringify({ usage_rows_reconciled: reconciled, expired_jobs_removed: count }));
