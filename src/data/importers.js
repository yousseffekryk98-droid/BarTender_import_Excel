// Spreadsheet import: .xlsx/.xlsm (ExcelJS), legacy .xls (BIFF8 reader), .csv/.tsv/.txt (PapaParse).
// Formulas are never evaluated — the result Excel saved is used. Macros are never run.

import Papa from 'papaparse';
import { normalizeTable, TABLE_LIMITS } from './table.js';
import { displayNumber, formatExcelNumber, excelDateToPattern, isDateFormat, precisionRisk, generalNumber } from './excel-format.js';
import { formatDatePattern } from '../engine/format.js';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const SUPPORTED_EXTENSIONS = ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'txt'];

export function fileExtension(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return match ? match[1].toLowerCase() : '';
}

async function bytesOf(file) {
  if (file.bytes instanceof Uint8Array) return file.bytes;
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  if (typeof file.text === 'function') return new TextEncoder().encode(await file.text());
  throw new Error('The file could not be read.');
}

/** Decode text bytes: BOM detection, strict UTF-8, then Windows-1256 (Arabic Excel CSV) fallback. */
export function decodeText(bytes) {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 (BOM)' };
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16 LE' };
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16 BE' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
  } catch {
    try { return { text: new TextDecoder('windows-1256').decode(bytes), encoding: 'Windows-1256 (Arabic)' }; }
    catch { return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' }; }
  }
}

function looksLikeZip(bytes) { return bytes[0] === 0x50 && bytes[1] === 0x4B; }
function looksLikeOle(bytes) { return bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0; }

/**
 * Read a spreadsheet file.
 * file = File | { name, size, bytes?: Uint8Array, arrayBuffer?(), text?() }
 * Returns { fileName, format, encoding?, sheets: [{ name, grid, meta, hiddenSheet, table }] }
 */
export async function readSpreadsheet(file, options = {}) {
  if (!file) throw new Error('Choose an Excel (.xlsx, .xls) or CSV file.');
  if (file.size > MAX_FILE_BYTES) throw new Error('The file is larger than 50 MB. Split it into smaller files.');
  const extension = fileExtension(file.name);
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new Error('Unsupported file type ".' + (extension || '?') + '". Use .xlsx, .xlsm, .xls, .csv or .tsv.');
  }
  const bytes = await bytesOf(file);
  if (!bytes.length) throw new Error('The file is empty.');
  let result;
  if (extension === 'csv' || extension === 'tsv' || extension === 'txt') {
    if (looksLikeZip(bytes) || looksLikeOle(bytes)) throw new Error('This file is an Excel workbook saved with a text extension. Rename it to .xlsx/.xls or re-save it as CSV.');
    result = readDelimited(file.name, bytes, extension, options);
  } else if (looksLikeOle(bytes)) {
    const { readXls } = await import('./xls.js');
    result = { fileName: file.name, format: 'xls', ...readXls(bytes, options) };
  } else if (looksLikeZip(bytes)) {
    result = { fileName: file.name, format: extension, ...(await readXlsx(bytes, options)) };
  } else if (extension === 'xls' && /^\s*</.test(new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 200)))) {
    throw new Error('This ".xls" file is actually an HTML/XML export. Open it in Excel and use Save As → Excel Workbook (.xlsx).');
  } else {
    throw new Error('This does not look like a valid Excel workbook (it may be encrypted or damaged). Save it again from Excel as .xlsx.');
  }
  result.sheets = result.sheets.map((sheet) => ({ ...sheet, table: normalizeTable(sheet.name, sheet.grid, { meta: sheet.meta }) }));
  const populated = result.sheets.filter((s) => s.table && s.table.records.length);
  if (!populated.length) throw new Error('No sheet with data rows was found in this file.');
  return result;
}

