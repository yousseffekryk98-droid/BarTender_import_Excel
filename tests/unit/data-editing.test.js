import test from 'node:test';
import assert from 'node:assert/strict';
import { removeWorkingRows, removeWorkingColumn, editWorkingRow } from '../../src/data/editing.js';
import { createTemplate, createObject } from '../../src/engine/schema.js';
import { buildLabel, renderLabelHtml, printDocumentHtml } from '../../src/engine/render.js';

const data = () => ({
  headers: ['Product Name', 'Price', 'Unused'],
  records: [
    { id: '2', rowNumber: 2, cells: ['Wireless Mouse', '325', 'x'], raw: [{ t: 's', v: 'Wireless Mouse' }, { t: 'n', v: 325 }, null] },
    { id: '3', rowNumber: 3, cells: ['Keyboard', '150', 'y'], raw: [{ t: 's', v: 'Keyboard' }, { t: 'n', v: 150 }, null] }
  ]
});

test('removing imported rows only changes working data; source stays unchanged', () => {
  const original = data();
  const edited = removeWorkingRows(original, ['2']);
  assert.deepEqual(edited.records.map((r) => r.id), ['3']);
  assert.deepEqual(original.records.map((r) => r.id), ['2', '3']);
});
test('removing imported columns keeps each row aligned, without touching original', () => {
  const original = data();
  const withoutPrice = removeWorkingColumn(original, 1);
  assert.deepEqual(withoutPrice.headers, ['Product Name', 'Unused']);
  assert.deepEqual(withoutPrice.records[1].cells, ['Keyboard', 'y']);
  assert.deepEqual(withoutPrice.records[0].raw, [{ t: 's', v: 'Wireless Mouse' }, null]);
  assert.deepEqual(original.headers, ['Product Name', 'Price', 'Unused']);
  assert.throws(() => removeWorkingColumn(original, 3), /Invalid Excel column/);
});
test('editing one row and text override affects print data, never the next row or original', () => {
  const original = data();
  const field = createObject('text', { name: 'Price', content: { mode: 'field', field: 'Price' }, prefix: 'Price: ', suffix: ' EGP' });
  const staticText = createObject('text', { name: 'Footer', content: { mode: 'static', text: 'Thank you' } });
  const template = createTemplate({ page: { width: 20, height: 30 }, objects: [field, staticText] });
  const changed = editWorkingRow(original, '2', ['Mouse renamed', '400', 'x'], { [staticText.id]: 'Hello only Mouse' });
  assert.equal(changed.records[0].raw[1], null, 'edited numeric value must not use stale typed Excel value');
  assert.equal(changed.records[1].cells[1], '150');
  assert.equal(original.records[0].cells[1], '325');
  const a = buildLabel(template, { headers: changed.headers, record: changed.records[0] });
  const b = buildLabel(template, { headers: changed.headers, record: changed.records[1] });
  assert.deepEqual(a.items.map((item) => item.text), ['Price: 400 EGP', 'Hello only Mouse']);
  assert.deepEqual(b.items.map((item) => item.text), ['Price: 150 EGP', 'Thank you']);
  assert.match(renderLabelHtml(template, a), /Hello only Mouse/);
  assert.doesNotMatch(renderLabelHtml(template, b), /Hello only Mouse/);
});
test('fine X offset is retained to thousandth millimetres in printable document', () => {
  const page = { width: 20, height: 30, offsetX: 0.02, offsetY: 0, printRotation: 0 };
  const doc = printDocumentHtml(['<article class="els-label">Test</article>'], page);
  assert.match(doc, /translate\(0\.02mm,0mm\)/);
});
