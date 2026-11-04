import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.PEPPOL_GLOBAL_TABLE_URL = 'https://example.table.core.windows.net';
const apiKey = 'peppol_test_api_key';
const adminKey = 'peppol_test_admin_key';
process.env.AI7_API_KEY_HASHES = createHash('sha256').update(apiKey).digest('hex');
process.env.AI7_ADMIN_KEY_HASHES = createHash('sha256').update(adminKey).digest('hex');
const { createAppServer } = await import('../server.mjs');
const { EnvironmentStore } = await import('../lib/api-store.mjs');

const calls = [];
let app;
let base;
before(async () => {
  app = createAppServer({ store: new EnvironmentStore(),
    peppolGlobalLookup: async (input) => {
      calls.push(input);
      return { status: 'name_match', source: 'peppol_directory_export', queried_name: input.name,
        country: input.country, checked_at: '2026-11-04T00:00:00Z', snapshot_at: '2026-11-03T02:02:45Z',
        returned_count: 1, truncated: false, matches: [{ participant_id: { value: '0002:123' } }] };
    },
    peppolCountryList: async () => ({ status: 'ready', snapshot_at: '2026-11-03T02:02:45Z', cards: 2,
      countries: [{ code: 'AE', count: 1 }, { code: 'FR', count: 1 }] }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => new Promise((resolve) => app.close(resolve)));

test('public Peppol API requires a key and passes optional ISO country to lookup', async () => {
  const missing = await fetch(`${base}/service/peppol_check`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Example Company' }) });
  assert.equal(missing.status, 401);
  const filtered = await fetch(`${base}/service/peppol_check`, { method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Example Company', country: 'ae' }) });
  assert.equal(filtered.status, 200);
  assert.deepEqual(calls.at(-1), { name: 'Example Company', country: 'AE' });
  assert.equal((await filtered.json()).matches[0].participant_id.value, '0002:123');
  const global = await fetch(`${base}/service/peppol_check`, { method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Example Company' }) });
  assert.equal(global.status, 200);
  assert.equal(calls.at(-1).country, null);
  const invalid = await fetch(`${base}/service/peppol_check`, { method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Example Company', country: 'UAE' }) });
  assert.equal(invalid.status, 400);
});

test('admin Peppol search and country dropdown routes use the same indexed lookup', async () => {
  const countries = await fetch(`${base}/admin/api/peppol/countries`, { headers: { authorization: `Bearer ${adminKey}` } });
  assert.equal(countries.status, 200);
  assert.deepEqual((await countries.json()).countries.map((item) => item.code), ['AE', 'FR']);
  const result = await fetch(`${base}/admin/api/peppol/search`, { method: 'POST',
    headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Example Company', country: 'FR' }) });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.at(-1), { name: 'Example Company', country: 'FR' });
});