/** Re-build the table of an already imported sheet with another header row (1-based within the grid). */
export function withHeaderRow(sheet, headerRowNumber) {
  const index = sheet.meta?.sourceRowNumbers ? sheet.meta.sourceRowNumbers.indexOf(headerRowNumber) : headerRowNumber - 1;
  const table = normalizeTable(sheet.name, sheet.grid, { meta: sheet.meta, headerIndex: index < 0 ? headerRowNumber - 1 : index });
  if (!table || !table.records.length) throw new Error('There are no data rows below row ' + headerRowNumber + '.');
  return { ...sheet, table };
}

// ---------- CSV / TSV ----------

function readDelimited(fileName, bytes, extension, options) {
  const { text, encoding } = decodeText(bytes);
  // Detect the delimiter on non-empty lines, then parse keeping empty lines so row numbers match the file.
  const delimiter = options.delimiter || (extension === 'tsv' ? '\t'
    : Papa.parse(text, { delimitersToGuess: [',', ';', '\t', '|'], skipEmptyLines: 'greedy', preview: 50 }).meta.delimiter || ',');
  const parsed = Papa.parse(text, {
    delimiter, skipEmptyLines: false, dynamicTyping: false, preview: TABLE_LIMITS.maxRows + TABLE_LIMITS.headerScanRows + 1
  });
  const fatal = parsed.errors.find((e) => e.type === 'Quotes');
  if (fatal) throw new Error('CSV problem near row ' + (Number(fatal.row) + 1) + ': ' + fatal.message + '. Check for an unmatched quote (").');
  let rows = parsed.data;
  // drop trailing empty lines
  while (rows.length && rows[rows.length - 1].every((c) => String(c ?? '').trim() === '')) rows.pop();
  const limit = TABLE_LIMITS.maxRows + TABLE_LIMITS.headerScanRows;
  let truncatedRows = 0;
  if (rows.length > limit || parsed.meta.truncated) { truncatedRows = Math.max(rows.length, limit + 1); rows = rows.slice(0, limit); }
  let truncatedColumns = 0;
  const grid = rows.map((row) => {
    if (row.length > TABLE_LIMITS.maxColumns) truncatedColumns = Math.max(truncatedColumns, row.length);
    return row.slice(0, TABLE_LIMITS.maxColumns).map((v) => String(v ?? ''));
  });
  const extraWarnings = [];
  if (encoding.startsWith('Windows')) extraWarnings.push({ code: 'encoding', level: 'info', message: 'The CSV is not UTF-8; it was read as ' + encoding + '. If text looks wrong, save it from Excel as "CSV UTF-8".' });
  return {
    fileName, format: extension, encoding,
    sheets: [{ name: fileName.replace(/\.[^.]+$/, ''), grid, hiddenSheet: false, meta: { truncatedRows, truncatedColumns, extraWarnings, delimiter: parsed.meta.delimiter } }]
  };
}

// ---------- XLSX (ExcelJS) ----------

let ExcelJSPromise = null;
async function loadExcelJS() {
  if (!ExcelJSPromise) ExcelJSPromise = import('exceljs').then((m) => m.default || m);
  return ExcelJSPromise;
}

function columnLetters(n) {
  let s = '';
  for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) s = String.fromCharCode(65 + ((v - 1) % 26)) + s;
  return s;
}

