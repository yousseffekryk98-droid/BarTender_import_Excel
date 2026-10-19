// Number, date and text formatting for label data. Pure functions, no DOM.

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

/** Convert Arabic-Indic / Persian digits and separators to Latin so they can be parsed. */
export function normalizeDigits(text) {
  return String(text ?? '').replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN.indexOf(d)))
    .replace(/٫/g, '.').replace(/٬/g, ',');
}

export function toArabicDigits(text) {
  return String(text ?? '').replace(/[0-9]/g, (d) => ARABIC_INDIC[Number(d)]);
}

/**
 * Parse a number from spreadsheet text: "1,234.50", "EGP 325", "15%", "(12)", "٣٢٥".
 * Returns null when the text is not a single number.
 */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  let text = normalizeDigits(value).trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1).trim(); }
  let percent = false;
  if (text.endsWith('%')) { percent = true; text = text.slice(0, -1).trim(); }
  // strip currency words/symbols at either end
  text = text.replace(/^[^\d\-+.]+/, '').replace(/[^\d]+$/, '').trim();
  if (!/^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?$/.test(text) || !/\d/.test(text)) return null;
  let number = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  if (percent) number /= 100;
  return negative ? -number : number;
}

const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * Parse a date from: Date, ISO "2026-10-19", "2026-10-19 14:30", "19/10/2026", "19-Oct-2026", "Oct 19 2026".
 * Slash/dot/dash numeric dates use dateOrder ('DMY' default, or 'MDY', 'YMD').
 * Dates are returned as UTC midnight (+ time) to avoid time-zone shifts.
 */
export function parseDateValue(value, dateOrder = 'DMY') {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = normalizeDigits(value).trim();
  if (!text) return null;
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\.\d+)?(Z)?$/);
  if (m) return makeDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = text.match(/^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (m) {
    let [a, b, c] = [+m[1], +m[2], +m[3]];
    let y; let mo; let d;
    if (m[1].length === 4) { y = a; mo = b; d = c; }
    else if (dateOrder === 'MDY') { mo = a; d = b; y = c; }
    else { d = a; mo = b; y = c; }
    if (y < 100) y += y < 70 ? 2000 : 1900;
    let hours = +(m[4] || 0);
    if (m[7]) { const pm = /p/i.test(m[7]); hours = (hours % 12) + (pm ? 12 : 0); }
    return makeDate(y, mo, d, hours, +(m[5] || 0), +(m[6] || 0));
  }
  m = text.match(/^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.,]+(\d{2,4})$/);
  if (m) {
    const mo = monthIndex(m[2]);
    if (mo >= 0) return makeDate(normYear(+m[3]), mo + 1, +m[1]);
  }
  m = text.match(/^([A-Za-z]{3,9})[\s\-/.]+(\d{1,2}),?[\s\-/.]+(\d{2,4})$/);
  if (m) {
    const mo = monthIndex(m[1]);
    if (mo >= 0) return makeDate(normYear(+m[3]), mo + 1, +m[2]);
  }
  return null;
}

function normYear(y) { return y < 100 ? y + (y < 70 ? 2000 : 1900) : y; }
function monthIndex(name) {
  const n = name.toLowerCase();
  return MONTHS_EN.findIndex((full) => full === n || full.slice(0, 3) === n.slice(0, 3) && n.length >= 3 && full.startsWith(n));
}
function makeDate(y, mo, d, h = 0, mi = 0, s = 0) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** Excel serial date (1900 system) → UTC Date. */
export function excelSerialToDate(serial, date1904 = false) {
  if (!Number.isFinite(serial)) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.round(serial * 86400000));
}

function monthName(index, style, locale) {
  try {
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-US', { month: style, timeZone: 'UTC' })
      .format(new Date(Date.UTC(2000, index, 1)));
  } catch { const n = MONTHS_EN[index]; return style === 'short' ? n.slice(0, 3) : n; }
}
function weekdayName(date, style, locale) {
  try {
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-US', { weekday: style, timeZone: 'UTC' }).format(date);
  } catch { return ''; }
}
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Format a date with tokens: yyyy yy MMMM MMM MM M dddd ddd dd d HH H hh h mm ss tt.
 * Text in 'single quotes' is literal.
 */
