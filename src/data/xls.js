// Minimal, defensive reader for legacy Excel 97–2003 (.xls, BIFF8) workbooks.
// Reads cell values and cached formula results only; never evaluates formulas or macros.

import CFB from 'cfb';
import { displayNumber, isDateFormat, builtinFormat, precisionRisk } from './excel-format.js';
import { TABLE_LIMITS } from './table.js';

const R = {
  BOF: 0x0809, EOF: 0x000A, CONTINUE: 0x003C, FILEPASS: 0x002F, DATEMODE: 0x0022, FORMAT: 0x041E, XF: 0x00E0,
  BOUNDSHEET: 0x0085, SST: 0x00FC, ROW: 0x0208, COLINFO: 0x007D, LABELSST: 0x00FD, LABEL: 0x0204,
  NUMBER: 0x0203, RK: 0x027E, MULRK: 0x00BD, BOOLERR: 0x0205, FORMULA: 0x0006, STRING: 0x0207, MERGEDCELLS: 0x00E5
};
const DATE_BUILTINS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function readRecords(data, offset = 0) {
  const records = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = offset;
  while (pos + 4 <= data.length) {
    const type = view.getUint16(pos, true);
    const length = view.getUint16(pos + 2, true);
    const start = pos + 4;
    if (start + length > data.length) break;
    records.push({ type, start, length, body: data.subarray(start, start + length) });
    pos = start + length;
    if (type === R.EOF && offset !== 0) break;
  }
  return records;
}

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000; }
function f64(b, o) { return new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true); }

function decodeChars(bytes, highByte) {
  if (highByte) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    return s;
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** XLUnicodeString with 16-bit length (LABEL, FORMAT, STRING records). */
function xlString(b, o, lengthBytes = 2) {
  const cch = lengthBytes === 2 ? u16(b, o) : b[o];
  let p = o + lengthBytes;
  const flags = b[p++];
  const high = flags & 1;
  let runs = 0; let ext = 0;
  if (flags & 8) { runs = u16(b, p); p += 2; }
  if (flags & 4) { ext = u32(b, p); p += 4; }
  const size = high ? cch * 2 : cch;
  const text = decodeChars(b.subarray(p, p + size), high);
  return { text, end: p + size + runs * 4 + ext };
}

function rk(value) {
  let n;
  if (value & 2) {
    n = value >> 2; // signed 30-bit integer
  } else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, value & 0xFFFFFFFC, true);
    buf.setUint32(0, 0, true);
    n = buf.getFloat64(0, true);
  }
  return value & 1 ? n / 100 : n;
}

/** Shared string table, which may be split across CONTINUE records (a new flags byte starts each continuation). */
function readSst(segments) {
  let seg = 0; let pos = 0;
  const strings = [];
  const ensure = () => { while (seg < segments.length && pos >= segments[seg].length) { seg++; pos = 0; } };
  const byte = () => { ensure(); if (seg >= segments.length) throw new Error('eof'); return segments[seg][pos++]; };
  const word = () => byte() | (byte() << 8);
  const dword = () => word() + word() * 0x10000;
  const skip = (n) => { let left = n; while (left > 0) { ensure(); if (seg >= segments.length) return; const take = Math.min(left, segments[seg].length - pos); pos += take; left -= take; } };
  try {
    skip(4); // cstTotal
    const unique = dword();
    for (let i = 0; i < unique; i++) {
      const cch = word();
      let flags = byte();
      let runs = 0; let ext = 0;
      if (flags & 8) runs = word();
      if (flags & 4) ext = dword();
      let text = '';
      let remaining = cch;
      let high = flags & 1;
      while (remaining > 0) {
        if (pos >= segments[seg].length) {
          // character data continues in the next CONTINUE record, which starts with a fresh flags byte
          seg++; pos = 0;
          if (seg >= segments.length) break;
          high = segments[seg][pos++] & 1;
        }
        const width = high ? 2 : 1;
        const available = Math.floor((segments[seg].length - pos) / width);
        if (available === 0) { pos = segments[seg].length; continue; }
        const take = Math.min(remaining, available);
        text += decodeChars(segments[seg].subarray(pos, pos + take * width), high);
        pos += take * width;
        remaining -= take;
      }
      skip(runs * 4 + ext);
      strings.push(text);
    }
  } catch { /* truncated SST: keep what was read */ }
  return strings;
}

