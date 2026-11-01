// Export a fill-in Excel workbook containing exactly the data columns a label design needs.
// The Data worksheet is first so the existing importer can recognize it immediately.
import { headerKey, templateFieldNames } from '../engine/binding.js';

export function designColumns(template) {
  const seen = new Set();
  const columns = [];
  for (const field of templateFieldNames(template)) {
    const name = String(field ?? '').trim();
    const key = headerKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    columns.push(name);
  }
  // Static-only designs can still export a useful starter, but no label fields use it.
  return columns.length ? columns : ['Label Text'];
}

export async function createDesignWorkbook(template) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Excel Label Studio';
  workbook.subject = 'Fill in Excel data for ' + template.name;
  workbook.created = new Date();
  const columns = designColumns(template);
  const sheet = workbook.addWorksheet('Data');
  sheet.columns = columns.map((name, i) => ({
    header: name, key: 'field' + i, width: Math.max(16, Math.min(36, name.length + 5)),
    style: { numFmt: '@' } // retain leading zeros in barcode/product identifiers
  }));
  const head = sheet.getRow(1);
  head.height = 28;
  head.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B69' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF12605C' } } };
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  const help = workbook.addWorksheet('Instructions');
  help.getColumn(1).width = 95;
  [
    'Excel Label Studio — data-entry guide',
    'Design: ' + template.name,
    'Enter each product / item / patient on a separate row of the Data sheet, beginning in row 2.',
    'Do not change the first-row column headers. They match the saved label design exactly.',
    'Keep product codes, barcodes and identifiers as text to retain leading zeros.',
    'Save this file as .xlsx. In Excel Label Studio, open your saved design and connect this workbook.',
    'Review the Print screen: every imported row starts selected; uncheck rows you do not want to print.',
    columns.length === 1 && columns[0] === 'Label Text' && !templateFieldNames(template).length
      ? 'This design has no linked Excel fields yet. Add an Excel-linked object to the design to print the imported values.'
      : 'Columns used by this design: ' + columns.join(', ')
  ].forEach((message, i) => {
    const cell = help.getCell(i + 1, 1);
    cell.value = message;
    cell.alignment = { wrapText: true, vertical: 'middle' };
    if (i === 0) { cell.font = { bold: true, size: 14, color: { argb: 'FF176B69' } }; help.getRow(1).height = 29; }
    else { help.getRow(i + 1).height = 25; }
  });
  const bytes = await workbook.xlsx.writeBuffer();
  return { bytes: new Uint8Array(bytes), columns };
}