export function formatDatePattern(date, pattern = 'dd/MM/yyyy', locale = 'en') {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const y = date.getUTCFullYear(); const mo = date.getUTCMonth(); const d = date.getUTCDate();
  const h = date.getUTCHours(); const mi = date.getUTCMinutes(); const s = date.getUTCSeconds();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const tokens = {
    yyyy: () => String(y), yy: () => pad(y % 100),
    MMMM: () => capital(monthName(mo, 'long', locale)), MMM: () => capital(monthName(mo, 'short', locale)),
    MM: () => pad(mo + 1), M: () => String(mo + 1),
    dddd: () => weekdayName(date, 'long', locale), ddd: () => weekdayName(date, 'short', locale),
    dd: () => pad(d), d: () => String(d),
    HH: () => pad(h), H: () => String(h), hh: () => pad(((h + 11) % 12) + 1), h: () => String(((h + 11) % 12) + 1),
    mm: () => pad(mi), ss: () => pad(s), tt: () => (h < 12 ? 'AM' : 'PM')
  };
  const order = ['yyyy', 'yy', 'MMMM', 'MMM', 'MM', 'M', 'dddd', 'ddd', 'dd', 'd', 'HH', 'H', 'hh', 'h', 'mm', 'ss', 'tt'];
  let out = '';
  const p = String(pattern);
  for (let i = 0; i < p.length;) {
    if (p[i] === "'") {
      const end = p.indexOf("'", i + 1);
      out += end < 0 ? p.slice(i + 1) : p.slice(i + 1, end);
      i = end < 0 ? p.length : end + 1;
      continue;
    }
    const token = order.find((t) => p.startsWith(t, i));
    if (token) { out += tokens[token](); i += token.length; } else { out += p[i]; i++; }
  }
  return out;
}

/** Format a number: decimals, thousands separator, minimum integer digits (leading zeros). */
export function formatNumber(value, { decimals = null, thousands = false, minInteger = 1, trimZeros = false } = {}) {
  if (!Number.isFinite(value)) return '';
  let fixed = decimals === null || decimals === undefined
    ? String(Math.round(value * 1e10) / 1e10)
    : (Math.round(value * 10 ** decimals + Number.EPSILON * Math.sign(value)) / 10 ** decimals).toFixed(Math.max(0, Math.min(10, decimals)));
  if (/e/i.test(fixed)) fixed = value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 });
  let negative = fixed.startsWith('-');
  if (negative) fixed = fixed.slice(1);
  let [int, frac = ''] = fixed.split('.');
  if (trimZeros) frac = frac.replace(/0+$/, '');
  int = int.padStart(Math.max(1, Math.min(30, minInteger)), '0');
  if (thousands) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (negative && /^[0,.]*$/.test(int + frac)) negative = false;
  return (negative ? '-' : '') + int + (frac ? '.' + frac : '');
}

