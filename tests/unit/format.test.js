import test from 'node:test';
import assert from 'node:assert/strict';
import { toNumber, parseDateValue, formatDatePattern, formatNumber, applyNumberPattern, formatValue, normalizeDigits, excelSerialToDate } from '../../src/engine/format.js';
import { formatExcelNumber, displayNumber, excelDateToPattern, isDateFormat, generalNumber, precisionRisk } from '../../src/data/excel-format.js';

test('toNumber accepts spreadsheet-style numbers and rejects text', () => {
  assert.equal(toNumber('1,234.50'), 1234.5);
  assert.equal(toNumber('EGP 325'), 325);
  assert.equal(toNumber('325 ج.م'), 325);
  assert.equal(toNumber('15%'), 0.15);
  assert.equal(toNumber('(12)'), -12);
  assert.equal(toNumber('٣٢٥'), 325);
  assert.equal(toNumber('1e3'), 1000);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber('12-34'), null);
  assert.equal(toNumber(''), null);
  assert.equal(normalizeDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
});

test('parseDateValue handles ISO, day-first, month names and rejects impossible dates', () => {
  const iso = (d) => d && d.toISOString().slice(0, 16);
  assert.equal(iso(parseDateValue('2026-10-19')), '2026-10-19T00:00');
  assert.equal(iso(parseDateValue('2026-10-19 14:30')), '2026-10-19T14:30');
  assert.equal(iso(parseDateValue('19/10/2026')), '2026-10-19T00:00');
  assert.equal(iso(parseDateValue('10/19/2026', 'MDY')), '2026-10-19T00:00');
  assert.equal(iso(parseDateValue('19-Oct-2026')), '2026-10-19T00:00');
  assert.equal(iso(parseDateValue('Oct 19, 2026')), '2026-10-19T00:00');
  assert.equal(iso(parseDateValue('19.10.26')), '2026-10-19T00:00');
  assert.equal(iso(parseDateValue('5/1/2026 3:05 PM')), '2026-01-05T15:05');
  assert.equal(parseDateValue('31/02/2026'), null);
  assert.equal(parseDateValue('19/13/2026'), null);
  assert.equal(parseDateValue('hello'), null);
  assert.equal(iso(excelSerialToDate(46314)), '2026-10-19T00:00');
});

test('date patterns, including Arabic month names', () => {
  const d = new Date(Date.UTC(2026, 9, 5, 9, 7, 3));
  assert.equal(formatDatePattern(d, 'dd/MM/yyyy HH:mm:ss'), '05/10/2026 09:07:03');
  assert.equal(formatDatePattern(d, 'd MMM yy'), '5 Oct 26');
  assert.equal(formatDatePattern(d, "dddd, d MMMM yyyy 'at' h:mm tt"), 'Monday, 5 October 2026 at 9:07 AM');
  assert.match(formatDatePattern(d, 'MMMM', 'ar'), /أكتوبر|اكتوبر/);
});

test('number formatting and Excel-style patterns', () => {
  assert.equal(formatNumber(1234.5, { decimals: 2, thousands: true }), '1,234.50');
  assert.equal(formatNumber(-0.004, { decimals: 2 }), '0.00');
  assert.equal(formatNumber(7, { minInteger: 4 }), '0007');
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  assert.equal(applyNumberPattern(42, '000000'), '000042');
  assert.equal(applyNumberPattern(1234.5, '#,##0.00'), '1,234.50');
  assert.equal(applyNumberPattern(0.125, '0.0%'), '12.5%');
  assert.equal(applyNumberPattern(325, '"EGP "#,##0'), 'EGP 325');
  assert.equal(applyNumberPattern(325, '[$EGP] #,##0.00'), 'EGP 325.00');
  assert.equal(applyNumberPattern(325, '#,##0.00 [$ج.م.-3801]'), '325.00 ج.م.');
});

test('formatValue kinds, case, digits and empty text', () => {
  assert.equal(formatValue('325', { kind: 'currency', currencySymbol: 'EGP' }), '325.00 EGP');
  assert.equal(formatValue('1234', { kind: 'currency', currencySymbol: 'EGP', thousands: true }), '1,234.00 EGP');
  assert.equal(formatValue('325', { kind: 'currency', currencySymbol: '$', symbolPosition: 'before' }), '$325.00');
  assert.equal(formatValue('0.155', { kind: 'percent', decimals: 1 }), '15.5%');
  assert.equal(formatValue('1234567', { kind: 'number', thousands: true, decimals: 0 }), '1,234,567');
  assert.equal(formatValue('19/10/2026', { kind: 'date', datePattern: 'yyyy-MM-dd' }), '2026-10-19');
  assert.equal(formatValue('not a date', { kind: 'date' }), 'not a date');
  assert.equal(formatValue('mouse pad', { case: 'title' }), 'Mouse Pad');
  assert.equal(formatValue('SN 123', { digits: 'arabic' }), 'SN ١٢٣');
  assert.equal(formatValue('', { emptyText: 'N/A' }), 'N/A');
  assert.equal(formatValue('00123', { kind: 'none' }), '00123');
});

test('Excel display formats are rendered like Excel', () => {
  assert.equal(formatExcelNumber(1234.5, '#,##0.00'), '1,234.50');
  assert.equal(formatExcelNumber(-1234.5, '#,##0.00;(#,##0.00)'), '(1,234.50)');
  assert.equal(formatExcelNumber(42, '000000'), '000042');
  assert.equal(formatExcelNumber(0.15, '0%'), '15%');
  assert.equal(formatExcelNumber(0.30000000000000004, 'General'), '0.3');
  assert.equal(formatExcelNumber(1234.5678, '0.00E+00'), '1.23E+03');
  assert.equal(formatExcelNumber(325, '"EGP"#,##0'), 'EGP325');
  assert.equal(generalNumber(123456789012345), '123456789012345');
  assert.equal(precisionRisk(1234567890123456), true);
  assert.equal(precisionRisk(123456789012345), false);
  assert.equal(isDateFormat('dd/mm/yyyy'), true);
  assert.equal(isDateFormat('#,##0.00'), false);
  assert.equal(isDateFormat('[$-409]mmm d, yyyy'), true);
  assert.equal(isDateFormat('"Days" 0'), false);
  assert.equal(excelDateToPattern('d-mmm-yy'), 'd-MMM-yy');
  assert.equal(excelDateToPattern('hh:mm:ss'), 'HH:mm:ss');
  assert.equal(excelDateToPattern('h:mm AM/PM'), 'h:mm tt');
  assert.equal(excelDateToPattern('mm-dd-yy'), 'dd/MM/yyyy');
  assert.equal(displayNumber(46314, 'dd/mm/yyyy').text, '19/10/2026');
  assert.deepEqual(displayNumber(46314, 'dd/mm/yyyy').raw.t, 'd');
});
