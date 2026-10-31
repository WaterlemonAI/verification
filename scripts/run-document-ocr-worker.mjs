import { createStore } from '../lib/api-store.mjs';
import { createDocumentOcrStore } from '../lib/document-ocr-store.mjs';
import { consumeDocumentOcrQueue } from '../lib/document-ocr-worker.mjs';
import { createCustomerUsageStore } from '../lib/customer-usage.mjs';
import { scanDocumentBytes } from '../lib/document-ocr-malware.mjs';
import { OLLAMA_OCR_MODEL, OLLAMA_STRUCTURE_MODEL } from '../lib/document-ocr-ollama.mjs';
import { spawn } from 'node:child_process';

const documentStore = createDocumentOcrStore();
if (!documentStore || !process.env.DOCUMENT_OCR_DATA_KEY_HEX
  || !process.env.DOCUMENT_OCR_CLAMD_HOST) throw new Error('document_ocr_worker_configuration_incomplete');

const credentials = createStore();
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

const ollama = spawn('ollama', ['serve'], { stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_NO_CLOUD: 'true',
    OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1' } });
ollama.on('exit', () => controller.abort());
async function ollamaCapability() {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const names = new Set((await response.json()).models?.map((item) => item.name) || []);
    return names.has(OLLAMA_OCR_MODEL) && names.has(OLLAMA_STRUCTURE_MODEL);
  } catch { return false; }
}

let ollamaReady = false;
for (let attempt = 0; attempt < 60 && !controller.signal.aborted; attempt += 1) {
  if (await ollamaCapability()) { ollamaReady = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (!ollamaReady) throw new Error('document_ocr_ollama_unavailable');

let malwareReady = false;
for (let attempt = 0; attempt < 60 && !controller.signal.aborted; attempt += 1) {
  try { await scanDocumentBytes(Buffer.from('ai7-ocr-readiness'), { timeoutMs: 2_000 }); malwareReady = true; break; }
  catch { await new Promise((resolve) => setTimeout(resolve, 3_000)); }
}
if (!malwareReady) throw new Error('document_ocr_malware_scanner_unavailable');

async function refreshCapability() {
  try {
    await documentStore.recordWorkerCapability({ azure: Boolean(process.env.DOCUMENT_OCR_AZURE_ENDPOINT),
      paddle: false, ollama: await ollamaCapability(),
      imageDigest: process.env.DOCUMENT_OCR_WORKER_IMAGE || '' });
  } catch { console.warn('document_ocr_capability_check_failed'); }
}
await refreshCapability();
const capabilityTimer = setInterval(refreshCapability, 5 * 60_000);
capabilityTimer.unref();

try {
  await consumeDocumentOcrQueue({ store: documentStore,
    usageStore: createCustomerUsageStore(),
    getGeminiKey: () => credentials.getMasterKey('document-ocr-ai'),
    stopSignal: controller.signal });
} finally { clearInterval(capabilityTimer); ollama.kill('SIGTERM'); }
