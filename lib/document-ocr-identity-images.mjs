import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { parseTd1Mrz } from './icao-mrz.mjs';

const execFile = promisify(execFileCallback);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export function verifiedTd1FromText(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.toUpperCase().replace(/\s+/g, '')).filter(Boolean);
  const candidates = new Map();
  for (let index = 0; index + 2 < lines.length; index += 1) {
    const candidate = lines.slice(index, index + 3);
    if (candidate.some((line) => !/^[A-Z0-9<]{30}$/.test(line))) continue;
    if (parseTd1Mrz(candidate).integrity_status === 'Passed') candidates.set(candidate.join('\n'), candidate);
  }
  return { lines: candidates.size === 1 ? [...candidates.values()][0] : [], ambiguous: candidates.size > 1 };
}

async function normalizedJpeg(bytes) {
  const image = sharp(bytes, { limitInputPixels: 25_000_000 }).rotate();
  let output = await image.clone().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true }).toBuffer();
  if (output.length > MAX_IMAGE_BYTES) output = await image.clone()
    .resize({ width: 1500, height: 1500, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 68, mozjpeg: true }).toBuffer();
  if (!output.length || output.length > MAX_IMAGE_BYTES) throw new Error('document_ocr_identity_image_limit');
  return output;
}

export async function renderEmiratesIdPages({ bytes, mediaType, maxPages = 4, detectMrz = true }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 25 * 1024 * 1024
    || !['application/pdf', 'image/png', 'image/jpeg'].includes(mediaType)
    || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 4)
    throw new Error('document_ocr_identity_input_invalid');
  const work = await mkdtemp(join(tmpdir(), 'kycprobe-eid-'));
  try {
    let sourceFiles;
    if (mediaType === 'application/pdf') {
      const input = join(work, 'input.pdf');
      await writeFile(input, bytes, { mode: 0o600 });
      await execFile('pdftoppm', ['-f', '1', '-l', String(maxPages), '-scale-to', '1800',
        '-jpeg', '-jpegopt', 'quality=90', input, join(work, 'page')],
      { timeout: 60_000, maxBuffer: 64 * 1024 });
      sourceFiles = (await readdir(work)).filter((name) => /^page-\d+\.jpg$/.test(name))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    } else {
      sourceFiles = ['input-image'];
      await writeFile(join(work, sourceFiles[0]), bytes, { mode: 0o600 });
    }
    if (!sourceFiles.length || sourceFiles.length > maxPages) throw new Error('document_ocr_identity_render_invalid');
    const figures = [];
    const verified = new Map();
    let ambiguous = false;
    for (const [index, sourceFile] of sourceFiles.entries()) {
      const page = index + 1;
      const sourcePath = join(work, sourceFile);
      const imageBytes = await normalizedJpeg(await readFile(sourcePath));
      if (detectMrz) {
        const { stdout } = await execFile('tesseract', [sourcePath, 'stdout', '-l', 'eng', '--psm', '6',
          '-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<'],
        { timeout: 20_000, maxBuffer: 128 * 1024 });
        const mrz = verifiedTd1FromText(stdout);
        if (mrz.ambiguous) ambiguous = true;
        if (mrz.lines.length) verified.set(mrz.lines.join('\n'), { page, lines: mrz.lines });
      }
      figures.push({ id: `${page}.0`, page, sourceType: 'page', contentType: 'image/jpeg', bytes: imageBytes });
    }
    if (figures.reduce((total, item) => total + item.bytes.length, 0) > MAX_TOTAL_BYTES)
      throw new Error('document_ocr_identity_image_limit');
    return { figures, verifiedMrz: !ambiguous && verified.size === 1 ? [...verified.values()][0] : null,
      mrzAmbiguous: ambiguous || verified.size > 1 };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function cropIdentityRegion(imageBytes, box) {
  const image = sharp(imageBytes, { limitInputPixels: 25_000_000 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || !box
    || ![box.x1, box.y1, box.x2, box.y2].every((value) => Number.isInteger(value) && value >= 0 && value <= 1000)
    || box.x1 >= box.x2 || box.y1 >= box.y2 || (box.x2 - box.x1) * (box.y2 - box.y1) > 250_000)
    throw new Error('document_ocr_identity_crop_invalid');
  const left = Math.floor(metadata.width * box.x1 / 1000);
  const top = Math.floor(metadata.height * box.y1 / 1000);
  const right = Math.min(metadata.width, Math.ceil(metadata.width * box.x2 / 1000));
  const bottom = Math.min(metadata.height, Math.ceil(metadata.height * box.y2 / 1000));
  if (right - left < 10 || bottom - top < 10) throw new Error('document_ocr_identity_crop_invalid');
  const output = await image.extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
  if (!output.length || output.length > MAX_IMAGE_BYTES) throw new Error('document_ocr_identity_crop_invalid');
  return output;
}