export function readXls(bytes) {
  let container;
  try { container = CFB.read(bytes, { type: 'buffer' }); }
  catch { throw new Error('This .xls file could not be opened. It may be damaged; save it again from Excel as .xlsx.'); }
  const entry = CFB.find(container, 'Workbook') || CFB.find(container, 'Book');
  if (!entry) throw new Error('This .xls file has no workbook data. Save it again from Excel as .xlsx.');
  if (entry.name === 'Book') throw new Error('This is an Excel 5.0/95 workbook, which is not supported. Open it in Excel and save as .xlsx.');
  const data = entry.content instanceof Uint8Array ? entry.content : Uint8Array.from(entry.content);
  const globals = readRecords(data, 0);
  const formats = new Map();
  const xfFormats = [];
  const sheetsInfo = [];
  let date1904 = false;
  const sstSegments = [];
  for (let i = 0; i < globals.length; i++) {
    const rec = globals[i];
    const b = rec.body;
    if (rec.type === R.BOF && i > 0) break;
    switch (rec.type) {
      case R.BOF: if (u16(b, 0) !== 0x0600) throw new Error('Only Excel 97–2003 (BIFF8) .xls files are supported. Save it from Excel as .xlsx.'); break;
      case R.FILEPASS: throw new Error('This .xls workbook is password-protected. Remove the password in Excel and save again.');
      case R.DATEMODE: date1904 = u16(b, 0) === 1; break;
      case R.FORMAT: formats.set(u16(b, 0), xlString(b, 2).text); break;
      case R.XF: xfFormats.push(u16(b, 2)); break;
      case R.BOUNDSHEET: {
        const name = xlString(b, 6, 1).text;
        sheetsInfo.push({ offset: u32(b, 0), state: b[4] & 3, type: b[5], name });
        break;
      }
      case R.SST: {
        sstSegments.push(b);
        for (let j = i + 1; j < globals.length && globals[j].type === R.CONTINUE; j++) sstSegments.push(globals[j].body);
        break;
      }
      default: break;
    }
  }
  const sst = sstSegments.length ? readSst(sstSegments) : [];
  const numFmtForXf = (ixfe) => {
    const id = xfFormats[ixfe] ?? 0;
    return formats.get(id) || builtinFormat(id) || (DATE_BUILTINS.has(id) ? 'yyyy-mm-dd' : 'General');
  };
  const isDateXf = (ixfe) => { const id = xfFormats[ixfe] ?? 0; return DATE_BUILTINS.has(id) || isDateFormat(formats.get(id) || ''); };

  const sheets = [];
  for (const info of sheetsInfo) {
    if (info.type !== 0) continue; // charts, macro sheets
    const records = readRecords(data, info.offset);
    const cells = new Map();
    let maxRow = -1; let maxCol = -1;
    const hiddenRowsAbs = new Set();
    const hiddenColumns = new Set();
    const mergedRanges = [];
    const merges = [];
    let formulaWithoutValue = 0; let errorCells = 0;
    let pendingFormula = null;
    const put = (row, col, cell) => {
      if (row >= TABLE_LIMITS.maxRows + TABLE_LIMITS.headerScanRows || col >= TABLE_LIMITS.maxColumns) { if (row > maxRow) maxRow = row; if (col > maxCol) maxCol = col; return; }
      cells.set(row * 1024 + col, cell);
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    };
    const numberCell = (value, ixfe) => {
      const shown = displayNumber(value, isDateXf(ixfe) ? numFmtForXf(ixfe) || 'yyyy-mm-dd' : numFmtForXf(ixfe), { date1904 });
      return { text: shown.text, raw: shown.raw, precision: shown.raw.t === 'n' && precisionRisk(value) };
    };
    for (const rec of records) {
      const b = rec.body;
      switch (rec.type) {
        case R.ROW: if (u32(b, 12) & 0x20) hiddenRowsAbs.add(u16(b, 0)); break;
        case R.COLINFO: if (u16(b, 8) & 1) for (let c = u16(b, 0); c <= Math.min(u16(b, 2), 255); c++) hiddenColumns.add(c); break;
        case R.LABELSST: put(u16(b, 0), u16(b, 2), { text: sst[u32(b, 6)] ?? '', raw: { t: 's', v: sst[u32(b, 6)] ?? '' } }); break;
        case R.LABEL: { const t = xlString(b, 6).text; put(u16(b, 0), u16(b, 2), { text: t, raw: { t: 's', v: t } }); break; }
        case R.NUMBER: put(u16(b, 0), u16(b, 2), numberCell(f64(b, 6), u16(b, 4))); break;
        case R.RK: put(u16(b, 0), u16(b, 2), numberCell(rk(u32(b, 6)), u16(b, 4))); break;
        case R.MULRK: {
          const row = u16(b, 0); const first = u16(b, 2);
          const count = (rec.length - 6) / 6;
          for (let k = 0; k < count; k++) put(row, first + k, numberCell(rk(u32(b, 4 + k * 6 + 2)), u16(b, 4 + k * 6)));
          break;
        }
        case R.BOOLERR: {
          if (b[7]) { errorCells++; put(u16(b, 0), u16(b, 2), { text: '' }); } else put(u16(b, 0), u16(b, 2), { text: b[6] ? 'TRUE' : 'FALSE', raw: { t: 'b', v: Boolean(b[6]) } });
          break;
        }
        case R.FORMULA: {
          const row = u16(b, 0); const col = u16(b, 2); const ixfe = u16(b, 4);
          if (b[12] === 0xFF && b[13] === 0xFF) {
            const kind = b[6];
            if (kind === 0) pendingFormula = { row, col };
            else if (kind === 1) put(row, col, { text: b[8] ? 'TRUE' : 'FALSE', raw: { t: 'b', v: Boolean(b[8]) } });
            else if (kind === 2) { errorCells++; put(row, col, { text: '' }); }
            else put(row, col, { text: '' });
          } else {
            const value = f64(b, 6);
            if (Number.isFinite(value)) put(row, col, numberCell(value, ixfe)); else { formulaWithoutValue++; put(row, col, { text: '' }); }
          }
          break;
        }
        case R.STRING: if (pendingFormula) { const t = xlString(b, 0).text; put(pendingFormula.row, pendingFormula.col, { text: t, raw: { t: 's', v: t } }); pendingFormula = null; } break;
        case R.MERGEDCELLS: {
          const count = u16(b, 0);
          for (let k = 0; k < count && 2 + k * 8 + 8 <= rec.length; k++) {
            const o = 2 + k * 8;
            const m = { r1: u16(b, o), r2: u16(b, o + 2), c1: u16(b, o + 4), c2: u16(b, o + 6) };
            merges.push(m);
            mergedRanges.push(colName(m.c1) + (m.r1 + 1) + ':' + colName(m.c2) + (m.r2 + 1));
          }
          break;
        }
        default: break;
      }
    }
    // Merged ranges: rows covered by a vertical merge repeat the value in the merge's first column
    // (e.g. a category merged down several rows); other columns of the range stay empty.
    for (const m of merges) {
      const master = cells.get(m.r1 * 1024 + m.c1);
      if (!master) continue;
      for (let r = m.r1 + 1; r <= Math.min(m.r2, m.r1 + 5000); r++) put(r, m.c1, master);
    }
    const limitRows = TABLE_LIMITS.maxRows + TABLE_LIMITS.headerScanRows;
    const rowCount = Math.min(maxRow + 1, limitRows);
    const width = Math.min(maxCol + 1, TABLE_LIMITS.maxColumns);
    const grid = [];
    const hiddenRows = new Set();
    const sourceRowNumbers = [];
    for (let r = 0; r < rowCount; r++) {
      const row = new Array(Math.max(0, width));
      for (let c = 0; c < width; c++) row[c] = cells.get(r * 1024 + c) || { text: '' };
      if (hiddenRowsAbs.has(r)) hiddenRows.add(r);
      grid.push(row);
      sourceRowNumbers.push(r + 1);
    }
    sheets.push({
      name: info.name, hiddenSheet: info.state !== 0, grid,
      meta: { hiddenRows, hiddenColumns, mergedRanges, sourceRowNumbers, truncatedRows: maxRow + 1 > limitRows ? maxRow + 1 : 0, truncatedColumns: maxCol + 1 > TABLE_LIMITS.maxColumns ? maxCol + 1 : 0, formulaWithoutValue, errorCells }
    });
  }
  return { sheets, date1904 };
}

function colName(c) {
  let s = '';
  for (let v = c + 1; v > 0; v = Math.floor((v - 1) / 26)) s = String.fromCharCode(65 + ((v - 1) % 26)) + s;
  return s;
}