export function exceljsCellToGridCell(cell, ctx) {
  // Merged ranges: keep the value only in the merge's first column (repeated down the rows it spans).
  if (cell.isMerged && cell.master && cell.master !== cell && cell.master.col !== cell.col) return { text: '' };
  const value = cell.value;
  const numFmt = (cell.isMerged && cell.master ? cell.master.numFmt : cell.numFmt) || 'General';
  const resolve = (v, depth = 0) => {
    if (v === null || v === undefined) return { text: '' };
    if (typeof v === 'number') {
      const shown = displayNumber(v, numFmt, ctx);
      return { text: shown.text, raw: shown.raw, precision: shown.raw.t === 'n' && precisionRisk(v) };
    }
    if (typeof v === 'string') return { text: v, raw: { t: 's', v } };
    if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', raw: { t: 'b', v } };
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) return { text: '' };
      const pattern = isDateFormat(numFmt) ? excelDateToPattern(numFmt) : (v.getUTCHours() || v.getUTCMinutes() ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
      return { text: formatDatePattern(v, pattern), raw: { t: 'd', v } };
    }
    if (typeof v === 'object' && depth < 3) {
      if (Array.isArray(v.richText)) { const t = v.richText.map((r) => r.text ?? '').join(''); return { text: t, raw: { t: 's', v: t } }; }
      if ('formula' in v || 'sharedFormula' in v) {
        if (v.result === undefined || v.result === null) { ctx.formulaWithoutValue++; return { text: '' }; }
        if (typeof v.result === 'object' && v.result && 'error' in v.result) { ctx.errorCells++; return { text: '' }; }
        return resolve(v.result, depth + 1);
      }
      if ('error' in v) { ctx.errorCells++; return { text: '' }; }
      if ('text' in v) return resolve(v.text, depth + 1);
      if ('hyperlink' in v) return { text: String(v.hyperlink) };
    }
    return { text: String(cell.text ?? '') };
  };
  return resolve(value);
}

async function readXlsx(bytes, options) {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes, { ignoreNodes: ['dataValidations', 'conditionalFormatting', 'drawing', 'picture', 'tableParts', 'extLst'] });
  } catch (error) {
    const message = String(error?.message || '');
    if (/encrypt|password|CFB/i.test(message)) throw new Error('This workbook is password-protected. Remove the password in Excel and save again.');
    throw new Error('This workbook could not be opened (' + message.slice(0, 120) + '). Save it again from Excel as .xlsx.');
  }
  const date1904 = Boolean(workbook.properties?.date1904);
  const sheets = [];
  for (const worksheet of workbook.worksheets) {
    const ctx = { date1904, formulaWithoutValue: 0, errorCells: 0 };
    const rowCount = worksheet.rowCount || 0;
    const columnCount = worksheet.columnCount || 0;
    const limit = TABLE_LIMITS.maxRows + TABLE_LIMITS.headerScanRows;
    const maxRow = Math.min(rowCount, limit);
    const width = Math.min(columnCount, TABLE_LIMITS.maxColumns);
    const grid = [];
    const hiddenRows = new Set();
    const sourceRowNumbers = [];
    for (let r = 1; r <= maxRow; r++) {
      const row = worksheet.getRow(r);
      if (row.hidden) hiddenRows.add(grid.length);
      const cells = new Array(width);
      for (let c = 1; c <= width; c++) cells[c - 1] = exceljsCellToGridCell(row.getCell(c), ctx);
      grid.push(cells);
      sourceRowNumbers.push(r);
    }
    const hiddenColumns = new Set();
    for (let c = 1; c <= width; c++) { try { if (worksheet.getColumn(c).hidden) hiddenColumns.add(c - 1); } catch { /* ignore */ } }
    const mergedRanges = [];
    for (const range of Object.values(worksheet._merges || {})) {
      const text = range?.range || (range?.tl && range?.br ? range.tl + ':' + range.br : '') || String(range?.shortRange || '');
      if (text) mergedRanges.push(text);
    }
    sheets.push({
      name: worksheet.name,
      hiddenSheet: worksheet.state === 'hidden' || worksheet.state === 'veryHidden',
      grid,
      meta: {
        hiddenRows, hiddenColumns, mergedRanges, sourceRowNumbers,
        truncatedRows: rowCount > limit ? rowCount : 0,
        truncatedColumns: columnCount > TABLE_LIMITS.maxColumns ? columnCount : 0,
        formulaWithoutValue: ctx.formulaWithoutValue, errorCells: ctx.errorCells,
        lastColumnLetter: columnLetters(width)
      }
    });
  }
  return { sheets, date1904 };
}

export { generalNumber, formatExcelNumber };
