import { analyzeDocumentWithAzure, countDocumentPages } from './azure-document-ocr.mjs';
import { analyzeDocumentWithPaddle } from './document-ocr-paddle.mjs';
import { analyzeDocumentWithOllama, OLLAMA_OCR_MODEL, structureDocumentWithOllama } from './document-ocr-ollama.mjs';
import { DOCUMENT_OCR_BY_ID } from './document-ocr-contracts.mjs';
import { structureDocument } from './document-ocr-engine.mjs';
import { cropIdentityRegion, renderEmiratesIdPages } from './document-ocr-identity-images.mjs';
import { scanDocumentBytes } from './document-ocr-malware.mjs';

const terminal = new Set(['completed', 'review_required', 'failed']);
const ambiguousStages = new Set(['azure_in_flight', 'paddle_in_flight', 'gemini_in_flight',
  'ollama_in_flight', 'ollama_structuring_in_flight']);

function reason(error) {
  const code = String(error?.message || 'DOCUMENT_OCR_UNAVAILABLE');
  return /^(?:document_ocr_[a-z0-9_]+|DOCUMENT_OCR_[A-Z0-9_]+)$/.test(code)
    ? code.toUpperCase() : 'DOCUMENT_OCR_UNAVAILABLE';
}

export async function processDocumentOcrJob({ store, partitionKey, jobId, getGeminiKey,
  scan = scanDocumentBytes, analyze = analyzeDocumentWithAzure, analyzePaddle = analyzeDocumentWithPaddle,
  analyzeOllama = analyzeDocumentWithOllama, structure = structureDocument,
  structureOllama = structureDocumentWithOllama,
  renderIdentity = renderEmiratesIdPages, cropIdentity = cropIdentityRegion }) {
  let row = await store.getRow(partitionKey, jobId);
  if (!row) return { status: 'missing' };
  if (terminal.has(row.status)) return { status: row.status };
  const work = await store.getInputs(partitionKey, jobId);
  if (!work) return { status: 'missing' };
  row = work.row;
  const definition = DOCUMENT_OCR_BY_ID.get(row.serviceId);
  if (!definition) {
    await store.fail(row, 'configuration_failed', 'DOCUMENT_OCR_SERVICE_UNKNOWN');
    return { status: 'failed' };
  }
  const extractionEngine = row.extractionEngine || 'azure';
  if (!['azure', 'paddle', 'ollama'].includes(extractionEngine)) {
    await store.fail(row, 'configuration_failed', 'DOCUMENT_OCR_ENGINE_INVALID');
    return { status: 'failed' };
  }
  if (ambiguousStages.has(row.stage)) {
    // A replayed queue message can arrive while the first worker still owns
    // this paid call. Leave it invisible until the active attempt completes;
    // only an abandoned marker is failed closed, without another provider call.
    const markerAge = Date.now() - Date.parse(row.timestamp || '');
    const maxAge = row.stage.startsWith('ollama_') ? 3 * 60 * 60 * 1_000 : 15 * 60 * 1_000;
    if (Number.isFinite(markerAge) && markerAge >= 0 && markerAge < maxAge)
      return { status: 'in_progress' };
    await store.fail(row, 'provider_outcome_unknown', 'DOCUMENT_OCR_PROVIDER_OUTCOME_UNKNOWN');
    return { status: 'failed' };
  }
  try {
    if (row.stage === 'queued' || row.stage === 'scanning') {
      row = await store.transition(row, 'scanning');
      for (const file of work.files) await scan(file.bytes);
      let totalPages = 0;
      for (const file of work.files) totalPages += await countDocumentPages(file.bytes, file.mediaType);
      if (totalPages > definition.maxPages) throw new Error('document_ocr_page_limit');
      row = await store.transition(row, 'scan_complete', { malwareGate: 'passed', pageCount: totalPages });
    }

    const checkpoint = Number(row.processedFiles || 0) ? await store.getOcr(row) : { pages: [], figures: [], verifiedMrz: null };
    let pages = checkpoint.pages;
    let figures = checkpoint.figures;
    let verifiedMrz = checkpoint.verifiedMrz || null;
    const identityIssues = [];
    for (let index = Number(row.processedFiles || 0); index < work.files.length; index += 1) {
      const file = work.files[index];
      const countField = extractionEngine === 'ollama' ? 'ollamaCallCount'
        : extractionEngine === 'paddle' ? 'paddleCallCount' : 'azureCallCount';
      row = await store.transition(row, `${extractionEngine}_in_flight`, { [countField]: Number(row[countField] || 0) + 1 });
      const extraction = extractionEngine === 'ollama'
        ? await analyzeOllama({ bytes: file.bytes, mediaType: file.mediaType, maxPages: definition.maxPages })
        : extractionEngine === 'paddle'
        ? await analyzePaddle({ bytes: file.bytes, mediaType: file.mediaType, maxPages: definition.maxPages })
        : await analyze({ bytes: file.bytes, mediaType: file.mediaType,
          maxPages: definition.maxPages, includeFigures: false,
          model: definition.id === 'passport-icao-ocr' ? 'prebuilt-idDocument' : 'prebuilt-layout' });
      const offset = pages.length;
      pages = [...pages, ...extraction.pages.map((page) => ({ page: offset + page.page,
        text: page.text, ...(Array.isArray(page.lines) ? { lines: page.lines } : {}) }))];
      if (definition.id === 'passport-icao-ocr' && extraction.verifiedMrz)
        verifiedMrz = { page: offset + extraction.verifiedMrz.page, lines: extraction.verifiedMrz.lines };
      let imageFigures = extraction.figures || [];
      if (definition.id === 'emirates-id-ocr') {
        try {
          const rendered = await renderIdentity({ bytes: file.bytes, mediaType: file.mediaType,
            maxPages: definition.maxPages });
          imageFigures = rendered.figures;
          if (rendered.mrzAmbiguous) {
            verifiedMrz = null;
            identityIssues.push('EMIRATES_ID_MRZ_AMBIGUOUS');
          }
          if (rendered.verifiedMrz) {
            const next = { page: offset + rendered.verifiedMrz.page, lines: rendered.verifiedMrz.lines };
            if (verifiedMrz && verifiedMrz.lines.join('\n') !== next.lines.join('\n')) {
              verifiedMrz = null;
              identityIssues.push('EMIRATES_ID_MRZ_AMBIGUOUS');
            } else if (!identityIssues.includes('EMIRATES_ID_MRZ_AMBIGUOUS')) {
              const page = pages.find((item) => item.page === next.page);
              if (page) {
                verifiedMrz = next;
                page.text += `\nMRZ line 1: ${next.lines[0]}\nMRZ line 2: ${next.lines[1]}\nMRZ line 3: ${next.lines[2]}`;
              } else identityIssues.push('EMIRATES_ID_MRZ_PAGE_UNAVAILABLE');
            }
          }
        } catch {
          identityIssues.push('EMIRATES_ID_PAGE_RENDER_UNAVAILABLE');
        }
      }
      for (const figure of imageFigures) {
        if (figures.length >= 8 || figures.reduce((sum, item) => sum + item.bytes.length, 0) + figure.bytes.length > 4 * 1024 * 1024) break;
        figures.push({ ...figure, id: `${index}-${figure.id}`, page: offset + figure.page });
      }
      const calls = extractionEngine === 'ollama'
        ? Number(row[countField] || 0) - 1 + Number(extraction.callCount || 1) : Number(row[countField]);
      row = await store.saveOcr(row, pages, calls, index + 1, figures, verifiedMrz);
    }
    if (row.stage !== 'ocr_complete') throw new Error('document_ocr_stage_invalid');
    if (pages.every((page) => !page.text.trim())) throw new Error('document_ocr_text_unavailable');
    let extracted;
    if (extractionEngine === 'ollama') {
      row = await store.transition(row, 'ollama_structuring_in_flight');
      extracted = await structureOllama({ definition, pages, figures, verifiedMrz });
      row = await store.transition(row, 'ollama_structuring_complete', {
        ollamaCallCount: Number(row.ollamaCallCount || 0) + Number(extracted.usage?.calls || 1) });
    } else {
      const aiKey = await getGeminiKey();
      if (!aiKey) throw new Error('document_ocr_ai_credential_unavailable');
      row = await store.transition(row, 'gemini_in_flight', { geminiCallCount: 1 });
      extracted = await structure({ definition, pages, figures, verifiedMrz, apiKey: aiKey });
    }
    if (identityIssues.length) {
      extracted.review_flags.push(...identityIssues);
      extracted.review_required = true;
    }
    const artifacts = [];
    if (definition.id === 'emirates-id-ocr') {
      for (const role of ['photo', 'signature']) {
        const matches = (extracted.image_regions || [])
          .filter((item) => item.role === role && item.confidence === 'high');
        if (matches.length > 1) {
          extracted.review_flags.push(`EMIRATES_ID_${role.toUpperCase()}_AMBIGUOUS`);
          extracted.review_required = true;
        } else if (matches.length === 1) {
          const figure = figures.find((item) => item.id === matches[0].id);
          if (figure) {
            try {
              const bytes = await cropIdentity(figure.bytes, matches[0]);
              await store.saveArtifact(row, role, bytes);
              artifacts.push({ name: role, content_type: 'image/png', page: figure.page });
            } catch {
              extracted.review_flags.push(`EMIRATES_ID_${role.toUpperCase()}_CROP_UNAVAILABLE`);
              extracted.review_required = true;
            }
          }
        }
      }
    }
    const result = {
      transaction_id: row.transactionId,
      job_id: row.jobId,
      service_id: row.serviceId,
      status: extracted.review_required ? 'review_required' : 'completed',
      processed_at: new Date().toISOString(),
      document_classification: extracted.document_classification,
      data: extracted.data,
      evidence: extracted.evidence,
      mrz: extracted.mrz,
      review_required: extracted.review_required,
      review_flags: extracted.review_flags,
      artifacts,
      processing: { ocr_model: extractionEngine === 'ollama' ? OLLAMA_OCR_MODEL
        : extractionEngine === 'paddle' ? 'PaddleOCR:PP-OCRv5-ONNX'
          : `${definition.id === 'passport-icao-ocr' ? 'prebuilt-idDocument' : 'prebuilt-layout'}:2024-11-30`, ai_model: extracted.model,
        page_count: Number(row.pageCount || pages.length), malware_gate: row.malwareGate || 'passed',
        provider_calls: { azure: Number(row.azureCallCount || 0), gemini: Number(row.geminiCallCount || 0),
          ollama: Number(row.ollamaCallCount || 0) } }
    };
    await store.complete(row, result);
    return { status: result.status };
  } catch (error) {
    const code = reason(error);
    await store.fail(row, 'processing_failed', code);
    return { status: 'failed', reason_code: code };
  }
}

