// Render Excel cell values the way Excel displays them, for the common number formats.
// Unknown formats fall back to Excel's "General" behaviour (15 significant digits).

import { applyNumberPattern, formatDatePattern, excelSerialToDate } from '../engine/format.js';

const BUILTIN_FORMATS = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  // 14 and 22 are Excel's locale-dependent "short date" formats; shown day-first (Egypt/most of the world).
  12: '# ?/?', 13: '# ??/??', 14: 'dd/mm/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'dd/mm/yyyy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@'
};

export function builtinFormat(id) {
  return BUILTIN_FORMATS[id] || '';
}

/** General format: up to 15 significant digits, no exponent for ordinary magnitudes. */
export function generalNumber(value) {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-9 || abs >= 1e21)) return value.toExponential(9).replace(/\.?0+e/, 'e').toUpperCase();
  return value.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 15 });
}

/** True when a numeric cell may not represent its intended digits (Excel keeps 15 significant digits). */
export function precisionRisk(value) {
  if (!Number.isFinite(value)) return false;
  const abs = Math.abs(value);
  if (abs >= 1e15) return true;
  return false;
}

function stripLiterals(format) {
  return format.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
}

export function isDateFormat(format) {
  if (!format) return false;
  const f = stripLiterals(String(format).split(';')[0]).toLowerCase();
  if (/^general$/.test(f) || f === '@') return false;
  return /[dmyhs]/.test(f.replace(/e[+-]/g, '')) && !/[0#?]/.test(f.replace(/\.0+/, ''));
}

// Excel's built-in "short date" (format 14) is stored by ExcelJS/others as US-style strings.
const SYSTEM_SHORT_DATES = new Set(['mm-dd-yy', 'm/d/yyyy', 'm/d/yy', 'm/d/yyyy h:mm', 'm/d/yy h:mm']);

/** Convert an Excel date format (m, mm, mmm, d, yy, h, AM/PM…) to our pattern tokens. */
export function excelDateToPattern(format) {
  const normalized = String(format).trim().toLowerCase();
  if (SYSTEM_SHORT_DATES.has(normalized)) return normalized.includes('h') ? 'dd/MM/yyyy HH:mm' : 'dd/MM/yyyy';
  const section = String(format).split(';')[0].replace(/\[[^\]]*\]/g, '');
  const tokens = [];
  const re = /"[^"]*"|\\.|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm|a\/p|\.0+|./gi;
  let m;
  while ((m = re.exec(section))) tokens.push(m[0]);
  const hasAmPm = tokens.some((t) => /^(am\/pm|a\/p)$/i.test(t));
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();
    if (t.startsWith('"')) { out.push("'" + t.slice(1, -1).replace(/'/g, '') + "'"); continue; }
    if (t.startsWith('\\')) { out.push(t[1] === "'" ? '' : "'" + t[1] + "'"); continue; }
    if (lower === 'm' || lower === 'mm') {
      // minutes when following an hour or preceding seconds
      const prev = out.slice().reverse().find((x) => /^[Hh]/.test(x) || /^[dMy]/.test(x));
      const next = tokens.slice(i + 1).find((x) => /^[a-z]/i.test(x));
      const isMinute = (prev && /^[Hh]/.test(prev)) || (next && /^s/i.test(next));
      out.push(isMinute ? 'mm' : lower === 'mm' ? 'MM' : 'M');
      continue;
    }
    if (lower === 'mmm') { out.push('MMM'); continue; }
    if (lower === 'mmmm' || lower === 'mmmmm') { out.push('MMMM'); continue; }
    if (lower === 'yyyy') { out.push('yyyy'); continue; }
    if (lower === 'yy') { out.push('yy'); continue; }
    if (['d', 'dd', 'ddd', 'dddd'].includes(lower)) { out.push(lower); continue; }
    if (lower === 'h' || lower === 'hh') { out.push(hasAmPm ? (lower === 'h' ? 'h' : 'hh') : (lower === 'h' ? 'H' : 'HH')); continue; }
    if (lower === 's' || lower === 'ss') { out.push('ss'); continue; }
    if (lower === 'am/pm' || lower === 'a/p') { out.push('tt'); continue; }
    if (/^\.0+$/.test(t)) continue;
    if (/[a-z]/i.test(t)) { out.push("'" + t + "'"); continue; }
    out.push(t === "'" ? '' : t);
  }
  return out.join('');
}

/**
 * Display text for a numeric cell according to its Excel number format.
 * Returns { text, raw } where raw is { t: 'n'|'d', v }.
 */
export function displayNumber(value, numFmt, { date1904 = false } = {}) {
  const format = String(numFmt || 'General');
  if (isDateFormat(format)) {
    const date = excelSerialToDate(value, date1904);
    return { text: date ? formatDatePattern(date, excelDateToPattern(format)) : generalNumber(value), raw: { t: 'd', v: date } };
  }
  return { text: formatExcelNumber(value, format), raw: { t: 'n', v: value } };
}

export function formatExcelNumber(value, numFmt) {
  const format = String(numFmt || 'General');
  if (!Number.isFinite(value)) return '';
  const sections = format.split(';');
  let section = sections[0];
  let v = value;
  if (value < 0 && sections.length > 1 && sections[1].trim()) { section = sections[1]; v = -value; }
  else if (value === 0 && sections.length > 2 && sections[2].trim()) section = sections[2];
  const plain = stripLiterals(section).trim();
  if (!plain || /^general$/i.test(plain) || plain === '@') return generalNumber(value);
  if (/E[+-]/i.test(plain)) {
    const decimals = (((plain.split('.')[1] || '').split(/E/i)[0]).match(/0/g) || []).length;
    return value.toExponential(decimals).toUpperCase().replace(/E([+-])(\d)$/, 'E$10$2');
  }
  if (/\?\/\?/.test(plain) || !/[0#]/.test(plain)) return generalNumber(value);
  // For a dedicated negative section such as "(#,##0.00)" the value is formatted unsigned.
  return applyNumberPattern(v, section);
}
