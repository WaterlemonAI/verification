import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mrzCheckDigit, parseTd1Mrz, parseTd3Mrz } from '../lib/icao-mrz.mjs';

function td3() {
  const upper = `P<UTO${'SAMPLE<<ALEX'.padEnd(39, '<')}`;
  const passport = 'AB1234567';
  const birth = '900101';
  const expiry = '300101';
  const personal = '<'.repeat(14);
  const lowerPrefix = passport + mrzCheckDigit(passport) + 'UTO' + birth + mrzCheckDigit(birth)
    + 'M' + expiry + mrzCheckDigit(expiry) + personal + '<';
  const composite = mrzCheckDigit(lowerPrefix.slice(0, 10) + lowerPrefix.slice(13, 20) + lowerPrefix.slice(21, 43));
  return [upper, lowerPrefix + composite];
}

test('ICAO check digit uses 7-3-1 character weights', () => {
  assert.equal(mrzCheckDigit('520727'), '3');
  assert.equal(mrzCheckDigit('AB2134<<<'), '5');
  assert.throws(() => mrzCheckDigit('A-B'), /invalid_mrz_characters/);
});

test('TD3 checks include expiry in the composite and permit an unused personal-number filler', () => {
  const lines = td3();
  const parsed = parseTd3Mrz(lines);
  assert.equal(parsed.integrity_status, 'Passed');
  assert.equal(parsed.fields.passport_number, 'AB1234567');
  assert.equal(parsed.checks.personal_number.status, 'Passed');
  const changedExpiry = `300102${mrzCheckDigit('300102')}`;
  const changed = `${lines[1].slice(0, 21)}${changedExpiry}${lines[1].slice(28)}`;
  const failed = parseTd3Mrz([lines[0], changed]);
  assert.equal(failed.checks.date_of_expiry.status, 'Passed');
  assert.equal(failed.checks.composite.status, 'FAILED');
  assert.equal(failed.integrity_status, 'FAILED');
});

test('invalid or incomplete MRZ is never reported as verified', () => {
  assert.equal(parseTd3Mrz(['P<UTO']).integrity_status, 'NOT_IDENTIFIED');
  assert.equal(parseTd1Mrz(['I<ARE']).integrity_status, 'NOT_IDENTIFIED');
});

test('TD1 extended document numbers use the optional-field digit without misreading it as ordinary data', () => {
  const number = '123456789ABCD';
  const upper = `I<ARE${number.slice(0, 9)}<${number.slice(9)}${mrzCheckDigit(number)}`.padEnd(30, '<');
  const birth = '900101';
  const expiry = '300101';
  const middlePrefix = `${birth}${mrzCheckDigit(birth)}M${expiry}${mrzCheckDigit(expiry)}ARE${'<'.repeat(11)}`;
  const composite = mrzCheckDigit(upper.slice(5, 30) + middlePrefix.slice(0, 7)
    + middlePrefix.slice(8, 15) + middlePrefix.slice(18, 29));
  const parsed = parseTd1Mrz([upper, middlePrefix + composite, 'SAMPLE<<ALEX'.padEnd(30, '<')]);
  assert.equal(parsed.integrity_status, 'Passed');
  assert.equal(parsed.fields.document_number, number);
  assert.equal(parsed.checks.document_number.status, 'Passed');
});
