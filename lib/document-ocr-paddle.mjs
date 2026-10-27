import { spawn } from 'node:child_process';
import { parseTd3Mrz } from './icao-mrz.mjs';

const SCRIPT = new URL('../scripts/document-ocr-paddle.py', import.meta.url).pathname;
const PYTHON = process.env.DOCUMENT_OCR_PYTHON || '/opt/document-ocr-python/bin/python';

function run(args, bytes = null, timeoutMs = 720_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    let size = 0;
    let stderrSize = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) child.kill('SIGKILL');
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderrSize += chunk.length; if (stderrSize > 64 * 1024) child.kill('SIGKILL'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > 2 * 1024 * 1024 || stderrSize > 64 * 1024)
        reject(new Error('document_ocr_paddle_failed'));
      else resolve(Buffer.concat(output).toString('utf8'));
    });
    if (bytes) child.stdin.end(bytes);
    else child.stdin.end();
  });
}

export async function paddleCapability() {
  try { return JSON.parse(await run(['--check'], null, 15_000)).ready === true; }
  catch { return false; }
}

export function normalizePaddleResult(result, maxPages) {
  if (!result || !Array.isArray(result.pages) || !result.pages.length || result.pages.length > maxPages)
    throw new Error('document_ocr_paddle_result_invalid');
  const pages = result.pages.map((page, index) => {
    if (page.page !== index + 1 || !Array.isArray(page.lines) || page.lines.length > 5000)
      throw new Error('document_ocr_paddle_result_invalid');
    const lines = page.lines.map((line) => {
      if (typeof line.text !== 'string' || line.text.length > 2000
        || !Array.isArray(line.box) || line.box.length !== 4
        || line.box.some((value) => !Number.isInteger(value) || value < 0 || value > 1000))
        throw new Error('document_ocr_paddle_result_invalid');
      return line;
    });
    return { page: page.page, text: lines.map((line) => line.text).join('\n'), lines };
  });
  if (pages.reduce((sum, page) => sum + page.text.length, 0) > 160_000)
    throw new Error('document_ocr_text_limit');
  const candidates = new Map();
  for (const page of pages) {
    const lines = page.text.split('\n').map((line) => line.replace(/\s+/g, '').toUpperCase());
    for (let index = 0; index + 1 < lines.length; index += 1) {
      const pair = lines.slice(index, index + 2);
      if (parseTd3Mrz(pair).integrity_status === 'Passed') candidates.set(pair.join('\n'), { page: page.page, lines: pair });
    }
  }
  const verifiedMrz = candidates.size === 1 ? [...candidates.values()][0] : null;
  if (verifiedMrz) {
    const page = pages.find((item) => item.page === verifiedMrz.page);
    page.text += `\nMRZ line 1: ${verifiedMrz.lines[0]}\nMRZ line 2: ${verifiedMrz.lines[1]}`;
  }
  return { pages, figures: [], verifiedMrz };
}

export async function analyzeDocumentWithPaddle({ bytes, mediaType, maxPages }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 25 * 1024 * 1024
    || !['application/pdf', 'image/png', 'image/jpeg'].includes(mediaType)
    || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50)
    throw new Error('document_ocr_paddle_input_invalid');
  let result;
  try { result = JSON.parse(await run([mediaType, String(maxPages)], bytes)); }
  catch { throw new Error('document_ocr_paddle_failed'); }
  return normalizePaddleResult(result, maxPages);
}
