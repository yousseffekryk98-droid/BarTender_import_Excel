import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemplate, createObject } from '../../src/engine/schema.js';
import { planJob, iterateLabels, chunkRanges, parseQuantity, applyFilters, sortRecords, searchRecords, serialStateAfter, serialStartsFor, selectTemplateId, groupByTemplate, MAX_LABELS_PER_JOB } from '../../src/engine/jobs.js';
import { normalizeTable } from '../../src/data/table.js';
import { renameField, applyRenames } from '../../src/engine/remap.js';

const sheet = normalizeTable('S', [
  ['Item', 'Qty', 'City', 'Price'],
  ['A', '2', 'Cairo', '10'],
  ['B', '0', 'Giza', '5'],
  ['C', '', 'Cairo', '100'],
  ['D', '3', 'Alexandria', '20'],
  ['E', '1', 'cairo', '7.5']
]);
const tpl = (extra = {}) => createTemplate({ objects: [createObject('text', { content: { mode: 'field', field: 'Item' } })], ...extra });

test('quantity parsing never guesses', () => {
  assert.deepEqual(parseQuantity('3'), { copies: 3, problem: '' });
  assert.deepEqual(parseQuantity(''), { copies: 0, problem: '' });
  assert.equal(parseQuantity('2.5').problem, 'Quantity 2.5 is not a whole number');
  assert.match(parseQuantity('-1').problem, /negative/);
  assert.match(parseQuantity('many').problem, /not a number/);
  assert.match(parseQuantity('1000000').problem, /exceeds/);
  assert.equal(parseQuantity('1,500').copies, 1500);
});

test('quantity-per-record printing skips 0/blank rows and reports them', () => {
  const plan = planJob({ template: tpl(), headers: sheet.headers, records: sheet.records, quantityField: 'Qty' });
  assert.equal(plan.total, 6);
  assert.equal(plan.zeroQuantity, 2);
  assert.deepEqual(plan.entries.map((e) => [e.record.cells[0], e.copies]), [['A', 2], ['D', 3], ['E', 1]]);
  assert.deepEqual(plan.blocking, []);
  const labels = [...iterateLabels(plan)];
  assert.deepEqual(labels.map((l) => l.record.cells[0] + l.copyNumber), ['A1', 'A2', 'D1', 'D2', 'D3', 'E1']);
  assert.deepEqual(labels.map((l) => l.labelIndex), [0, 1, 2, 3, 4, 5]);
});

test('invalid quantities, missing columns and empty selections block printing', () => {
  const bad = normalizeTable('S', [['Item', 'Qty'], ['A', '2'], ['B', 'x']]);
  const plan = planJob({ template: tpl(), headers: bad.headers, records: bad.records, quantityField: 'Qty' });
  assert.equal(plan.problems.length, 1);
  assert.match(plan.blocking.join(' '), /invalid quantity/);
  const missing = planJob({ template: createTemplate({ objects: [createObject('text', { content: { mode: 'field', field: 'Serial' } })] }), headers: sheet.headers, records: sheet.records });
  assert.match(missing.blocking[0], /"Serial" was not found/);
  const noQtyCol = planJob({ template: tpl(), headers: sheet.headers, records: sheet.records, quantityField: 'Copies' });
  assert.match(noQtyCol.blocking.join(' '), /Quantity column "Copies" was not found/);
  const none = planJob({ template: tpl(), headers: sheet.headers, records: sheet.records, selectedIds: new Set() });
  assert.match(none.blocking[0], /No rows are selected/);
});

test('fixed copies, selection and large-job confirmation', () => {
  const ids = new Set([sheet.records[0].id, sheet.records[3].id]);
  const plan = planJob({ template: tpl(), headers: sheet.headers, records: sheet.records, selectedIds: ids, copies: 4, ignoreQuantity: true });
  assert.equal(plan.total, 8);
  assert.equal(plan.needsConfirmation, false);
  const big = planJob({ template: tpl(), headers: sheet.headers, records: sheet.records, copies: 300, ignoreQuantity: true });
  assert.equal(big.total, 1500);
  assert.equal(big.needsConfirmation, true);
  const huge = planJob({ template: tpl(), headers: sheet.headers, records: sheet.records, copies: 100000, ignoreQuantity: true });
  assert.ok(huge.total > MAX_LABELS_PER_JOB);
  assert.match(huge.blocking.join(' '), /limit per job/);
});

