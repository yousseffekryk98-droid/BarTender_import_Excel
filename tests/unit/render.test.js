import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemplate, createObject, sanitizeTemplate } from '../../src/engine/schema.js';
import { buildLabel, renderLabelHtml, printDocumentHtml, testPatternLabelHtml, safeSvg } from '../../src/engine/render.js';
import { resolveColumn, missingFields, makeContext, resolveText, serialValue, evaluateRule, isAmbiguous, templateFieldNames } from '../../src/engine/binding.js';

// The exact example from the requirements: 50 × 30 mm, three text objects.
function specTemplate() {
  return createTemplate({
    name: 'Store Price Label', page: { width: 50, height: 30 },
    objects: [
      createObject('text', { id: 'o1', name: 'Product', x: 2, y: 3, width: 46, height: 9, content: { mode: 'field', field: 'Product Name' }, style: { fontSize: 14, bold: true } }),
      createObject('text', { id: 'o2', name: 'Price', x: 2, y: 14, width: 46, height: 9, content: { mode: 'field', field: 'Price' }, suffix: ' EGP', style: { fontSize: 18 } }),
      createObject('text', { id: 'o3', name: 'Serial', x: 2, y: 24, width: 46, height: 5, content: { mode: 'field', field: 'Serial' }, prefix: 'SN: ' })
    ]
  });
}
const HEADERS = ['Product Name', 'Price', 'Serial', 'Location'];
const ROWS = [['Mouse', '325', '00123', 'Cairo'], ['Keyboard', '500', '00124', 'Giza']];

/** Minimal attribute parser to prove style attributes are well-formed (regression for v0.2 quoting bug). */
function styleOf(html, id) {
  const re = new RegExp('data-object-id="' + id + '" style="([^"]*)"');
  const m = re.exec(html);
  assert.ok(m, 'object ' + id + ' rendered with a well-formed style attribute');
  return m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
function innerStyleOf(html, id) {
  const i = html.indexOf('data-object-id="' + id + '"');
  const m = /class="els-text-inner" dir="[a-z]+" style="([^"]*)"/.exec(html.slice(i));
  assert.ok(m);
  return m[1].replace(/&#39;/g, "'");
}