function isDatePattern(pattern) {
  return /(yy|MM|dd|HH|hh|mm:ss|MMM)/.test(pattern.replace(/'[^']*'/g, '')) || /^[dMy]{1,4}([/.\- ][dMy]{1,4}){1,2}$/.test(pattern);
}

/** Apply an Excel-like numeric pattern such as "0.00", "#,##0", "000000", "0%". */
export function applyNumberPattern(value, pattern) {
  const [rawSection] = String(pattern).split(';');
  // keep [$EGP] currency text, drop other bracket codes such as [Red] or [$-409]
  const section = rawSection.replace(/\[\$([^\]-]*)[^\]]*\]/g, (m, s) => (s ? '"' + s + '"' : ''))
    .replace(/\[[^\]]*\]/g, '');
  const percent = section.replace(/"[^"]*"/g, '').includes('%');
  const v = percent ? value * 100 : value;
  const core = section.replace(/"[^"]*"|\\.|[^0#,.]/g, '');
  const [intPart, fracPart = ''] = core.split('.');
  const decimals = (fracPart.match(/[0#]/g) || []).length;
  const minInteger = (intPart.match(/0/g) || []).length;
  const out = formatNumber(v, { decimals, thousands: intPart.includes(','), minInteger: Math.max(minInteger, 0) || 1 });
  const first = section.search(/[0#]/);
  const last = Math.max(section.lastIndexOf('0'), section.lastIndexOf('#'));
  const literal = (s) => s.replace(/\[\$([^\]-]*)[^\]]*\]/g, '$1').replace(/\[[^\]]*\]/g, '')
    .replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1').replace(/_./g, '').replace(/[%*]/g, '');
  const prefix = first > 0 ? literal(section.slice(0, first)) : '';
  const suffix = last >= 0 ? literal(section.slice(last + 1)) : '';
  return prefix + out + (percent ? '%' : '') + suffix;
}

/**
 * Format any value for a label.
 * format = { kind: 'none'|'number'|'currency'|'percent'|'date'|'pattern'|'text', decimals, thousands,
 *            currencySymbol, symbolPosition: 'before'|'after', datePattern, pattern, case, digits: 'latin'|'arabic',
 *            emptyText, minInteger }
 * ctx = { dateOrder, locale }
 */
export function formatValue(value, format = {}, ctx = {}) {
  const kind = format?.kind || 'none';
  let text;
  const blank = value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  if (blank) return String(format?.emptyText ?? '');
  switch (kind) {
    case 'number':
    case 'currency':
    case 'percent': {
      const number = typeof value === 'number' ? value : toNumber(value);
      if (number === null) { text = String(value); break; }
      const decimals = Number.isFinite(Number(format.decimals)) ? Number(format.decimals) : (kind === 'currency' ? 2 : null);
      if (kind === 'percent') {
        text = formatNumber(number * 100, { decimals: decimals ?? 0, thousands: Boolean(format.thousands) }) + '%';
      } else {
        text = formatNumber(number, { decimals, thousands: Boolean(format.thousands), minInteger: Number(format.minInteger) || 1 });
        if (kind === 'currency') {
          const symbol = String(format.currencySymbol ?? 'EGP');
          text = format.symbolPosition === 'before' ? symbol + (symbol.length > 1 ? ' ' : '') + text : text + (symbol ? ' ' + symbol : '');
        }
      }
      break;
    }
    case 'date': {
      const date = value instanceof Date ? value : parseDateValue(value, ctx.dateOrder || 'DMY');
      text = date ? formatDatePattern(date, format.datePattern || 'dd/MM/yyyy', format.locale || ctx.locale) : String(value);
      break;
    }
    case 'pattern': {
      const pattern = String(format.pattern || '');
      if (isDatePattern(pattern)) {
        const date = value instanceof Date ? value : parseDateValue(value, ctx.dateOrder || 'DMY');
        text = date ? formatDatePattern(date, pattern, format.locale || ctx.locale) : String(value);
      } else {
        const number = typeof value === 'number' ? value : toNumber(value);
        text = number === null ? String(value) : applyNumberPattern(number, pattern);
      }
      break;
    }
    default:
      text = value instanceof Date ? formatDatePattern(value, 'yyyy-MM-dd') : (typeof value === 'number' ? formatNumber(value) : String(value));
  }
  switch (format.case) {
    case 'upper': text = text.toLocaleUpperCase(); break;
    case 'lower': text = text.toLocaleLowerCase(); break;
    case 'title': text = text.toLocaleLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (m, p, c) => p + c.toLocaleUpperCase()); break;
    default: break;
  }
  if (format.trim) text = text.trim();
  if (format.digits === 'arabic') text = toArabicDigits(text);
  return text;
}
