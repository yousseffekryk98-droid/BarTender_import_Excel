import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { readSpreadsheet, withHeaderRow, decodeText } from '../../src/data/importers.js';
import { normalizeTable, TABLE_LIMITS } from '../../src/data/table.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, '..', 'fixtures', name);
const asFile = (name, bytes) => ({ name, size: bytes.length, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) });

async function xlsx(build) {
  const wb = new ExcelJS.Workbook();
  await build(wb);
  return asFile('book.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));
}

test('xlsx: multiple sheets, leading zeros, identifiers, dates, currency, percent', async () => {
  const file = await xlsx((wb) => {
    const ws = wb.addWorksheet('Products');
    ws.addRow(['Product Name', 'Serial', 'Code', 'Price', 'Discount', 'Received', 'Big ID']);
    ws.addRow(['Mouse', 1234, '000789', 325, 0.15, new Date(Date.UTC(2026, 9, 19)), '12345678901234567890']);
    ws.getCell('B2').numFmt = '000000';
    ws.getCell('D2').numFmt = '#,##0.00 [$EGP]';
    ws.getCell('E2').numFmt = '0%';
    ws.getCell('F2').numFmt = 'dd/mm/yyyy';
    ws.addRow(['Keyboard', 7, '000001', 1500.5, 0.075, new Date(Date.UTC(2026, 0, 5)), '0012']);
    ws.getCell('B3').numFmt = '000000';
    ws.getCell('D3').numFmt = '#,##0.00 [$EGP]';
    ws.getCell('E3').numFmt = '0.0%';
    ws.getCell('F3').numFmt = 'd-mmm-yy';
    const other = wb.addWorksheet('Stock');
    other.addRow(['SKU', 'Name']);
    other.addRow(['S-01', 'Cable']);
  });
  const result = await readSpreadsheet(file);
  assert.equal(result.format, 'xlsx');
  assert.deepEqual(result.sheets.map((s) => s.name), ['Products', 'Stock']);
  const t = result.sheets[0].table;
  assert.deepEqual(t.headers, ['Product Name', 'Serial', 'Code', 'Price', 'Discount', 'Received', 'Big ID']);
  assert.deepEqual(t.records[0].cells, ['Mouse', '001234', '000789', '325.00 EGP', '15%', '19/10/2026', '12345678901234567890']);
  assert.deepEqual(t.records[1].cells, ['Keyboard', '000007', '000001', '1,500.50 EGP', '7.5%', '5-Jan-26', '0012']);
  assert.equal(t.records[0].raw[3].t, 'n');
  assert.equal(t.records[0].raw[3].v, 325);
  assert.equal(t.records[0].raw[5].t, 'd');
  assert.equal(t.records[0].rowNumber, 2);
  assert.equal(result.sheets[1].table.records[0].cells[0], 'S-01');
});

test('xlsx: formula cached results, missing results, errors, rich text and hyperlinks', async () => {
  const file = await xlsx((wb) => {
    const ws = wb.addWorksheet('F');
    ws.addRow(['Desc', 'Total', 'Missing', 'Err', 'Link']);
    ws.addRow([{ richText: [{ text: 'Great ' }, { text: 'item', font: { bold: true } }] }, { formula: '200+125', result: 325 }, { formula: 'A1*2' }, { formula: '1/0', result: { error: '#DIV/0!' } }, { text: 'Site', hyperlink: 'https://example.com' }]);
  });
  const t = (await readSpreadsheet(file)).sheets[0].table;
  assert.deepEqual(t.records[0].cells, ['Great item', '325', '', '', 'Site']);
  const codes = t.warnings.map((w) => w.code);
  assert.ok(codes.includes('formula-no-cache'));
  assert.ok(codes.includes('error-cells'));
});

test('xlsx: hidden rows/columns, merged cells, duplicate and blank headers, Arabic, precision warning', async () => {
  const file = await xlsx((wb) => {
    const ws = wb.addWorksheet('Data');
    ws.addRow(['Category', 'Name', 'Name', '', 'الاسم', 'ID']);
    ws.addRow(['Tools', 'Hammer', 'H-1', 'x', 'مطرقة', 1234567890123456789]);
    ws.addRow(['', 'Saw', 'S-1', 'y', 'منشار', 1]);
    ws.addRow(['Paint', 'Brush', 'B-1', 'z', 'فرشاة', 2]);
    ws.mergeCells('A2:A3');
    ws.getRow(4).hidden = true;
    ws.getColumn(4).hidden = true;
  });
  const t = (await readSpreadsheet(file)).sheets[0].table;
  assert.deepEqual(t.headers, ['Category', 'Name', 'Name (2)', 'Column 4', 'الاسم', 'ID']);
  assert.equal(t.records[1].cells[0], 'Tools', 'vertically merged value repeated on each row');
  assert.equal(t.records[1].cells[4], 'منشار');
  assert.equal(t.records[2].hidden, true);
  const codes = t.warnings.map((w) => w.code).sort();
  for (const c of ['blank-headers', 'duplicate-headers', 'hidden-columns', 'hidden-rows', 'merged', 'precision']) assert.ok(codes.includes(c), 'warning ' + c);
});

test('header row selection skips report titles', async () => {
  const file = await xlsx((wb) => {
    const ws = wb.addWorksheet('Report');
    ws.addRow(['Inventory report — October 2026']);
    ws.addRow([]);
    ws.addRow(['Product', 'Price']);
    ws.addRow(['Cable', 150]);
  });
  const sheet = (await readSpreadsheet(file)).sheets[0];
  assert.deepEqual(sheet.table.headers, ['Product', 'Price'], 'auto-detects the first row with 2+ filled cells');
  const again = withHeaderRow(sheet, 1);
  assert.equal(again.table.headers[0], 'Inventory report — October 2026');
  const back = withHeaderRow(sheet, 3);
  assert.equal(back.table.records[0].rowNumber, 4);
  assert.throws(() => withHeaderRow(sheet, 4), /no data rows/);
});

test('csv: quotes, leading zeros, semicolons, TSV, UTF-8 BOM and Windows-1256 Arabic', async () => {
  const csv = 'Name,Code,Price\n"Cable, USB",000123,150\nMouse,000007,325\n\n';
  let t = (await readSpreadsheet(asFile('items.csv', new TextEncoder().encode(csv)))).sheets[0].table;
  assert.deepEqual(t.records.map((r) => r.cells), [['Cable, USB', '000123', '150'], ['Mouse', '000007', '325']]);
  t = (await readSpreadsheet(asFile('eu.csv', new TextEncoder().encode('Name;Price\nMouse;325,50\n')))).sheets[0].table;
  assert.deepEqual(t.records[0].cells, ['Mouse', '325,50']);
  t = (await readSpreadsheet(asFile('tab.tsv', new TextEncoder().encode('A\tB\n1\t2\n')))).sheets[0].table;
  assert.deepEqual(t.records[0].cells, ['1', '2']);
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('الاسم,السعر\nماوس,325\n')]);
  t = (await readSpreadsheet(asFile('ar.csv', bom))).sheets[0].table;
  assert.deepEqual(t.headers, ['الاسم', 'السعر']);
  // "ماوس" in Windows-1256: E3 C7 E6 D3
  const cp1256 = new Uint8Array([0x4E, 0x61, 0x6D, 0x65, 0x0A, 0xE3, 0xC7, 0xE6, 0xD3, 0x0A]);
  const r = await readSpreadsheet(asFile('legacy.csv', cp1256));
  assert.equal(r.sheets[0].table.records[0].cells[0], 'ماوس');
  assert.ok(r.sheets[0].table.warnings.some((w) => w.code === 'encoding'));
  assert.equal(decodeText(new Uint8Array([0xFF, 0xFE, 0x41, 0x00])).text, 'A');
  await assert.rejects(() => readSpreadsheet(asFile('bad.csv', new TextEncoder().encode('a,b\n"x,1\n'))), /unmatched quote/);
});