export async function consumeDocumentOcrQueue({ store, usageStore, getGeminiKey, stopSignal,
  processJob = processDocumentOcrJob, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  while (!stopSignal?.aborted) {
    const batch = await store.queue.receiveMessages({ numberOfMessages: 1, visibilityTimeout: 900 });
    const message = batch.receivedMessageItems?.[0];
    if (!message) { await pause(5_000); continue; }
    let payload;
    try { payload = JSON.parse(Buffer.from(message.messageText, 'base64').toString('utf8')); }
    catch { payload = null; }
    if (!payload || payload.version !== 1 || !/^[a-f0-9]{64}$/.test(payload.partitionKey)
      || !/^ocr_[0-9a-f-]{36}$/.test(payload.jobId)) {
      await store.queue.deleteMessage(message.messageId, message.popReceipt);
      continue;
    }
    let receipt = message.popReceipt;
    let renewal = Promise.resolve();
    const renewalTimer = setInterval(() => {
      renewal = renewal.then(async () => {
        const updated = await store.queue.updateMessage(message.messageId, receipt, message.messageText,
          { visibilityTimeout: 900 });
        receipt = updated.popReceipt;
      }).catch(() => { console.warn('document_ocr_visibility_renewal_failed'); });
    }, 300_000);
    renewalTimer.unref();
    try {
      const outcome = await processJob({ store, partitionKey: payload.partitionKey, jobId: payload.jobId, getGeminiKey });
      clearInterval(renewalTimer);
      await renewal;
      if (terminal.has(outcome.status) || outcome.status === 'missing') {
        if (terminal.has(outcome.status) && usageStore) {
          const row = await store.getRow(payload.partitionKey, payload.jobId);
          if (row?.billingLogKey && row?.billingWorkspaceId) {
            await usageStore.settleAsyncResult(row.billingWorkspaceId, row.billingLogKey, {
              successful: ['completed', 'review_required'].includes(outcome.status),
              reason: row.reasonCode || 'document_ocr_processing_failed'
            });
            await store.markBillingSettled(row);
          }
        }
        await store.queue.deleteMessage(message.messageId, receipt);
      }
    } catch (error) {
      clearInterval(renewalTimer);
      await renewal;
      // Transient storage failure: the message may reappear. In-flight markers
      // prevent duplicate Azure/Gemini calls after an ambiguous failure.
      console.warn('document_ocr_queue_failure', JSON.stringify({ job_id: payload.jobId,
        stage: 'storage_or_queue', dequeue_count: message.dequeueCount || 1 }));
      if (message.dequeueCount >= 3) {
        const row = await store.getRow(payload.partitionKey, payload.jobId);
        if (row && !terminal.has(row.status)) {
          const failed = await store.deadLetter(row, 'DOCUMENT_OCR_QUEUE_RETRIES_EXHAUSTED');
          if (usageStore && failed.billingLogKey && failed.billingWorkspaceId)
            await usageStore.settleAsyncResult(failed.billingWorkspaceId, failed.billingLogKey, {
              successful: false, reason: 'DOCUMENT_OCR_QUEUE_RETRIES_EXHAUSTED'
            });
          if (usageStore && failed.billingLogKey && failed.billingWorkspaceId) await store.markBillingSettled(failed);
        } else if (row && store.deadLetterQueue) {
          await store.deadLetterQueue.sendMessage(Buffer.from(JSON.stringify({ version: 1,
            partitionKey: row.partitionKey, jobId: row.jobId,
            reasonCode: 'DOCUMENT_OCR_SETTLEMENT_REQUIRES_REVIEW' })).toString('base64'));
        }
        await store.queue.deleteMessage(message.messageId, receipt);
      }
    }
  }
}
