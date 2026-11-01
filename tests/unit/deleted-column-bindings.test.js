import test from 'node:test';
import assert from 'node:assert/strict';
import { detachDeletedField } from '../../src/engine/remap.js';
import { missingFields } from '../../src/engine/binding.js';
import { planJob } from '../../src/engine/jobs.js';
import { removeWorkingColumn, editWorkingCell } from '../../src/data/editing.js';
import { createTemplate, createObject } from '../../src/engine/schema.js';

const table = () => ({
  headers: ['Name', 'Qty', 'Code'],
  records: [{ id: '2', rowNumber: 2, cells: ['Mouse', '5', 'A12'], raw: [{t:'s',v:'Mouse'}, {t:'n',v:5}, {t:'s',v:'A12'}], labelOverrides: { hello: 'keep' } }]
});

test('deleting quantity removes obsolete fields and dependent filters without blocking printing', () => {
  const data = table();
  const template = createTemplate({
    objects: [
      createObject('text', { name: 'Quantity field', content: { mode: 'field', field: 'Qty' }, prefix: 'Qty: ', suffix: ' pc' }),
      createObject('text', { name: 'Mixed', content: { mode: 'template', template: 'Name {Name}, Qty {Qty}, Code {Code}' } }),
      createObject('text', { name: 'Formula', content: { mode: 'expression', expression: '[Qty] * 2' } }),
      createObject('text', { name: 'Visibility', content: { mode: 'field', field: 'Code' }, visibleIf: { kind: 'field', field: 'Qty', op: 'gt', value: '0' } })
    ],
    data: { quantityMode: 'field', quantityField: 'Qty', filters: [{ field: 'Qty', op: 'gt', value: '0' }, { field:'Name', op:'isNotEmpty',value:'' }], sort: [{field:'Qty',dir:'asc'},{field:'Name',dir:'desc'}] }
  });
  const reduced = removeWorkingColumn(data, 1);
  const detached = detachDeletedField(template, 'Qty');
  assert.deepEqual(reduced.headers, ['Name', 'Code']);
  assert.equal(detached.data.quantityMode, 'fixed');
  assert.equal(detached.data.quantityField, '');
  assert.deepEqual(detached.data.filters.map(f => f.field), ['Name']);
  assert.deepEqual(detached.data.sort.map(f => f.field), ['Name']);
  assert.equal(detached.objects[0].content.mode, 'static');
  assert.equal(detached.objects[0].prefix, '');
  assert.equal(detached.objects[1].content.template, 'Name {Name}, Qty , Code {Code}');
  assert.equal(detached.objects[2].content.mode, 'static');
  assert.equal(detached.objects[3].visibleIf, null);
  assert.deepEqual(missingFields(detached, reduced.headers), []);
  const plan = planJob({ template: detached, headers: reduced.headers, records: reduced.records, copies: 1 });
  assert.deepEqual(plan.blocking, []);
  assert.equal(plan.total, 1);
  assert.deepEqual(template.data.filters.map(f => f.field), ['Qty', 'Name'], 'original template is unchanged');
});
test('only matching expression placeholders are detached, escaped literal and other columns remain', () => {
  const template = createTemplate({ objects: [
    createObject('text', { content: { mode:'template', template:'{{Qty}} {= [Qty] + 1} {Code}' } })
  ] });
  const updated = detachDeletedField(template, 'Qty');
  assert.equal(updated.objects[0].content.template, '{{Qty}}  {Code}');
  assert.deepEqual(missingFields(updated, ['Code']), []);
});
test('single-cell edits keep row identifiers and overrides, but clear stale raw Excel type', () => {
  const original = table();
  const changed = editWorkingCell(original, '2', 1, '18');
  assert.deepEqual(changed.records[0].cells, ['Mouse', '18', 'A12']);
  assert.equal(changed.records[0].raw[1], null);
  assert.equal(changed.records[0].raw[0].v, 'Mouse');
  assert.deepEqual(changed.records[0].labelOverrides, {hello: 'keep'});
  assert.equal(original.records[0].cells[1], '5');
  assert.strictEqual(editWorkingCell(changed, '2', 1, '18'), changed);
  assert.throws(() => editWorkingCell(changed, '2', 5, 'a'), /Invalid Excel column/);
  assert.throws(() => editWorkingCell(changed, '404', 0, 'a'), /Row no longer exists/);
});
