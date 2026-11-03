import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { rowsForCard } from '../scripts/ingest-peppol-global.mjs';
import { peppolGlobalCountries, searchPeppolGlobal, validatePeppolSearchInput } from '../lib/peppol-global.mjs';

const snapshotAt = '2026-11-03T02:02:45Z';
const version = createHash('sha256').update(snapshotAt).digest('hex').slice(0, 8);

function mockTable(rows) {
  const filters = [];
  return {
    filters,
    async getEntity() { return { state: 'ready', snapshotAt, version, cards: 2,
      countriesJson: JSON.stringify([{ code: 'AE', count: 1 }, { code: 'FR', count: 1 }]) }; },
    listEntities({ queryOptions }) {
      const filter = String(queryOptions.filter);
      filters.push(filter);
      const partition = /PartitionKey eq '([^']+)'/.exec(filter)?.[1];
      const start = /RowKey ge '([^']+)'/.exec(filter)?.[1];
      const end = /RowKey lt '([^']+)'/.exec(filter)?.[1];
      return (async function* () {
        for (const row of rows) if (row.partitionKey === partition && row.rowKey >= start && row.rowKey < end) yield row;
      })();
    }
  };
}

test('global index narrows the key range by ISO country and returns published fields', async () => {
  const source = { participant_id: { scheme: 'iso6523-actorid-upis', value: '0002:123' },
    document_types: [{ scheme: 'busdox-docid-qns', value: 'Invoice', display_name: 'Peppol Invoice' }],
    entities: [{ names: [{ name: 'Example Trading LLC' }], country_code: 'AE', websites: ['https://example.test'] },
      { names: [{ name: 'Example Trading LLC' }], country_code: 'FR', registration_date: '2025-01-01' }] };
  const table = mockTable(rowsForCard(source, version));
  const global = await searchPeppolGlobal({ name: 'Example Trading L.L.C.' }, { table });
  assert.equal(global.status, 'name_match');
  assert.equal(global.matches.length, 2);
  assert.equal(global.matches[0].document_types[0].display_name, 'Peppol Invoice');
  const uae = await searchPeppolGlobal({ name: 'Example Trading LLC', country: 'AE' }, { table });
  assert.equal(uae.matches.length, 1);
  assert.equal(uae.matches[0].country_code, 'AE');
  assert.equal(uae.matches[0].entities[0].websites[0], 'https://example.test');
  assert.match(table.filters[1], /_AE_/);
  assert.equal((await searchPeppolGlobal({ name: 'Example Trading LLC', country: 'US' }, { table })).status, 'not_found');
  assert.deepEqual((await peppolGlobalCountries({ table })).countries.map((item) => item.code), ['AE', 'FR']);
});

test('global search validates names and two-letter countries', () => {
  assert.deepEqual(validatePeppolSearchInput({ name: ' Acme ', country: 'ae' }), { name: 'Acme', country: 'AE' });
  assert.throws(() => validatePeppolSearchInput({ name: 'Acme', country: 'UAE' }), /two-letter/);
  assert.throws(() => validatePeppolSearchInput({ name: '  ' }), /Name must/);
});

test('XML stream includes all countries and supports resuming after a card count', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'peppol-global-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'sample.xml');
  const namespace = 'urn:peppol:schema:pd:businesscard-generic:2025:03';
  await writeFile(source, `<root xmlns="${namespace}" version="3" creationdt="${snapshotAt}">`
    + '<businesscard><participant scheme="test" value="1"/><entity countrycode="AE"><name name="UAE Company"/></entity></businesscard>'
    + '<businesscard><participant scheme="test" value="2"/><entity countrycode="FR"><name name="French Company"/></entity></businesscard>'
    + '</root>');
  const result = spawnSync('python3', ['scripts/build-peppol-uae-index.py', '--stream-all', '--skip-cards', '1', source],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0]._meta.country, null);
  assert.equal(lines[1].entities[0].country_code, 'FR');
  assert.equal(lines[2]._footer.cards, 2);
});
