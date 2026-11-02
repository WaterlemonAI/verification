import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/document_ocr_paddle.py', import.meta.url));
const maximumOutput = 2 * 1024 * 1024;

export async function analyzeDocumentWithPaddle({ bytes, mediaType, maxPages,
  python = process.env.DOCUMENT_OCR_PYTHON || 'python3', timeoutMs = 840_000 }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 25 * 1024 * 1024)
    throw new Error('document_ocr_file_limit');
  if (!['application/pdf', 'image/png', 'image/jpeg'].includes(mediaType))
    throw new Error('document_ocr_media_type_unsupported');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50)
    throw new Error('document_ocr_page_limit_invalid');
  const output = await new Promise((resolve, reject) => {
    const child = spawn(python, [script, '--media-type', mediaType, '--max-pages', String(maxPages)],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True' } });
    const chunks = [];
    let size = 0;
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumOutput) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (expired) reject(new Error('document_ocr_paddle_timeout'));
      else if (size > maximumOutput) reject(new Error('document_ocr_paddle_output_limit'));
      else if (code !== 0) reject(new Error('document_ocr_paddle_failed'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
  let result;
  try { result = JSON.parse(output.toString('utf8')); }
  catch { throw new Error('document_ocr_paddle_output_invalid'); }
  if (!Array.isArray(result.pages) || !result.pages.length || result.pages.length > maxPages
    || result.pages.some((page, index) => page.page !== index + 1 || typeof page.text !== 'string'
      || page.text.length > 80_000)) throw new Error('document_ocr_paddle_output_invalid');
  return { pages: result.pages, figures: [], pageCount: result.pages.length,
    verifiedMrz: null, model: 'paddleocr:PP-OCRv5' };
}
