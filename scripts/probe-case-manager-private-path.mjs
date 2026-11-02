import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BlobServiceClient } from '@azure/storage-blob';
import { TableClient } from '@azure/data-tables';
import { QueueClient } from '@azure/storage-queue';
import { ContainerAppsManagedIdentityCredential } from '../lib/azure-managed-identity.mjs';

export function addressInCidr(address, cidr) {
  const [base, bitsText] = String(cidr).split('/');
  const bits = Number(bitsText);
  if (isIP(address) !== 4 || isIP(base) !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toNumber = (value) => value.split('.').reduce((number, octet) => (number << 8) | Number(octet), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toNumber(address) & mask) === (toNumber(base) & mask);
}

export async function verifyCaseManagerPrivatePath({ blobUrl, tableUrl, queueUrl, endpointCidr,
  credential = new ContainerAppsManagedIdentityCredential(), resolve = lookup } = {}) {
  if (!blobUrl || !tableUrl || !queueUrl || !endpointCidr) throw new Error('private_probe_configuration_missing');
  for (const url of [blobUrl, tableUrl, queueUrl]) {
    const addresses = await resolve(new URL(url).hostname, { all: true });
    if (!addresses.length || !addresses.every(({ address }) => addressInCidr(address, endpointCidr))) {
      throw new Error('private_probe_dns_mismatch');
    }
  }
  const id = randomUUID();
  const blob = new BlobServiceClient(blobUrl, credential).getContainerClient('case-manager-probe')
    .getBlockBlobClient(`probe-${id}.txt`);
  const table = new TableClient(tableUrl, 'CaseManagerProbe', credential);
  const queue = new QueueClient(`${queueUrl.replace(/\/$/, '')}/case-manager-probe`, credential);
  let blobWritten = false;
  let tableWritten = false;
  try {
    await blob.uploadData(Buffer.from('private-path-ok'));
    blobWritten = true;
    if ((await blob.downloadToBuffer()).toString() !== 'private-path-ok') throw new Error('private_probe_blob_mismatch');
    await table.createEntity({ partitionKey: 'probe', rowKey: id, state: 'ok' });
    tableWritten = true;
    if ((await table.getEntity('probe', id)).state !== 'ok') throw new Error('private_probe_table_mismatch');
    const sent = await queue.sendMessage(`probe-${id}`, { messageTimeToLive: 60 });
    const received = await queue.receiveMessages({ numberOfMessages: 32, visibilityTimeout: 30 });
    const own = received.receivedMessageItems.find((item) => item.messageId === sent.messageId);
    if (!own) throw new Error('private_probe_queue_mismatch');
    await queue.deleteMessage(own.messageId, own.popReceipt);
    return { private_dns: true, blob: true, table: true, queue: true };
  } finally {
    if (tableWritten) await table.deleteEntity('probe', id).catch(() => {});
    if (blobWritten) await blob.deleteIfExists().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const result = await verifyCaseManagerPrivatePath({
      blobUrl: process.env.CASE_MANAGER_BLOB_URL,
      tableUrl: process.env.CASE_MANAGER_TABLE_URL,
      queueUrl: process.env.CASE_MANAGER_QUEUE_URL,
      endpointCidr: process.env.CASE_MANAGER_PRIVATE_ENDPOINT_CIDR
    });
    console.info('case_manager_private_path_verified', JSON.stringify(result));
  } catch {
    console.warn('case_manager_private_path_failed');
    process.exitCode = 1;
  }
}
