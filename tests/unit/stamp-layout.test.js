import test from 'node:test';
import assert from 'node:assert/strict';
import { createObject, createTemplate, sanitizeTemplate } from '../../src/engine/schema.js';
import { makeContext, resolveText, templateFieldNames } from '../../src/engine/binding.js';
import { buildLabel, renderLabelHtml } from '../../src/engine/render.js';

const stamp = createTemplate({
  name: 'Reusable Price Stamp',
  category: 'Stamps',
  page: { width: 20, height: 30 },
  objects: [
    createObject('text', { x: 1, y: 1, width: 18, height: 7, name: 'Fixed heading',
      content: { mode: 'static', text: 'Price tag' } }),
    createObject('text', { x: 1, y: 10, width: 18, height: 8, name: 'Dynamic price',
      content: { mode: 'field', field: 'Price' }, prefix: 'Price: ', suffix: ' EGP' }),
    createObject('text', { x: 1, y: 20, width: 18, height: 8, name: 'Name beside text',
      content: { mode: 'template', template: 'Item: {Name}' } })
  ]
});

test('saved stamp preserves physical layout, typed words and live column bindings', () => {
  const stored = sanitizeTemplate(JSON.parse(JSON.stringify(stamp)));
  assert.equal(stored.category, 'Stamps');
  assert.deepEqual(stored.objects.map(({ x, y, width, height }) => ({ x, y, width, height })),
    stamp.objects.map(({ x, y, width, height }) => ({ x, y, width, height })));
  assert.deepEqual(templateFieldNames(stored).sort(), ['Name', 'Price']);
  assert.equal(stored.objects[1].prefix, 'Price: ');
  assert.equal(stored.objects[1].suffix, ' EGP');
});

test('the same stamp prints a different column value for each Excel row', () => {
  const stored = sanitizeTemplate(JSON.parse(JSON.stringify(stamp)));
  const headers = ['Name', 'Price'];
  const recordA = { cells: ['Wireless Mouse', '325'], raw: [] };
  const recordB = { cells: ['Keyboard', '150'], raw: [] };
  const contextA = makeContext({ headers, record: recordA });
  const contextB = makeContext({ headers, record: recordB });
  assert.equal(resolveText(stored.objects[0], contextA), 'Price tag');
  assert.equal(resolveText(stored.objects[1], contextA), 'Price: 325 EGP');
  assert.equal(resolveText(stored.objects[1], contextB), 'Price: 150 EGP');
  assert.equal(resolveText(stored.objects[2], contextA), 'Item: Wireless Mouse');
  assert.equal(resolveText(stored.objects[2], contextB), 'Item: Keyboard');
  const htmlA = renderLabelHtml(stored, buildLabel(stored, { headers, record: recordA }), { mode: 'design' });
  const htmlB = renderLabelHtml(stored, buildLabel(stored, { headers, record: recordB }), { mode: 'design' });
  assert.match(htmlA, /Wireless Mouse/);
  assert.match(htmlB, /Keyboard/);
  assert.doesNotMatch(htmlB, /Wireless Mouse/);
});
