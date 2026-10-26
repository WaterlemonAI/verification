import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptBsa, encryptBsa } from './bsa-crypto.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const base = () => process.env.BSA_DATA_DIR || join(process.cwd(), '.local-bsa');
const pathFor = (id) => join(base(), 'jobs', id);

export function bsaLocalEnabled() {
  return process.env.BSA_LOCAL_ENABLED === '1' && process.env.NODE_ENV !== 'production';
}

export async function createBsaJob({ ownerId, idempotencyKey, files, fields }) {
  await mkdir(join(base(), 'jobs'), { recursive: true, mode: 0o700 });
  await mkdir(join(base(), 'keys'), { recursive: true, mode: 0o700 });
  const fileHashes = files.map(({ bytes, mediaType }) => ({ hash: digest(bytes), mediaType }));
  const requestHash = digest(JSON.stringify({ fileHashes, fields }));
  const keyPath = join(base(), 'keys', digest(`${ownerId}:${idempotencyKey}`));
  let keyHandle;
  try { keyHandle = await open(keyPath, 'wx', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let prior;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { prior = JSON.parse(await readFile(keyPath, 'utf8')); break; } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!prior) throw new Error('idempotency_unavailable');
    if (prior.requestHash !== requestHash) throw new Error('idempotency_conflict');
    return { job: await getBsaJob(prior.id, ownerId), reused: true };
  }
  const id = `bsa_${randomUUID()}`;
  const directory = pathFor(id);
  const job = { id, ownerId, status: 'queued', receivedAt: new Date().toISOString(),
    fileHashes, schemaVersion: 'bsa-v1.0.0', encrypted: true };
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
    for (const [index, item] of files.entries()) {
      await writeFile(join(directory, `input-${index}.bin`), encryptBsa(item.bytes), { mode: 0o600 });
    }
    await writeFile(join(directory, 'fields.bin'), encryptBsa(Buffer.from(JSON.stringify(fields))), { mode: 0o600 });
    await writeFile(join(directory, 'inputs.json'), JSON.stringify(files.map(({ mediaType }, index) => ({ index, mediaType }))), { mode: 0o600 });
    await writeFile(join(directory, 'job.json'), JSON.stringify(job), { mode: 0o600 });
    await writeFile(join(directory, 'queued'), '', { mode: 0o600 });
    await keyHandle.writeFile(JSON.stringify({ id, requestHash }));
  } catch (error) {
    await rm(keyPath, { force: true });
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally { await keyHandle.close(); }
  return { job, reused: false };
}

export async function getBsaJob(id, ownerId) {
  if (!/^bsa_[0-9a-f-]{36}$/.test(id)) return null;
  let job;
  try { job = JSON.parse(await readFile(join(pathFor(id), 'job.json'), 'utf8')); } catch { return null; }
  if (job.ownerId !== ownerId) return null;
  return job;
}

export async function getBsaResult(id, ownerId) {
  const job = await getBsaJob(id, ownerId);
  if (!job) return null;
  if (!['completed', 'partial', 'failed'].includes(job.status)) return { job };
  try { return { job, result: JSON.parse(decryptBsa(await readFile(join(pathFor(id), 'result.bin')))) }; }
  catch {
    // Older local demo jobs used plaintext result.json; preserve access without writing more.
    try { return { job, result: JSON.parse(await readFile(join(pathFor(id), 'result.json'), 'utf8')) }; }
    catch { return { job }; }
  }
}

export async function getBsaArtifact(id, ownerId, filename) {
  if (!['ledger.json', 'transactions.parquet', 'audit.pdf', 'analysis.xlsx'].includes(filename)) return null;
  const record = await getBsaResult(id, ownerId);
  if (!record?.result?.artifacts?.some((item) => item.filename === filename)) return null;
  try { return decryptBsa(await readFile(join(pathFor(id), `artifact.${filename}.bin`))); }
  catch { return null; }
}

export async function updateBsaJob(id, patch) {
  const directory = pathFor(id);
  const job = JSON.parse(await readFile(join(directory, 'job.json'), 'utf8'));
  const next = { ...job, ...patch };
  const temp = join(directory, `job.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
  await rename(temp, join(directory, 'job.json'));
  return next;
}
