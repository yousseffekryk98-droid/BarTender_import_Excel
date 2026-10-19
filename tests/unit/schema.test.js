import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTemplate, createTemplate, createObject, migrateV1, TEMPLATE_VERSION, LIMITS } from '../../src/engine/schema.js';

const V1 = {
  id: 'template-abc', name: 'Store Price Label', width: 50, height: 30,
  fields: [
    { id: 'product', type: 'column', label: 'Product', columnKey: 'Product Name', autoField: 'name', x: 2, y: 3, width: 46, height: 10, fontSize: 15, bold: true, align: 'center', prefix: '', suffix: '' },
    { id: 'price', type: 'column', label: 'Price', columnKey: '', autoField: 'price', x: 2, y: 17, width: 46, height: 9, fontSize: 18, bold: true, align: 'center', prefix: '', suffix: ' EGP' },
    { id: 'static', type: 'text', text: 'MADE IN EGYPT', x: 0, y: 26, width: 50, height: 4, fontSize: 8, rotation: 90, fontFamily: 'Tahoma', italic: true, wrap: false }
  ]
};

test('v0.2.0 templates migrate to schema v2 without losing positions or formatting', () => {
  const t = sanitizeTemplate(V1);
  assert.equal(t.version, TEMPLATE_VERSION);
  assert.equal(t.id, 'template-abc');
  assert.equal(t.name, 'Store Price Label');
  assert.deepEqual([t.page.width, t.page.height], [50, 30]);
  assert.equal(t.meta.migratedFrom, 1);
  const [product, price, stat] = t.objects;
  assert.deepEqual([product.x, product.y, product.width, product.height], [2, 3, 46, 10]);
  assert.equal(product.content.mode, 'field');
  assert.equal(product.content.field, 'Product Name');
  assert.equal(product.style.fontSize, 11.5); // 15 CSS px = 11.25 pt → nearest 0.5
  assert.equal(product.style.bold, true);
  assert.equal(product.style.align, 'center');
  assert.equal(price.content.field, 'Price'); // legacy auto-field resolved to its default header
  assert.equal(price.suffix, ' EGP');
  assert.equal(stat.content.mode, 'static');
  assert.equal(stat.content.text, 'MADE IN EGYPT');
  assert.equal(stat.rotation, 90);
  assert.equal(stat.style.fontFamily, 'Tahoma');
  assert.equal(stat.style.wrap, false);
  assert.equal(stat.style.italic, true);
});

test('sanitizing is idempotent and clamps hostile values', () => {
  const t = createTemplate({ page: { width: 9999, height: -5, dpi: 1234, printRotation: 45 }, objects: [
    { type: 'text', x: 'evil', y: 1e9, width: -1, height: 'a', rotation: 725, style: { fontSize: 9999, fontFamily: 'Arial"; background:url(x)', color: 'red;behavior:url(x)', align: 'sideways' }, content: { mode: 'script' } },
    { type: 'image', src: 'javascript:alert(1)' },
    { type: 'image', src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    { type: 'unknown', x: 1 }
  ] });
  assert.equal(t.page.width, LIMITS.maxPageWidth);
  assert.equal(t.page.height, LIMITS.minPage);
  assert.equal(t.page.dpi, 203);
  assert.equal(t.page.printRotation, 0);
  const [text, img, svg, unknown] = t.objects;
  assert.equal(text.x, 0);
  assert.ok(text.y <= t.page.height * 2);
  assert.equal(text.rotation, 5);
  assert.equal(text.style.fontSize, LIMITS.maxFont);
  assert.doesNotMatch(text.style.fontFamily, /["';]/);
  assert.equal(text.style.color, '#000000');
  assert.equal(text.style.align, 'left');
  assert.equal(text.content.mode, 'static');
  assert.equal(img.src, '');
  assert.equal(svg.src, '', 'SVG images are refused (could carry scripts)');
  assert.equal(unknown.type, 'text');
  assert.deepEqual(sanitizeTemplate(t), t);
});

test('duplicate object ids are made unique and limits enforced', () => {
  const t = sanitizeTemplate({ version: 2, page: { width: 50, height: 30 }, objects: [{ id: 'a', type: 'line' }, { id: 'a', type: 'rect' }] });
  assert.notEqual(t.objects[0].id, t.objects[1].id);
  assert.throws(() => sanitizeTemplate({ version: 2, objects: Array.from({ length: LIMITS.maxObjects + 1 }, () => ({ type: 'line' })) }), /at most/);
  assert.throws(() => sanitizeTemplate({ version: 99, objects: [] }), /newer version/);
  assert.equal(sanitizeTemplate(null), null);
  assert.equal(sanitizeTemplate([]), null);
  assert.equal(sanitizeTemplate({ hello: 'world' }), null);
});

test('every object type gets complete defaults', () => {
  for (const type of ['text', 'line', 'rect', 'ellipse', 'image', 'barcode', 'table']) {
    const o = createObject(type);
    assert.equal(o.type, type);
    assert.ok(o.id.startsWith(type));
    assert.ok(o.width > 0);
  }
  const table = createObject('table', { rows: 3, columns: 2 });
  assert.equal(table.cells.length, 3);
  assert.equal(table.cells[0].length, 2);
});

test('migrateV1 ignores non-templates', () => {
  assert.equal(migrateV1({ name: 'x' }), null);
  assert.equal(migrateV1(null), null);
});
