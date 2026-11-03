import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { searchPeppolIndex, tradeLicenseName, tradeLicenseOcrName } from '../lib/peppol-index.mjs';

test('local UAE export index returns exact business-card evidence without a network call', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'peppol-index-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true, force: true }); });
  const indexPath = join(directory, 'uae.jsonl');
  await writeFile(indexPath, [
    JSON.stringify({ _meta: { schema_version: 1, source: 'peppol_directory_export', country: 'AE',
      snapshot_at: '2026-11-03T02:00:00Z' } }),
    JSON.stringify({ participant_id: { scheme: 'iso6523-actorid-upis', value: '0235:123' },
      document_types: [{ scheme: 'busdox-docid-qns', value: 'Invoice', display_name: 'Peppol Invoice' }],
      entities: [{ names: [{ name: 'Example LLC', language: 'en' }], country_code: 'AE',
        websites: ['https://example.test'], registration_date: '2026-10-01' }] }),
    JSON.stringify({ _footer: { cards: 1 } })
  ].join('\n') + '\n');
  assert.equal(tradeLicenseName({ uae_tl_verification: { licence_registration_name: 'Example L.L.C.' } }), 'Example L.L.C.');
  assert.equal(tradeLicenseOcrName({ company_name_english: 'Not Found', company_name_arabic: 'شركة المثال' }), 'شركة المثال');
  const result = await searchPeppolIndex('Example L.L.C.', { indexPath });
  assert.equal(result.status, 'name_match');
  assert.equal(result.snapshot_at, '2026-11-03T02:00:00Z');
  assert.equal(result.matches[0].participant_id.value, '0235:123');
  assert.equal(result.matches[0].document_types[0].display_name, 'Peppol Invoice');
  assert.equal(result.matches[0].entities[0].registration_date, '2026-10-01');
  assert.equal((await searchPeppolIndex('Unrelated Company', { indexPath })).status, 'not_found');
});

test('missing extracted names and missing indexes are explicit', async () => {
  assert.equal((await searchPeppolIndex('Not Found')).status, 'name_unavailable');
  const result = await searchPeppolIndex('Example Company', { indexPath: '/missing/peppol-index.jsonl' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason_code, 'index_unavailable');
});

test('private Blob index is loaded once and searched locally on subsequent requests', async () => {
  const lines = [
    { _meta: { schema_version: 1, source: 'peppol_directory_export', country: 'AE', snapshot_at: '2026-11-03T02:00:00Z' } },
    { participant_id: { scheme: 'iso6523-actorid-upis', value: '0235:456' }, document_types: [],
      entities: [{ names: [{ name: 'Sample Trading LLC' }], country_code: 'AE' }] },
    { _footer: { cards: 1 } }
  ].map((value) => JSON.stringify(value)).join('\n') + '\n';
  let downloads = 0;
  const blobClient = { getProperties: async () => ({ etag: 'sample-v1' }),
    download: async () => { downloads += 1; return { readableStreamBody: Readable.from([lines]) }; } };
  const options = { blobClient };
  const first = await searchPeppolIndex('Sample Trading LLC', options);
  const second = await searchPeppolIndex('Sample Trading LLC', options);
  assert.equal(first.matches[0].participant_id.value, '0235:456');
  assert.equal(second.status, 'name_match');
  assert.equal(downloads, 1);
});
