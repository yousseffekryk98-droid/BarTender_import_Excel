import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemplate, createObject } from '../../src/engine/schema.js';
import { planJob, applyFilters } from '../../src/engine/jobs.js';
import { buildLabel } from '../../src/engine/render.js';
import { barcodesFor } from '../../src/render/pipeline.js';
import { missingFields } from '../../src/engine/binding.js';
import { editWorkingCell, removeWorkingColumn } from '../../src/data/editing.js';
import { detachDeletedField } from '../../src/engine/remap.js';

test('missing fields can print blank; present fields stay visible and expressions do not throw', async () => {
  const template = createTemplate({ objects: [
    createObject('text', { name: 'Present', content: { mode: 'field', field: 'Name' } }),
    createObject('text', { name: 'Missing', content: { mode: 'field', field: 'Price' }, prefix: 'EGP ' }),
    createObject('text', { name: 'Mix', content: { mode: 'template', template: 'Name {Name} Price {Price} {=[Price]*2}' } }),
    createObject('text', { name: 'Expression', content: { mode: 'expression', expression: '[Price] * 2' } }),
    createObject('barcode', { name: 'Barcode', content: { mode: 'field', field: 'Barcode' } })
  ] });
  const headers = ['Name'];
  const records = [{id:'2',rowNumber:2,cells:['Mouse'],raw:[]}];
  const strict = planJob({template,headers,records});
  assert.match(strict.blocking.join(' '), /Price/);
  const optional = planJob({template,headers,records,allowMissing:true});
  assert.deepEqual(optional.blocking, []);
  assert.equal(optional.total,1);
  const label = buildLabel(template,{headers,record:records[0],allowMissing:true});
  assert.deepEqual(label.errors, []);
  assert.equal(label.items[0].text,'Mouse');
  assert.equal(label.items[1].text,'');
  assert.equal(label.items[2].text,'Name Mouse Price  ');
  assert.equal(label.items[3].text,'');
  assert.equal(label.items[4].text,'');
  assert.deepEqual((await barcodesFor(label)).barcodeErrors,{});
});
test('deleted column references stay clean and last release cell editing stays aligned', () => {
  const t = createTemplate({objects:[createObject('text',{content:{mode:'field',field:'Price'}})]});
  const original = {headers:['Name','Price'],records:[{id:'2',cells:['A','8'],raw:[null,{t:'n',v:8}]}]};
  const reduced = removeWorkingColumn(original,1);
  const detached = detachDeletedField(t,'Price');
  assert.deepEqual(missingFields(detached,reduced.headers),[]);
  const changed = editWorkingCell(reduced,'2',0,'B');
  assert.equal(changed.records[0].cells[0],'B');
  assert.equal(original.records[0].cells[0],'A');
});
test('selected row IDs control counts, including selecting none and reselecting', () => {
  const t = createTemplate({objects:[createObject('text',{content:{mode:'field',field:'Name'}})]});
  const records = Array.from({length:3},(_,i)=>({id:String(i+2),rowNumber:i+2,cells:['P'+i],raw:[]}));
  const all = new Set(records.map(r=>r.id));
  assert.equal(planJob({template:t,headers:['Name'],records,selectedIds:all}).total,3);
  all.delete('3');
  assert.deepEqual(planJob({template:t,headers:['Name'],records,selectedIds:all}).entries.map(e=>e.record.id),['2','4']);
  all.clear();
  assert.match(planJob({template:t,headers:['Name'],records,selectedIds:all}).blocking.join(' '), /No rows/);
  all.add('3');
  assert.equal(planJob({template:t,headers:['Name'],records,selectedIds:all}).total,1);
});

test('unavailable filter fields no longer discard every row before the optional print plan', () => {
  const records = [{id:'2',cells:['Mouse'],raw:[]},{id:'3',cells:['Keyboard'],raw:[]}];
  const filtered = applyFilters(records,['Name'],[
    {field:'OldCode',op:'isNotEmpty',value:''},
    {field:'Name',op:'isNotEmpty',value:''}
  ]);
  assert.equal(filtered.length,2);
});
