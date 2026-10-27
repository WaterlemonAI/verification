import { PDFDocument } from 'pdf-lib';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';

const API_VERSION = '2024-11-30';
const MODEL = 'prebuilt-layout';
const AZURE_SCOPE = 'https://cognitiveservices.azure.com/.default';

function approvedEndpoint(endpoint, region, approvedRegion) {
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error('document_ocr_azure_endpoint_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || !['', '/'].includes(parsed.pathname) || !parsed.hostname.endsWith('.cognitiveservices.azure.com')
    || region !== approvedRegion || region !== 'uaenorth') throw new Error('document_ocr_azure_endpoint_invalid');
  return parsed.origin;
}

function operationUrl(value, endpoint) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('document_ocr_azure_operation_url_invalid'); }
  if (parsed.origin !== endpoint || parsed.hash || parsed.search !== `?api-version=${API_VERSION}`
    || !/^\/documentintelligence\/documentModels\/prebuilt-layout\/analyzeResults\/[0-9a-f-]{36}$/i.test(parsed.pathname)) {
    throw new Error('document_ocr_azure_operation_url_invalid');
  }
  return parsed.toString();
}

export async function countDocumentPages(bytes, mediaType) {
  if (mediaType !== 'application/pdf') return 1;
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
    return pdf.getPageCount();
  } catch { throw new Error('document_ocr_pdf_invalid_or_encrypted'); }
}

function pagesFromLayout(result) {
  if (result?.modelId !== MODEL || !Array.isArray(result.pages) || !result.pages.length) {
    throw new Error('document_ocr_azure_result_invalid');
  }
  const pages = result.pages.map((page) => ({
    page: page.pageNumber,
    text: (page.lines || []).map((line) => String(line.content || '')).filter(Boolean).join('\n')
  }));
  if (pages.some((page) => !Number.isInteger(page.page) || page.page < 1)) throw new Error('document_ocr_azure_result_invalid');
  for (const table of result.tables || []) {
    for (const cell of table.cells || []) {
      const pageNumber = cell.boundingRegions?.[0]?.pageNumber;
      const page = pages.find((item) => item.page === pageNumber);
      if (page) page.text += `\nTABLE row ${cell.rowIndex + 1}, column ${cell.columnIndex + 1}: ${String(cell.content || '')}`;
    }
  }
  return pages;
}

export async function analyzeDocumentWithAzure({ bytes, mediaType, maxPages, endpoint = process.env.DOCUMENT_OCR_AZURE_ENDPOINT,
  region = process.env.DOCUMENT_OCR_AZURE_REGION, approvedRegion = process.env.DOCUMENT_OCR_APPROVED_REGION,
  includeFigures = false,
  credential = new ContainerAppsManagedIdentityCredential(), fetchImpl = fetch,
  pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxPolls = 180, pollIntervalMs = 1_000 }) {
  const origin = approvedEndpoint(endpoint, region, approvedRegion);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) throw new Error('document_ocr_page_limit_invalid');
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('document_ocr_file_limit');
  if (!['application/pdf', 'image/png', 'image/jpeg'].includes(mediaType)) throw new Error('document_ocr_media_type_unsupported');
  const pageCount = await countDocumentPages(bytes, mediaType);
  if (!pageCount || pageCount > maxPages) throw new Error('document_ocr_page_limit');
  const token = (await credential.getToken([AZURE_SCOPE])).token;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' };
  const analyzeUrl = `${origin}/documentintelligence/documentModels/${MODEL}:analyze?_overload=analyzeDocument&api-version=${API_VERSION}${includeFigures ? '&output=figures' : ''}`;
  let resultUrl;
  let failure;
  let pages;
  let figures = [];
  try {
    const submitted = await fetchImpl(analyzeUrl, {
      method: 'POST', headers, body: JSON.stringify({ base64Source: bytes.toString('base64') }),
      signal: AbortSignal.timeout(30_000)
    });
    if (submitted.status !== 202) throw new Error(`document_ocr_azure_submit_${submitted.status}`);
    resultUrl = operationUrl(submitted.headers.get('operation-location') || '', origin);
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const response = await fetchImpl(resultUrl, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`document_ocr_azure_poll_${response.status}`);
      const payload = await response.json();
      const status = String(payload.status || '').toLowerCase();
      if (status === 'succeeded') {
        pages = pagesFromLayout(payload.analyzeResult);
        if (includeFigures) {
          const candidates = (payload.analyzeResult?.figures || []).slice(0, 8);
          for (const figure of candidates) {
            if (!/^\d+\.\d+$/.test(figure.id || '')) continue;
            const page = Number(figure.boundingRegions?.[0]?.pageNumber);
            if (!Number.isInteger(page) || page < 1 || page > maxPages) continue;
            const figureUrl = `${resultUrl.replace(/\?api-version=.*/, '')}/figures/${figure.id}?api-version=${API_VERSION}`;
            try {
              const image = await fetchImpl(figureUrl, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) });
              if (!image.ok || !String(image.headers.get('content-type') || '').startsWith('image/png')) continue;
              if (Number(image.headers.get('content-length') || 0) > 2 * 1024 * 1024) continue;
              const imageBytes = Buffer.from(await image.arrayBuffer());
              if (!imageBytes.length || imageBytes.length > 2 * 1024 * 1024
                || figures.reduce((sum, item) => sum + item.bytes.length, 0) + imageBytes.length > 4 * 1024 * 1024) continue;
              figures.push({ id: figure.id, page, contentType: 'image/png', bytes: imageBytes });
            } catch { /* The text result remains usable; the missing crop requires review. */ }
          }
        }
        break;
      }
      if (status === 'failed' || status === 'canceled') throw new Error('document_ocr_azure_failed');
      if (!['running', 'notstarted'].includes(status)) throw new Error('document_ocr_azure_status_invalid');
      await pause(pollIntervalMs);
    }
    if (!pages) throw new Error('document_ocr_azure_timeout');
  } catch (error) { failure = error; }
  if (resultUrl) {
    try {
      const deleted = await fetchImpl(resultUrl, { method: 'DELETE', headers, signal: AbortSignal.timeout(30_000) });
      if (deleted.status !== 204) throw new Error('document_ocr_azure_result_delete_failed');
    } catch { throw new Error('document_ocr_azure_result_delete_failed'); }
  }
  if (failure) throw failure;
  if (pages.length > maxPages) throw new Error('document_ocr_page_limit');
  return { pages, figures, pageCount, model: `${MODEL}:${API_VERSION}` };
}