test('batching: slices and spool chunks cover every label exactly once', () => {
  const plan = planJob({ template: tpl(), headers: sheet.headers, records: sheet.records, copies: 101, ignoreQuantity: true });
  assert.equal(plan.total, 505);
  const ranges = chunkRanges(plan.total, 250);
  assert.deepEqual(ranges, [[0, 250], [250, 500], [500, 505]]);
  const seen = ranges.flatMap(([s, e]) => [...iterateLabels(plan, s, e)].map((l) => l.labelIndex));
  assert.equal(seen.length, 505);
  assert.deepEqual(seen, Array.from({ length: 505 }, (_, i) => i));
  const mid = [...iterateLabels(plan, 100, 103)];
  assert.deepEqual(mid.map((l) => [l.record.cells[0], l.copyNumber]), [['A', 101], ['B', 1], ['B', 2]]);
});

test('filters, sort and search', () => {
  const cairo = applyFilters(sheet.records, sheet.headers, [{ field: 'City', op: 'equals', value: 'CAIRO' }]);
  assert.deepEqual(cairo.map((r) => r.cells[0]), ['A', 'C', 'E']);
  const expensive = applyFilters(sheet.records, sheet.headers, [{ field: 'Price', op: 'greaterThan', value: '9' }, { field: 'Qty', op: 'isNotEmpty' }]);
  assert.deepEqual(expensive.map((r) => r.cells[0]), ['A', 'D']);
  const sorted = sortRecords(sheet.records, sheet.headers, [{ field: 'Price', dir: 'desc' }]);
  assert.deepEqual(sorted.map((r) => r.cells[0]), ['C', 'D', 'A', 'E', 'B']);
  const byCity = sortRecords(sheet.records, sheet.headers, [{ field: 'City', dir: 'asc' }, { field: 'Item', dir: 'desc' }]);
  assert.deepEqual(byCity.map((r) => r.cells[0]), ['D', 'E', 'C', 'A', 'B']);
  assert.deepEqual(searchRecords(sheet.records, 'giz').map((r) => r.cells[0]), ['B']);
});

test('serial numbers continue from the last printed value', () => {
  const serial = createObject('text', { id: 'sn', content: { mode: 'serial', serial: { start: '0001', step: 1, continueFromLast: true } } });
  const t = createTemplate({ objects: [serial] });
  const plan = planJob({ template: t, headers: sheet.headers, records: sheet.records.slice(0, 2), copies: 3, ignoreQuantity: true });
  const state = serialStateAfter(t, plan);
  assert.equal(state.sn, '0007');
  const next = { ...t, serialState: state };
  assert.deepEqual(serialStartsFor(next), { sn: '0007' });
  assert.equal(serialStateAfter(next, plan).sn, '0013');
});

test('data-driven template selection', () => {
  const selector = { field: 'City', cases: [{ op: 'equals', value: 'Cairo', templateId: 'cairo' }, { op: 'startsWith', value: 'Alex', templateId: 'alex' }], defaultTemplateId: 'other' };
  assert.equal(selectTemplateId(selector, sheet.headers, sheet.records[0]), 'cairo');
  assert.equal(selectTemplateId(selector, sheet.headers, sheet.records[3]), 'alex');
  assert.equal(selectTemplateId(selector, sheet.headers, sheet.records[1]), 'other');
  const { groups } = groupByTemplate(selector, sheet.headers, sheet.records);
  assert.deepEqual([...groups.keys()].sort(), ['alex', 'cairo', 'other']);
  assert.equal(groups.get('cairo').length, 3);
});

test('renaming a binding updates every reference (fields, combined text, formulas, rules, quantity, filters)', () => {
  const t = createTemplate({
    data: { quantityField: 'Qty', quantityMode: 'field', filters: [{ field: 'Qty', op: 'isNotEmpty', value: '' }], sort: [{ field: 'Qty', dir: 'asc' }] },
    objects: [
      createObject('text', { name: 'Qty', content: { mode: 'field', field: 'qty' } }),
      createObject('text', { content: { mode: 'template', template: 'x{Qty} {Other} {?Qty} {=[Qty]*2}' } }),
      createObject('text', { content: { mode: 'expression', expression: '[Qty] + {Qty}' }, visibleIf: { kind: 'field', field: 'QTY', op: 'isNotEmpty' } })
    ]
  });
  const r = renameField(t, 'Qty', 'Copies');
  assert.equal(r.objects[0].content.field, 'Copies');
  assert.equal(r.objects[0].name, 'Copies');
  assert.equal(r.objects[1].content.template, 'x{Copies} {Other} {?Qty} {=[Copies]*2}');
  assert.equal(r.objects[2].content.expression, '[Copies] + [Copies]');
  assert.equal(r.objects[2].visibleIf.field, 'Copies');
  assert.equal(r.data.quantityField, 'Copies');
  assert.equal(r.data.filters[0].field, 'Copies');
  assert.equal(r.data.sort[0].field, 'Copies');
  assert.deepEqual(applyRenames(t, { Qty: '' }), t);
});
