import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { analyzeDocumentWithAzure } from '../lib/azure-document-ocr.mjs';
import { mrzCheckDigit } from '../lib/icao-mrz.mjs';

const endpoint = 'https://doc-ai7uae-ocr-uaen-001.cognitiveservices.azure.com/';
const location = `${endpoint}documentintelligence/documentModels/prebuilt-layout/analyzeResults/123e4567-e89b-12d3-a456-426614174000?api-version=2024-11-30`;

test('Azure Layout uses managed identity, validates its operation URL, and deletes the result', async () => {
  const methods = [];
  const fetched = async (url, options) => {
    methods.push(options.method);
    assert.equal(options.headers.authorization, 'Bearer synthetic-managed-token');
    if (options.method === 'POST') {
      assert.match(String(url), /prebuilt-layout:analyze/);
      return new Response(null, { status: 202, headers: { 'operation-location': location } });
    }
    assert.equal(String(url), location);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ status: 'succeeded', analyzeResult: { modelId: 'prebuilt-layout',
      pages: [{ pageNumber: 1, lines: [{ content: 'License Number TL-123' }] }], tables: [] } }), { status: 200 });
  };
  const output = await analyzeDocumentWithAzure({ bytes: Buffer.from('\x89PNG\r\n\x1a\n', 'binary'), mediaType: 'image/png',
    maxPages: 1, endpoint, region: 'uaenorth', approvedRegion: 'uaenorth',
    credential: { getToken: async () => ({ token: 'synthetic-managed-token' }) }, fetchImpl: fetched, pause: async () => {} });
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
  assert.equal(output.pages[0].text, 'License Number TL-123');
});

test('the passport model appends its exact two MRZ lines as cited OCR evidence', async () => {
  const first = `P<UTO${'SAMPLE<<ALEX'.padEnd(39, '<')}`;
  const number = 'AB1234567';
  const birth = '900101';
  const expiry = '300101';
  const prefix = number + mrzCheckDigit(number) + 'UTO' + birth + mrzCheckDigit(birth)
    + 'M' + expiry + mrzCheckDigit(expiry) + '<'.repeat(14) + '<';
  const second = prefix + mrzCheckDigit(prefix.slice(0, 10) + prefix.slice(13, 20) + prefix.slice(21, 43));
  const passportLocation = location.replaceAll('prebuilt-layout', 'prebuilt-idDocument');
  const methods = [];
  const fetched = async (url, options) => {
    methods.push(options.method);
    if (options.method === 'POST') {
      assert.match(String(url), /prebuilt-idDocument:analyze/);
      return new Response(null, { status: 202, headers: { 'operation-location': passportLocation } });
    }
    assert.equal(String(url), passportLocation);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ status: 'succeeded', analyzeResult: { modelId: 'prebuilt-idDocument',
      pages: [{ pageNumber: 1, lines: [{ content: 'PASSPORT' }] }], documents: [{ docType: 'idDocument.passport',
        boundingRegions: [{ pageNumber: 1 }], fields: { MachineReadableZone: { content: `${first}\n${second}` } } }] } }), { status: 200 });
  };
  const output = await analyzeDocumentWithAzure({ bytes: Buffer.from('image'), mediaType: 'image/jpeg',
    maxPages: 1, endpoint, region: 'uaenorth', approvedRegion: 'uaenorth', model: 'prebuilt-idDocument',
    credential: { getToken: async () => ({ token: 'synthetic-managed-token' }) }, fetchImpl: fetched });
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
  assert.match(output.pages[0].text, new RegExp(`MRZ line 1: ${first}`));
  assert.match(output.pages[0].text, new RegExp(`MRZ line 2: ${second}`));
  assert.deepEqual(output.verifiedMrz, { page: 1, lines: [first, second] });
  assert.equal(output.model, 'prebuilt-idDocument:2024-11-30');
});

test('page and region gates reject before making an Azure call', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage(); pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('unexpected request'); };
  const base = { bytes, mediaType: 'application/pdf', maxPages: 1, endpoint,
    region: 'uaenorth', approvedRegion: 'uaenorth', fetchImpl };
  await assert.rejects(analyzeDocumentWithAzure(base), /document_ocr_page_limit/);
  await assert.rejects(analyzeDocumentWithAzure({ ...base, region: 'eastus' }), /document_ocr_azure_endpoint_invalid/);
  assert.equal(calls, 0);
});

test('a foreign operation URL is refused and not fetched', async () => {
  let calls = 0;
  await assert.rejects(analyzeDocumentWithAzure({ bytes: Buffer.from('synthetic'), mediaType: 'image/jpeg',
    maxPages: 1, endpoint, region: 'uaenorth', approvedRegion: 'uaenorth',
    credential: { getToken: async () => ({ token: 'synthetic-managed-token' }) },
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 202,
      headers: { 'operation-location': 'https://other.example/result' } }); } }), /operation_url_invalid/);
  assert.equal(calls, 1);
});

test('Emirates ID figure crop is collected before Azure result deletion', async () => {
  const calls = [];
  const fetched = async (url, options) => {
    calls.push([options.method, String(url)]);
    if (options.method === 'POST') {
      assert.match(String(url), /output=figures/);
      return new Response(null, { status: 202, headers: { 'operation-location': location } });
    }
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    if (String(url).includes('/figures/')) return new Response(Buffer.from('png-bytes'), {
      status: 200, headers: { 'content-type': 'image/png' }
    });
    return new Response(JSON.stringify({ status: 'succeeded', analyzeResult: { modelId: 'prebuilt-layout',
      pages: [{ pageNumber: 1, lines: [{ content: 'ID 784-1234' }] }],
      figures: [{ id: '1.1', boundingRegions: [{ pageNumber: 1 }] }] } }), { status: 200 });
  };
  const output = await analyzeDocumentWithAzure({ bytes: Buffer.from('jpeg'), mediaType: 'image/jpeg', maxPages: 1,
    endpoint, region: 'uaenorth', approvedRegion: 'uaenorth', includeFigures: true,
    credential: { getToken: async () => ({ token: 'synthetic-managed-token' }) }, fetchImpl: fetched });
  assert.deepEqual(calls.map(([method]) => method), ['POST', 'GET', 'GET', 'DELETE']);
  assert.equal(output.figures[0].id, '1.1');
  assert.equal(output.figures[0].bytes.toString(), 'png-bytes');
});