test('spec example: each Excel row prints its own text at the configured positions', () => {
  const t = specTemplate();
  const texts = ROWS.map((cells) => buildLabel(t, { headers: HEADERS, record: { cells } }).items.map((i) => i.text));
  assert.deepEqual(texts[0], ['Mouse', '325 EGP', 'SN: 00123']);
  assert.deepEqual(texts[1], ['Keyboard', '500 EGP', 'SN: 00124']);
  const html = renderLabelHtml(t, buildLabel(t, { headers: HEADERS, record: { cells: ROWS[0] } }));
  assert.match(html, /^<article class="els-label" style="width:50mm;height:30mm/);
  const s1 = styleOf(html, 'o1'); const s2 = styleOf(html, 'o2'); const s3 = styleOf(html, 'o3');
  assert.match(s1, /left:2mm;top:3mm;width:46mm;height:9mm/);
  assert.match(s2, /left:2mm;top:14mm/);
  assert.match(s3, /left:2mm;top:24mm/);
  const inner = innerStyleOf(html, 'o1');
  assert.match(inner, /font-family:'Arial'/);
  assert.match(inner, /font-size:14pt/);
  assert.match(inner, /font-weight:700/, 'bold survives rendering (v0.2 dropped it)');
  assert.match(innerStyleOf(html, 'o2'), /font-size:18pt/);
});

test('text-only labels contain no barcode markup at all', () => {
  const html = renderLabelHtml(specTemplate(), buildLabel(specTemplate(), { headers: HEADERS, record: { cells: ROWS[0] } }));
  assert.doesNotMatch(html, /<svg|barcode/i);
});

test('spreadsheet values cannot inject markup or CSS', () => {
  const t = specTemplate();
  const html = renderLabelHtml(t, buildLabel(t, { headers: HEADERS, record: { cells: ['<img src=x onerror=alert(1)>', '"><script>x()</script>', "'; color:red", ''] } }));
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});

test('columns are bound by heading, not position; reordered columns still map correctly', () => {
  const t = specTemplate();
  const reordered = ['Location', 'Serial', 'price', 'PRODUCT  NAME'];
  const items = buildLabel(t, { headers: reordered, record: { cells: ['Cairo', '00123', '325', 'Mouse'] } }).items;
  assert.deepEqual(items.map((i) => i.text), ['Mouse', '325 EGP', 'SN: 00123']);
  assert.equal(resolveColumn(reordered, 'Product Name'), 3);
});

test('missing or duplicated columns are reported, never substituted', () => {
  const t = specTemplate();
  const m = missingFields(t, ['Product Name', 'Price', 'Price', 'Location']);
  assert.deepEqual(m.map((x) => [x.field, x.reason]).sort(), [['Price', 'ambiguous'], ['Serial', 'missing']]);
  assert.equal(isAmbiguous(['A', 'a '], 'A'), true);
  const items = buildLabel(t, { headers: ['Product Name', 'SKU'], record: { cells: ['Mouse', '999'] } }).items;
  assert.equal(items[2].text, '', 'Serial column missing → empty, not the SKU');
  assert.deepEqual(templateFieldNames(t).sort(), ['Price', 'Product Name', 'Serial']);
});

test('prefix/suffix are not printed for empty cells; placeholders show in the designer', () => {
  const t = specTemplate();
  assert.equal(buildLabel(t, { headers: HEADERS, record: { cells: ['Mouse', '', '', ''] } }).items[1].text, '');
  assert.equal(buildLabel(t, { placeholders: true }).items[0].text, '[Product Name]');
});

test('Arabic, English and mixed text keep bidi-safe markup', () => {
  const t = createTemplate({ page: { width: 60, height: 20 }, objects: [
    createObject('text', { id: 'ar', content: { mode: 'field', field: 'الاسم' }, style: { direction: 'rtl', align: 'right', fontFamily: 'Tahoma' } }),
    createObject('text', { id: 'mix', content: { mode: 'template', template: '{الاسم} – {Name}' }, style: { direction: 'auto' } })
  ] });
  const html = renderLabelHtml(t, buildLabel(t, { headers: ['الاسم', 'Name'], record: { cells: ['ماوس لاسلكي', 'Wireless mouse'] } }));
  assert.match(html, /dir="rtl"[^>]*>ماوس لاسلكي</);
  assert.match(html, /direction:rtl/);
  assert.match(html, /dir="auto"[^>]*unicode-bidi:plaintext[^>]*>ماوس لاسلكي – Wireless mouse</);
});

test('content sources: date, serial, expression, prompt and formats', () => {
  const now = () => new Date(2026, 9, 19, 8, 0);
  const t = createTemplate({ objects: [
    createObject('text', { id: 'd', content: { mode: 'date', date: { offsetMonths: 12 } }, format: { kind: 'date', datePattern: 'dd/MM/yyyy' } }),
    createObject('text', { id: 's', content: { mode: 'serial', serial: { start: '0098', step: 2 } }, prefix: 'SN-' }),
    createObject('text', { id: 'e', content: { mode: 'expression', expression: 'IF([Qty] > 1, "x" & [Qty], "")' } }),
    createObject('text', { id: 'p', content: { mode: 'prompt', prompt: 'Batch' } }),
    createObject('text', { id: 'c', content: { mode: 'field', field: 'Price' }, format: { kind: 'currency', currencySymbol: 'EGP', decimals: 2, thousands: true } })
  ] });
  const label = (labelIndex) => buildLabel(t, { headers: ['Qty', 'Price'], record: { cells: ['3', '1234.5'] }, prompts: { Batch: 'B-7' }, now, labelIndex }).items.map((i) => i.text);
  assert.deepEqual(label(0), ['19/10/2027', 'SN-0098', 'x3', 'B-7', '1,234.50 EGP']);
  assert.equal(label(5)[1], 'SN-0108');
});

test('expression errors are reported per object instead of printing wrong data', () => {
  const t = createTemplate({ objects: [createObject('text', { name: 'Calc', content: { mode: 'expression', expression: '[A] * 2' } })] });
  const built = buildLabel(t, { headers: ['A'], record: { cells: ['abc'] } });
  assert.equal(built.items[0].text, '#ERR');
  assert.match(built.errors[0], /Calc: .*not a number/);
});

test('serial sequences: numeric (long), hex, alpha, alphanumeric', () => {
  assert.equal(serialValue({ start: '000999', step: 1 }, 1), '001000');
  assert.equal(serialValue({ start: '99999999999999999999', step: 1 }, 1), '100000000000000000000');
  assert.equal(serialValue({ start: '00FF', step: 1, mode: 'hex' }, 1), '0100');
  assert.equal(serialValue({ start: 'Y', step: 1, mode: 'alpha' }, 3), 'AB');
  assert.equal(serialValue({ start: 'Z9', step: 1, mode: 'alphanumeric' }, 1), 'ZA');
  assert.equal(serialValue({ start: '10', step: -3 }, 2), '4');
  assert.throws(() => serialValue({ start: 'abc', step: 1 }, 0), /whole number/);
});

test('conditional visibility hides objects in print and ghosts them in design', () => {
  const t = createTemplate({ objects: [
    createObject('text', { id: 'promo', content: { mode: 'static', text: 'SALE' }, visibleIf: { kind: 'field', field: 'Promo', op: 'equals', value: 'yes' } }),
    createObject('text', { id: 'always', content: { mode: 'static', text: 'Always' } }),
    createObject('text', { id: 'never', content: { mode: 'static', text: 'Design note' }, printable: false })
  ] });
  const no = buildLabel(t, { headers: ['Promo'], record: { cells: ['no'] } });
  const yes = buildLabel(t, { headers: ['Promo'], record: { cells: ['YES'] } });
  assert.doesNotMatch(renderLabelHtml(t, no), /SALE/);
  assert.match(renderLabelHtml(t, yes), /SALE/);
  assert.doesNotMatch(renderLabelHtml(t, yes), /Design note/);
  assert.match(renderLabelHtml(t, no, { mode: 'design' }), /els-ghost[^>]*>.*SALE/s);
  const ctx = makeContext({ headers: ['Price'], record: { cells: ['150'] } });
  assert.equal(evaluateRule({ kind: 'expression', expression: '[Price] > 100' }, ctx), true);
  assert.equal(evaluateRule({ kind: 'field', field: 'Price', op: 'lessThan', value: '99' }, ctx), false);
  assert.equal(evaluateRule({ kind: 'expression', expression: '' }, ctx), true);
});

test('print document: one label per page, exact page size, zero margins, rotation and offsets', () => {
  const t = specTemplate();
  const html = renderLabelHtml(t, buildLabel(t, { headers: HEADERS, record: { cells: ROWS[0] } }));
  const doc = printDocumentHtml([html, html], t.page);
  assert.match(doc, /@page\{size:50mm 30mm;margin:0\}/);
  assert.equal((doc.match(/class="els-page"/g) || []).length, 2);
  assert.match(doc, /Content-Security-Policy" content="default-src 'none'/);
  const rotated = printDocumentHtml([html], { ...t.page, printRotation: 90, offsetX: 0.5, offsetY: -0.3 });
  assert.match(rotated, /@page\{size:30mm 50mm;margin:0\}/);
  assert.match(rotated, /translate\(30.5mm,-0.3mm\) rotate\(90deg\)/);
  assert.match(testPatternLabelHtml(t.page), /50 × 30 mm/);
});

test('shapes, images and tables render as safe markup', () => {
  const t = createTemplate({ page: { width: 60, height: 40 }, objects: [
    createObject('line', { id: 'l', x: 1, y: 10, width: 58, height: 0.5, stroke: { width: 0.4, style: 'dashed' } }),
    createObject('rect', { id: 'r', x: 0.5, y: 0.5, width: 59, height: 39, radius: 2 }),
    createObject('ellipse', { id: 'e', x: 5, y: 5, width: 8, height: 8, fill: '#ff0000' }),
    createObject('image', { id: 'i', src: 'data:image/png;base64,iVBORw0KGgo=' }),
    createObject('table', { id: 't', rows: 1, columns: 2, cells: [[{ content: { mode: 'static', text: 'Qty' } }, { content: { mode: 'field', field: 'Qty' } }]] })
  ] });
  const html = renderLabelHtml(t, buildLabel(t, { headers: ['Qty'], record: { cells: ['5'] } }));
  assert.match(html, /<line [^>]*stroke-dasharray/);
  assert.match(html, /<rect [^>]*rx="2"/);
  assert.match(html, /<ellipse [^>]*fill="#ff0000"/);
  assert.match(html, /<img class="els-obj els-image" alt="" data-object-id="i" src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(html, /<td[^>]*>Qty<\/td><td[^>]*>5<\/td>/);
});

test('only generated SVG is embedded for barcodes', () => {
  assert.equal(safeSvg('<svg><script>alert(1)</script></svg>'), '');
  assert.equal(safeSvg('<svg onload="x()"></svg>'), '');
  assert.equal(safeSvg('<svg><image href="http://x"/></svg>'), '');
  assert.match(safeSvg('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'), /^<svg/);
});

test('label objects never depend on a barcode column', () => {
  const t = sanitizeTemplate(specTemplate());
  const ctx = makeContext({ headers: ['Product Name'], record: { cells: ['Mouse'] } });
  assert.equal(resolveText(t.objects[0], ctx), 'Mouse');
});
