import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemplate, createObject } from '../../src/engine/schema.js';
import { designColumns, createDesignWorkbook } from '../../src/data/export-template.js';
import { readSpreadsheet } from '../../src/data/importers.js';

test('exported Excel columns match live design data references, filters, and quantity', () => {
  const template = createTemplate({
    objects: [
      createObject('text', { content: { mode: 'field', field: 'Product Name' } }),
      createObject('text', { content: { mode: 'template', template: 'Code {SKU} / {Product Name}' } })
    ],
    data: { quantityMode: 'field', quantityField: 'Copies', filters: [{ field: 'SKU', op: 'isNotEmpty', value: '' }] }
  });
  assert.deepEqual(designColumns(template), ['Product Name', 'SKU', 'Copies']);
});
test('blank designs export an editable data sheet with a placeholder header', () => {
  const template = createTemplate({ objects: [createObject('text', { content: { mode: 'static', text: 'Shop' } })] });
  assert.deepEqual(designColumns(template), ['Label Text']);
});
test('generated XLSX can be imported, populated and matched to saved template fields', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const template = createTemplate({ objects: [createObject('text', { content: { mode: 'field', field: 'SKU' } })] });
  const exported = await createDesignWorkbook(template);
  assert.ok(exported.bytes.length > 150);
  assert.equal(exported.bytes[0], 0x50);
  assert.equal(exported.bytes[1], 0x4b);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.bytes);
  assert.equal(workbook.worksheets[0].name, 'Data');
  assert.equal(workbook.getWorksheet('Data').getCell('A1').value, 'SKU');
  assert.equal(workbook.getWorksheet('Data').getCell('A1').fill.fgColor.argb, 'FF176B69');
  assert.equal(workbook.worksheets[1].name, 'Instructions');
  workbook.getWorksheet('Data').getCell('A2').value = '00123';
  const buffer = await workbook.xlsx.writeBuffer();
  const file = { name: 'labels.xlsx', size: buffer.byteLength, arrayBuffer: async () => buffer };
  const parsed = await readSpreadsheet(file);
  const table = parsed.sheets[0].table;
  assert.deepEqual(table.headers, ['SKU']);
  assert.equal(table.records[0].cells[0], '00123');
});
