import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { cropIdentityRegion, verifiedTd1FromText } from '../lib/document-ocr-identity-images.mjs';
import { mrzCheckDigit } from '../lib/icao-mrz.mjs';

function syntheticTd1() {
  const number = 'AB1234567';
  const upper = `I<UTO${number}${mrzCheckDigit(number)}`.padEnd(30, '<');
  const birth = '900101';
  const expiry = '300101';
  const middlePrefix = `${birth}${mrzCheckDigit(birth)}M${expiry}${mrzCheckDigit(expiry)}UTO${'<'.repeat(11)}`;
  const composite = mrzCheckDigit(upper.slice(5, 30) + middlePrefix.slice(0, 7)
    + middlePrefix.slice(8, 15) + middlePrefix.slice(18, 29));
  return [upper, middlePrefix + composite, 'SAMPLE<<ALEX'.padEnd(30, '<')];
}

test('local MRZ OCR accepts only one complete checksum-valid TD1 sequence', () => {
  const lines = syntheticTd1();
  const text = `CARD NUMBER\n${lines.join('\n')}\nEND`;
  assert.deepEqual(verifiedTd1FromText(text).lines, lines);
  const invalid = [...lines];
  invalid[1] = `${lines[1].slice(0, 6)}X${lines[1].slice(7)}`;
  assert.deepEqual(verifiedTd1FromText(invalid.join('\n')).lines, []);
});

test('identity crops are tight and never return a full card', async () => {
  const page = await sharp({ create: { width: 400, height: 200, channels: 3,
    background: { r: 250, g: 250, b: 250 } } }).jpeg().toBuffer();
  const crop = await cropIdentityRegion(page, { x1: 100, y1: 200, x2: 250, y2: 600 });
  const meta = await sharp(crop).metadata();
  assert.equal(meta.width, 60);
  assert.equal(meta.height, 80);
  await assert.rejects(cropIdentityRegion(page, { x1: 0, y1: 0, x2: 1000, y2: 1000 }), /crop_invalid/);
});
