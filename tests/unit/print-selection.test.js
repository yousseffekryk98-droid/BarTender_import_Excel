import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPrintableRecords } from '../../src/engine/print-selection.js';

const rows = [
  { id: '2', rowNumber: 2 },
  { id: '3', rowNumber: 3 },
  { id: '4', rowNumber: 4 }
];

test('print grid defaults to all imported rows and allows individual opt-outs', () => {
  const checked = new Set(rows.map((record) => record.id));
  assert.deepEqual(selectPrintableRecords(rows, checked).map((r) => r.id), ['2', '3', '4']);
  checked.delete('3');
  assert.deepEqual(selectPrintableRecords(rows, checked).map((r) => r.id), ['2', '4']);
  checked.add('3');
  assert.equal(selectPrintableRecords(rows, checked).length, 3);
  checked.clear();
  assert.deepEqual(selectPrintableRecords(rows, checked), []);
});

test('current row / numeric range never bring unchecked rows back into print job', () => {
  const checked = new Set(['2', '4']);
  assert.deepEqual(selectPrintableRecords(rows, checked, 'current', '3'), []);
  assert.deepEqual(selectPrintableRecords(rows, checked, 'current', '4').map((r) => r.id), ['4']);
  assert.deepEqual(selectPrintableRecords(rows, checked, 'range', null, { from: 2, to: 3 }).map((r) => r.id), ['2']);
  assert.deepEqual(selectPrintableRecords(rows, checked, 'range', null, { from: 3, to: 4 }).map((r) => r.id), ['4']);
});
