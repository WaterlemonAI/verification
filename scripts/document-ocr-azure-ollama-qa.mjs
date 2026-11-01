// Temporary, isolated QA runner. Never invoked by the customer API or queue worker.
import { spawn } from 'node:child_process';
import { BlobServiceClient } from '@azure/storage-blob';
import { analyzeDocumentWithAzure } from '../lib/azure-document-ocr.mjs';
import { DOCUMENT_OCR_BY_ID } from '../lib/document-ocr-contracts.mjs';
import { renderEmiratesIdPages } from '../lib/document-ocr-identity-images.mjs';
import { localOllamaFetch, structureDocumentWithOllama } from '../lib/document-ocr-ollama.mjs';

const cases = [
  ['passport', 'passport-icao-ocr'],
  ['emirates_id', 'emirates-id-ocr'],
  ['trade_license', 'uae-trade-license-ocr'],
  ['poa', 'uae-poa-ocr'],
  ['moa', 'moa-analysis']
].filter(([name]) => !process.env.QA_CASE || process.env.QA_CASE === name);
const runId = process.env.QA_RUN_ID || '';
const account = process.env.QA_STORAGE_ACCOUNT || '';
const model = process.env.QA_MODEL || 'qwen3:0.6b';
const ocrEndpoint = process.env.QA_OCR_ENDPOINT || '';
if (!/^[a-f0-9]{32}$/.test(runId) || !/^[a-z0-9]{3,24}$/.test(account)
  || !['qwen3:0.6b', 'qwen3:1.7b'].includes(model) || !cases.length
  || !/^https:\/\/doc-[a-z0-9-]+\.cognitiveservices\.azure\.com\/$/.test(ocrEndpoint)
  || !process.env.QA_STORAGE_CLIENT_ID || !process.env.QA_OCR_CLIENT_ID)
  throw new Error('qa_configuration_invalid');

