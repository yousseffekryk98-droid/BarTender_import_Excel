// Turn a grid of cells into a data table with headers, records and explicit warnings.
// Nothing is dropped silently: truncation, duplicates, blank headers, hidden and merged
// cells and precision risks are reported in `warnings`.

import { headerKey } from '../engine/binding.js';

export const TABLE_LIMITS = Object.freeze({ maxRows: 100_000, maxColumns: 256, headerScanRows: 50 });

/**
 * A grid cell is a string or { text, raw: { t, v }, hidden, merged, precision }.
 * meta = { hiddenRows: Set<rowIndex>, hiddenColumns: Set<colIndex>, mergedRanges: [...], truncatedRows, truncatedColumns, sourceRowNumbers }
 */
export function cellText(cell) {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'object') return String(cell.text ?? '');
  return String(cell);
}

export function detectHeaderRow(rows) {
  // First row (within the scan window) with at least two non-empty cells, or the first non-empty row.
  const limit = Math.min(rows.length, TABLE_LIMITS.headerScanRows);
  let firstNonEmpty = -1;
  for (let i = 0; i < limit; i++) {
    const filled = (rows[i] || []).filter((c) => cellText(c).trim()).length;
    if (filled && firstNonEmpty < 0) firstNonEmpty = i;
    if (filled >= 2) return i;
  }
  return Math.max(0, firstNonEmpty);
}

export function normalizeTable(name, rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const meta = options.meta || {};
  const headIndex = Number.isInteger(options.headerIndex) && options.headerIndex >= 0 && options.headerIndex < rows.length
    ? options.headerIndex : detectHeaderRow(rows);
  const headRow = rows[headIndex] || [];
  const warnings = [];
  // Width = widest populated row in the data region (a blank header never hides data to its right).
  let width = 0;
  for (let r = headIndex; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = row.length - 1; c >= width; c--) if (cellText(row[c]).trim()) { width = c + 1; break; }
  }
  width = Math.max(1, width);
  const used = new Map();
  const blankHeaders = [];
  const headers = Array.from({ length: width }, (_, i) => {
    let title = cellText(headRow[i]).trim().replace(/\s+/g, ' ');
    if (!title) { title = 'Column ' + (i + 1); blankHeaders.push(i + 1); }
    const key = headerKey(title);
    const seen = used.get(key) || 0;
    used.set(key, seen + 1);
    if (seen) title += ' (' + (seen + 1) + ')';
    return title;
  });
  const originalKeys = headRow.slice(0, width).map((c) => headerKey(cellText(c)));
  const duplicateHeaders = [...new Set(originalKeys.filter((k, i) => k && originalKeys.indexOf(k) !== i))]
    .map((k) => cellText(headRow[originalKeys.indexOf(k)]).trim());
  if (duplicateHeaders.length) warnings.push({ code: 'duplicate-headers', level: 'warning', message: 'Duplicate column headings: ' + duplicateHeaders.join(', ') + '. Copies were renamed "(2)", "(3)"…; rename them in Excel for reliable mapping.' });
  if (blankHeaders.length) warnings.push({ code: 'blank-headers', level: 'info', message: 'Columns without a heading were named ' + blankHeaders.slice(0, 8).map((n) => '"Column ' + n + '"').join(', ') + (blankHeaders.length > 8 ? '…' : '') + '.' });

  const records = [];
  let precisionCells = [];
  let hiddenRecordCount = 0;
  for (let r = headIndex + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const cells = new Array(width);
    const raw = new Array(width);
    let any = false;
    for (let c = 0; c < width; c++) {
      const cell = row[c];
      const text = cellText(cell);
      cells[c] = options.trim === false ? text : text.trim();
      raw[c] = cell && typeof cell === 'object' && cell.raw ? cell.raw : null;
      if (cells[c] !== '') any = true;
      if (cell && typeof cell === 'object' && cell.precision && precisionCells.length < 20) precisionCells.push(headers[c] + ' row ' + (meta.sourceRowNumbers?.[r] ?? r + 1));
    }
    if (!any) continue;
    const rowNumber = meta.sourceRowNumbers?.[r] ?? r + 1;
    const hidden = Boolean(meta.hiddenRows?.has(r));
    if (hidden) hiddenRecordCount++;
    records.push({ id: String(rowNumber), rowNumber, cells, raw, hidden });
  }
  if (precisionCells.length) warnings.push({ code: 'precision', level: 'warning', message: 'Some numbers have more than 15 digits and Excel may already have changed them (' + precisionCells.slice(0, 5).join('; ') + (precisionCells.length > 5 ? '…' : '') + '). Store long identifiers as Text in Excel.' });
  if (hiddenRecordCount) warnings.push({ code: 'hidden-rows', level: 'info', message: hiddenRecordCount + ' row(s) are hidden in Excel. They are imported and marked "hidden"; use the filter to exclude them.' });
  const hiddenColumns = [...(meta.hiddenColumns || [])].filter((c) => c < width).map((c) => headers[c]);
  if (hiddenColumns.length) warnings.push({ code: 'hidden-columns', level: 'info', message: 'Hidden Excel columns were imported: ' + hiddenColumns.slice(0, 8).join(', ') + (hiddenColumns.length > 8 ? '…' : '') + '.' });
  if (meta.mergedRanges?.length) warnings.push({ code: 'merged', level: 'info', message: meta.mergedRanges.length + ' merged cell range(s) found (' + meta.mergedRanges.slice(0, 4).join(', ') + (meta.mergedRanges.length > 4 ? '…' : '') + '). A value merged down several rows is repeated on each of those rows; merged columns to the right are empty.' });
  if (meta.truncatedRows) warnings.push({ code: 'truncated-rows', level: 'error', message: 'This sheet has ' + meta.truncatedRows.toLocaleString('en-US') + ' rows; only the first ' + TABLE_LIMITS.maxRows.toLocaleString('en-US') + ' were imported. Split the file to print the rest.' });
  if (meta.truncatedColumns) warnings.push({ code: 'truncated-columns', level: 'error', message: 'This sheet has ' + meta.truncatedColumns + ' columns; only the first ' + TABLE_LIMITS.maxColumns + ' were imported.' });
  if (meta.formulaWithoutValue) warnings.push({ code: 'formula-no-cache', level: 'warning', message: meta.formulaWithoutValue + ' formula cell(s) have no saved result. Open the file in Excel, let it calculate, and save again.' });
  if (meta.errorCells) warnings.push({ code: 'error-cells', level: 'warning', message: meta.errorCells + ' cell(s) contain Excel errors such as #N/A or #REF!; they are imported as empty.' });
  for (const w of meta.extraWarnings || []) warnings.push(w);
  return {
    name, headers, records,
    headerRow: (meta.sourceRowNumbers?.[headIndex] ?? headIndex + 1),
    headerIndex: headIndex,
    duplicateHeaders, warnings
  };
}