test('legacy .xls (BIFF8): strings, numbers, dates, merged cells, sheets, large shared string table', async () => {
  const r = await readSpreadsheet(asFile('legacy.xls', fs.readFileSync(fixture('legacy.xls'))));
  assert.equal(r.format, 'xls');
  const t = r.sheets[0].table;
  assert.deepEqual(t.headers, ['Product Name', 'Serial', 'Price', 'Received', 'الاسم', 'Qty']);
  assert.deepEqual(t.records[0].cells, ['Mouse', '00123', '325.00', '19/10/2026', 'ماوس', '2']);
  assert.deepEqual(t.records[1].cells, ['Keyboard', '00124', '1,500.50', '05/01/2026', 'لوحة مفاتيح', '1']);
  assert.ok(t.warnings.some((w) => w.code === 'merged'));
  assert.equal(r.sheets[1].name, 'Second');
  assert.equal(r.sheets[1].table.records[4].cells[1], '7.5');
  const big = (await readSpreadsheet(asFile('many-strings.xls', fs.readFileSync(fixture('many-strings.xls'))))).sheets[0].table;
  assert.equal(big.records.length, 3000);
  assert.equal(big.records[2999].cells[0], 'Item number 03000 with a reasonably long description text');
  assert.equal(big.records[2999].cells[1], 'منتج رقم 3000');
});

test('rejects unsupported, fake, empty and oversized files with clear messages', async () => {
  await assert.rejects(() => readSpreadsheet({ name: 'data.ods', size: 10, bytes: new Uint8Array(10) }), /Unsupported file type/);
  await assert.rejects(() => readSpreadsheet({ name: 'big.csv', size: 60 * 1024 * 1024 }), /50 MB/);
  await assert.rejects(() => readSpreadsheet(asFile('empty.csv', new Uint8Array())), /empty/);
  await assert.rejects(() => readSpreadsheet(asFile('fake.xlsx', new TextEncoder().encode('not a zip'))), /valid Excel workbook/);
  await assert.rejects(() => readSpreadsheet(asFile('page.xls', new TextEncoder().encode('<html><table></table></html>'))), /HTML\/XML export/);
  const zip = await xlsx((wb) => { wb.addWorksheet('x').addRow(['a']); });
  await assert.rejects(() => readSpreadsheet(asFile('renamed.csv', zip.bytes)), /Excel workbook saved with a text extension/);
  await assert.rejects(() => readSpreadsheet(asFile('blank.csv', new TextEncoder().encode('\n\n'))), /No sheet with data/);
});

test('large sheets are truncated loudly, never silently', () => {
  const rows = [['A']];
  for (let i = 0; i < 20; i++) rows.push([String(i)]);
  const t = normalizeTable('S', rows, { meta: { truncatedRows: TABLE_LIMITS.maxRows + 5000 } });
  const w = t.warnings.find((x) => x.code === 'truncated-rows');
  assert.equal(w.level, 'error');
  assert.match(w.message, /only the first 100,000/);
});

test('a blank header never hides populated columns to its right', () => {
  const t = normalizeTable('S', [['Name', '', 'Price'], ['Mouse', 'x', '325']]);
  assert.deepEqual(t.headers, ['Name', 'Column 2', 'Price']);
  assert.deepEqual(t.records[0].cells, ['Mouse', 'x', '325']);
});