class SelectedManagedIdentityCredential {
  constructor(clientId) { this.clientId = clientId; }
  async getToken(scopes) {
    if (!process.env.IDENTITY_ENDPOINT || !process.env.IDENTITY_HEADER)
      throw new Error('qa_identity_unavailable');
    const url = new URL(process.env.IDENTITY_ENDPOINT);
    url.searchParams.set('api-version', '2019-08-01');
    url.searchParams.set('resource', String(Array.isArray(scopes) ? scopes[0] : scopes).replace(/\.default$/, ''));
    url.searchParams.set('client_id', this.clientId);
    const response = await fetch(url, { headers: { 'x-identity-header': process.env.IDENTITY_HEADER,
      metadata: 'true' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('qa_identity_token_failed');
    const payload = await response.json();
    return { token: payload.access_token,
      expiresOnTimestamp: Number(payload.expires_on) * 1_000 || Date.now() + 30 * 60_000 };
  }
}

const input = new BlobServiceClient(`https://${account}.blob.core.windows.net`,
  new SelectedManagedIdentityCredential(process.env.QA_STORAGE_CLIENT_ID)).getContainerClient('input');
const output = new BlobServiceClient(`https://${account}.blob.core.windows.net`,
  new SelectedManagedIdentityCredential(process.env.QA_STORAGE_CLIENT_ID)).getContainerClient('output');
const ocrCredential = new SelectedManagedIdentityCredential(process.env.QA_OCR_CLIENT_ID);
const ollama = spawn('ollama', ['serve'], { stdio: ['ignore', 'ignore', 'ignore'],
  env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_NO_CLOUD: 'true',
    OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1' } });
let ready = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2_000) });
    const names = new Set((await response.json()).models?.map((item) => item.name) || []);
    if (names.has(model)) { ready = true; break; }
  } catch { /* Wait for the local daemon. */ }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (!ready) throw new Error('qa_ollama_unavailable');

let failures = 0;
try {
  for (const [name, id] of cases) {
    const started = performance.now();
    let phase = 'download';
    const modelTimings = [];
    console.info('QA_START', JSON.stringify({ case: name, model }));
    try {
      const definition = DOCUMENT_OCR_BY_ID.get(id);
      const bytes = await input.getBlobClient(`qa/${runId}/${name}.pdf`).downloadToBuffer();
      const downloadMs = Math.round(performance.now() - started);
      phase = 'azure_ocr';
      const ocrStarted = performance.now();
      const analyzed = await analyzeDocumentWithAzure({ bytes, mediaType: 'application/pdf',
        maxPages: definition.maxPages, model: id === 'passport-icao-ocr'
          ? 'prebuilt-idDocument' : 'prebuilt-layout', endpoint: ocrEndpoint,
        region: 'uaenorth', approvedRegion: 'uaenorth', credential: ocrCredential });
      const azureMs = Math.round(performance.now() - ocrStarted);
      console.info('QA_STAGE', JSON.stringify({ case: name, phase: 'azure_ocr_complete',
        pages: analyzed.pages.length, elapsed_ms: Math.round(performance.now() - started) }));
      let verifiedMrz = analyzed.verifiedMrz || null;
      let identityRenderMs = 0;
      if (id === 'emirates-id-ocr') {
        phase = 'identity_mrz';
        const renderStarted = performance.now();
        const identity = await renderEmiratesIdPages({ bytes, mediaType: 'application/pdf',
          maxPages: definition.maxPages, detectMrz: true });
        verifiedMrz = identity.verifiedMrz || null;
        if (verifiedMrz) {
          const page = analyzed.pages.find((item) => item.page === verifiedMrz.page);
          if (page) page.text += verifiedMrz.lines
            .map((line, index) => `\nMRZ line ${index + 1}: ${line}`).join('');
        }
        identityRenderMs = Math.round(performance.now() - renderStarted);
      }
      phase = 'ollama_structuring';
      const structureStarted = performance.now();
      const generate = async (request) => {
        const callStarted = performance.now();
        const response = await localOllamaFetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, system: request.system,
            prompt: `/no_think\n${request.prompt}`, format: request.format,
            stream: false, think: false, keep_alive: '5m',
            options: { temperature: 0, num_ctx: request.numCtx,
              num_predict: request.numPredict, num_thread: Number(process.env.QA_MODEL_THREADS || 2) } }),
          signal: AbortSignal.timeout(600_000)
        });
        if (!response.ok) throw new Error('qa_ollama_http_error');
        const payload = await response.json();
        modelTimings.push({ ms: Math.round(performance.now() - callStarted),
          input_tokens: Number(payload.prompt_eval_count || 0),
          output_tokens: Number(payload.eval_count || 0),
          model_load_ms: Math.round(Number(payload.load_duration || 0) / 1_000_000),
          prompt_eval_ms: Math.round(Number(payload.prompt_eval_duration || 0) / 1_000_000),
          generation_ms: Math.round(Number(payload.eval_duration || 0) / 1_000_000) });
        if (payload.done !== true || typeof payload.response !== 'string' || !payload.response.trim()
          || payload.done_reason === 'length') throw new Error('qa_ollama_response_invalid');
        return payload;
      };
      // This invokes the same untrusted-OCR prompt, JSON schema, evidence validator,
      // Not Found/Not Readable rules, and MRZ checks as the proposed worker.
      const result = await structureDocumentWithOllama({ definition, pages: analyzed.pages,
        verifiedMrz, figures: [], generate });
      const structureMs = Math.round(performance.now() - structureStarted);
      const values = Object.values(result.data || {});
      const summary = { case: name, model, pages: analyzed.pages.length, fields: values.length,
        populated: values.filter((value) => value !== 'Not Found' && value !== 'Not Readable'
          && !(Array.isArray(value) && !value.length)).length,
        evidence_fields: new Set((result.evidence || []).map((item) => item.field)).size,
        classification_matches: result.document_classification === definition.documentKind,
        review_required: result.review_required,
        review_flags: (result.review_flags || []).filter((value) => /^[A-Z0-9_]+$/.test(value)),
        mrz_integrity: result.mrz?.integrity_status || 'not_applicable',
        photo_signature_crops: 0, download_ms: downloadMs, azure_ms: azureMs,
        identity_render_ms: identityRenderMs, structure_ms: structureMs,
        model_calls: modelTimings.length, model_timings: modelTimings,
        end_to_end_ms: Math.round(performance.now() - started) };
      phase = 'result_storage';
      await output.getBlockBlobClient(`qa/${runId}/${model.replace(':', '-')}/${name}.json`)
        .uploadData(Buffer.from(JSON.stringify({ summary, result })),
          { blobHTTPHeaders: { blobContentType: 'application/json' } });
      console.info('QA_RESULT', JSON.stringify(summary));
    } catch (error) {
      failures += 1;
      console.error('QA_FAILURE', JSON.stringify({ case: name, model, phase,
        code: /^[a-zA-Z0-9_]+$/.test(String(error?.message)) ? error.message : 'qa_failed',
        model_calls: modelTimings.length, model_timings: modelTimings,
        elapsed_ms: Math.round(performance.now() - started) }));
    }
  }
} finally { ollama.kill('SIGTERM'); }
if (failures) process.exitCode = 1;
