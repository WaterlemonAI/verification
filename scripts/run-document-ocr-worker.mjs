import { createStore } from '../lib/api-store.mjs';
import { createDocumentOcrStore } from '../lib/document-ocr-store.mjs';
import { consumeDocumentOcrQueue } from '../lib/document-ocr-worker.mjs';
import { createCustomerUsageStore } from '../lib/customer-usage.mjs';
import { scanDocumentBytes } from '../lib/document-ocr-malware.mjs';
import { spawnSync } from 'node:child_process';

const documentStore = createDocumentOcrStore();
if (!documentStore || !process.env.DOCUMENT_OCR_DATA_KEY_HEX || !process.env.DOCUMENT_OCR_AZURE_ENDPOINT
  || !process.env.DOCUMENT_OCR_CLAMD_HOST) throw new Error('document_ocr_worker_configuration_incomplete');

const credentials = createStore();
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

let malwareReady = false;
for (let attempt = 0; attempt < 60 && !controller.signal.aborted; attempt += 1) {
  try { await scanDocumentBytes(Buffer.from('ai7-ocr-readiness'), { timeoutMs: 2_000 }); malwareReady = true; break; }
  catch { await new Promise((resolve) => setTimeout(resolve, 3_000)); }
}
if (!malwareReady) throw new Error('document_ocr_malware_scanner_unavailable');

const paddleocr = spawnSync(process.env.DOCUMENT_OCR_PYTHON || 'python3',
  ['scripts/document_ocr_paddle.py', '--check'], { stdio: 'ignore', timeout: 20_000 }).status === 0;
await documentStore.recordWorkerCapability({ paddleocr });
const capabilityHeartbeat = setInterval(() => {
  documentStore.recordWorkerCapability({ paddleocr }).catch(() => {});
}, 60_000);
capabilityHeartbeat.unref();

await consumeDocumentOcrQueue({ store: documentStore,
  usageStore: createCustomerUsageStore(),
  getGeminiKey: () => credentials.getMasterKey('document-ocr-ai'),
  stopSignal: controller.signal });
clearInterval(capabilityHeartbeat);
