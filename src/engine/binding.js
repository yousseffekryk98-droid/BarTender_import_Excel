// Data binding: resolve template fields to spreadsheet columns by header name,
// build per-label evaluation contexts, resolve object content and visibility rules.

import { evaluateExpression, renderTextTemplate, templateFields, referencedFields, expressionToText, ExpressionError } from './expression.js';
import { formatValue, toNumber, parseDateValue, formatDatePattern } from './format.js';
import { objectFieldNames } from './schema.js';

/** Normalise a header for matching: case-, width- and whitespace-insensitive. */
export function headerKey(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US')
    .replace(/[\s_\-–—]+/g, ' ');
}

/**
 * Build a header → column index map. Duplicated (after normalisation) headers are
 * marked ambiguous and never resolved, so data can never come from the wrong column.
 */
export function buildHeaderIndex(headers) {
  const map = new Map();
  const ambiguous = new Set();
  (headers || []).forEach((header, index) => {
    const key = headerKey(header);
    if (!key) return;
    if (map.has(key)) ambiguous.add(key);
    else map.set(key, index);
  });
  for (const key of ambiguous) map.delete(key);
  return { map, ambiguous };
}

const indexCache = new WeakMap();
function indexFor(headers) {
  if (!Array.isArray(headers)) return { map: new Map(), ambiguous: new Set() };
  let entry = indexCache.get(headers);
  if (!entry) { entry = buildHeaderIndex(headers); indexCache.set(headers, entry); }
  return entry;
}

/** Column index for a field name, or -1 when missing/ambiguous. */
export function resolveColumn(headers, name) {
  const key = headerKey(name);
  if (!key) return -1;
  const { map } = indexFor(headers);
  return map.has(key) ? map.get(key) : -1;
}

export function isAmbiguous(headers, name) {
  return indexFor(headers).ambiguous.has(headerKey(name));
}

const FIELD_HELPERS = { templateFields, referencedFields };

/** All data-source field names used anywhere in the template. */
export function templateFieldNames(template) {
  const names = new Set();
  for (const object of template.objects || []) objectFieldNames(object, FIELD_HELPERS).forEach((n) => names.add(n));
  if (template.data?.quantityMode === 'field' && template.data.quantityField) names.add(template.data.quantityField);
  for (const filter of template.data?.filters || []) names.add(filter.field);
  for (const sort of template.data?.sort || []) names.add(sort.field);
  return [...names];
}

/**
 * Report fields that cannot be bound to the given headers.
 * Returns [{ field, reason: 'missing'|'ambiguous', objects: [objectNames] }]
 */
export function missingFields(template, headers) {
  const result = new Map();
  const note = (field, objectName) => {
    if (resolveColumn(headers, field) >= 0) return;
    const reason = isAmbiguous(headers, field) ? 'ambiguous' : 'missing';
    const entry = result.get(field) || { field, reason, objects: [] };
    if (objectName && !entry.objects.includes(objectName)) entry.objects.push(objectName);
    result.set(field, entry);
  };
  for (const object of template.objects || []) {
    for (const name of objectFieldNames(object, FIELD_HELPERS)) note(name, object.name || object.type);
  }
  if (template.data?.quantityMode === 'field' && template.data.quantityField) note(template.data.quantityField, 'Quantity');
  for (const filter of template.data?.filters || []) note(filter.field, 'Filter');
  for (const sort of template.data?.sort || []) note(sort.field, 'Sort');
  return [...result.values()];
}

// ---------- evaluation context ----------

/**
 * Make the context used to evaluate one label.
 * options: { headers, record, prompts (object name→value), recordNumber, labelNumber, copyNumber, copies,
 *            now: () => Date, dateOrder, locale, sources: { name: sheet }, serialStart: { objectId: start } }
 */
export function makeContext(options = {}) {
  const headers = options.headers || [];
  const record = options.record || { cells: [] };
  const prompts = options.prompts || {};
  const missing = new Set();
  const ctx = {
    headers, record,
    recordNumber: options.recordNumber ?? 1,
    recordIndex: options.recordIndex ?? 0,
    labelNumber: options.labelNumber ?? 1,
    labelIndex: options.labelIndex ?? 0,
    copyNumber: options.copyNumber ?? 1,
    copies: options.copies ?? 1,
    dateOrder: options.dateOrder || 'DMY',
    locale: options.locale || 'en',
    now: options.now || (() => new Date()),
    serialStart: options.serialStart || {},
    missing,
    /** Display text of a column (keeps leading zeros as shown in Excel). */
    text(name) {
      const index = resolveColumn(headers, name);
      if (index < 0) { missing.add(name); return options.placeholders ? '[' + name + ']' : ''; }
      return String(record.cells?.[index] ?? '');
    },
    /** Typed cell value when the importer knows it: { t: 'n'|'d'|'s'|'b', v } */
    raw(name) {
      const index = resolveColumn(headers, name);
      if (index < 0) return null;
      return record.raw?.[index] ?? null;
    },
    field(name) {
      const raw = ctx.raw(name);
      if (raw && raw.t === 'd' && raw.v) {
        const date = raw.v instanceof Date ? raw.v : new Date(raw.v);
        if (!Number.isNaN(date.getTime())) return date;
      }
      return ctx.text(name);
    },
    prompt(name) {
      const key = Object.keys(prompts).find((k) => k.toLocaleLowerCase() === String(name).toLocaleLowerCase());
      return key === undefined ? '' : String(prompts[key] ?? '');
    },
    lookup(sourceName, keyColumn, key, returnColumn) {
      const source = options.sources?.[sourceName] || Object.entries(options.sources || {})
        .find(([n]) => n.toLocaleLowerCase() === String(sourceName).toLocaleLowerCase())?.[1];
      if (!source) throw new ExpressionError('LOOKUP: data source "' + sourceName + '" is not loaded.');
      const k = resolveColumn(source.headers, keyColumn);
      const r = resolveColumn(source.headers, returnColumn);
      if (k < 0) throw new ExpressionError('LOOKUP: column "' + keyColumn + '" not found in ' + sourceName + '.');
      if (r < 0) throw new ExpressionError('LOOKUP: column "' + returnColumn + '" not found in ' + sourceName + '.');
      const wanted = String(key).trim().toLocaleLowerCase();
      const row = source.records.find((rec) => String(rec.cells[k] ?? '').trim().toLocaleLowerCase() === wanted);
      return row ? String(row.cells[r] ?? '') : '';
    }
  };
  return ctx;
}

// ---------- serial numbers ----------

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function parseInBase(text, digits) {
  let value = 0n;
  const base = BigInt(digits.length);
  for (const ch of text.toUpperCase()) {
    const d = digits.indexOf(ch);
    if (d < 0) return null;
    value = value * base + BigInt(d);
  }
  return value;
}
function toBase(value, digits) {
  const base = BigInt(digits.length);
  if (value === 0n) return digits[0];
  let out = '';
  let v = value;
  while (v > 0n) { out = digits[Number(v % base)] + out; v /= base; }
  return out;
}
// Bijective base-26: A..Z, AA..AZ, BA.. (spreadsheet-column style)
function alphaToNumber(text) {
  let n = 0n;
  for (const ch of text.toUpperCase()) {
    const d = ALPHA.indexOf(ch);
    if (d < 0) return null;
    n = n * 26n + BigInt(d + 1);
  }
  return n;
}
function numberToAlpha(n) {
  let out = '';
  let v = n;
  while (v > 0n) { v -= 1n; out = ALPHA[Number(v % 26n)] + out; v /= 26n; }
  return out || 'A';
}

/**
 * Serial value for a 0-based step index. Supports numeric (arbitrary length), hex,
 * alpha (A, B … Z, AA …) and alphanumeric (base-36) sequences with zero padding.
 */
export function serialValue(spec, index, startOverride) {
  const start = String(startOverride ?? spec.start ?? '1').trim() || '1';
  const step = BigInt(Math.round(Number(spec.step) || 1));
  const offset = step * BigInt(index);
  let text;
  switch (spec.mode) {
    case 'hex': {
      const base = parseInBase(start.replace(/^0x/i, ''), '0123456789ABCDEF');
      if (base === null) throw new Error('Serial start "' + start + '" is not hexadecimal.');
      const v = base + offset;
      text = v < 0n ? '-' + toBase(-v, '0123456789ABCDEF') : toBase(v, '0123456789ABCDEF');
      break;
    }
    case 'alpha': {
      const base = alphaToNumber(start);
      if (base === null) throw new Error('Serial start "' + start + '" must contain letters A–Z only.');
      const v = base + offset;
      text = v < 1n ? 'A' : numberToAlpha(v);
      break;
    }
    case 'alphanumeric': {
      const base = parseInBase(start, ALNUM);
      if (base === null) throw new Error('Serial start "' + start + '" must contain 0–9 and A–Z only.');
      const v = base + offset;
      text = v < 0n ? '0' : toBase(v, ALNUM);
      break;
    }
    default: {
      if (!/^-?\d+$/.test(start)) throw new Error('Serial start "' + start + '" must be a whole number.');
      const v = BigInt(start) + offset;
      text = v < 0n ? '-' + (-v).toString() : v.toString();
    }
  }
  // "00001" keeps its width automatically; an explicit width always wins.
  const implicit = spec.mode !== 'alpha' && start.length > 1 && /^0/.test(start.replace(/^0x/i, '')) ? start.replace(/^0x/i, '').length : 0;
  const width = Number(spec.width) || implicit;
  if (width && !text.startsWith('-') && spec.mode !== 'alpha') text = text.padStart(width, '0');
  return text;
}

/** Next starting value after `count` steps (for "continue from last print"). */
export function serialNextStart(spec, count, startOverride) {
  return serialValue(spec, count, startOverride);
}

// ---------- content resolution ----------

function rawForFormat(ctx, fieldName, format) {
  const raw = ctx.raw(fieldName);
  const display = ctx.text(fieldName);
  if (!raw) return display;
  if (format.kind === 'date' && raw.t === 'd' && raw.v) return raw.v instanceof Date ? raw.v : new Date(raw.v);
  if ((format.kind === 'number' || format.kind === 'currency' || format.kind === 'percent') && raw.t === 'n' && Number.isFinite(raw.v)) return raw.v;
  if (format.kind === 'pattern' && (raw.t === 'n' || raw.t === 'd')) return raw.t === 'd' ? new Date(raw.v) : raw.v;
  return display;
}

/**
 * Resolve an object's content spec to the final printed text.
 * Throws ExpressionError for invalid expressions (callers report them per label).
 */
export function resolveText(object, ctx) {
  const content = object.content || {};
  const format = object.format || { kind: 'none' };
  let value;
  switch (content.mode) {
    case 'field': value = content.field ? rawForFormat(ctx, content.field, format) : ''; break;
    case 'template': value = renderTextTemplate(content.template, ctx); break;
    case 'expression': value = content.expression ? evaluateExpression(content.expression, ctx) : ''; break;
    case 'prompt': value = ctx.prompt(content.prompt); break;
    case 'date': {
      const now = ctx.now();
      const base = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()));
      const months = Number(content.date?.offsetMonths) || 0;
      if (months) {
        const day = base.getUTCDate();
        base.setUTCDate(1); base.setUTCMonth(base.getUTCMonth() + months);
        base.setUTCDate(Math.min(day, new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate()));
      }
      value = new Date(base.getTime() + (Number(content.date?.offsetDays) || 0) * 86400000);
      if (format.kind === 'none') return (object.prefix || '') + formatDatePattern(value, 'dd/MM/yyyy', format.locale) + (object.suffix || '');
      break;
    }
    case 'serial': {
      const spec = content.serial || {};
      const index = spec.perCopy === false ? ctx.recordIndex : ctx.labelIndex;
      value = serialValue(spec, index, ctx.serialStart?.[object.id]);
      break;
    }
    default: value = content.text ?? '';
  }
  if (content.mode === 'expression' && value instanceof Date && format.kind === 'none') value = formatDatePattern(value, 'dd/MM/yyyy');
  if (content.mode === 'expression' && typeof value === 'boolean' && format.kind === 'none') value = expressionToText(value);
  const text = formatValue(value, format, ctx);
  // Prefix/suffix only decorate real values: an empty Excel cell prints nothing.
  if (text === '' && (content.mode === 'field' || content.mode === 'template' || content.mode === 'expression' || content.mode === 'prompt')) return '';
  return String(object.prefix || '') + text + String(object.suffix || '');
}

/** Evaluate a filter-style rule against the current label context. */
export function evaluateRule(rule, ctx) {
  if (!rule) return true;
  if (rule.kind === 'expression' && !String(rule.expression || '').trim()) return true;
  if (rule.kind === 'field' && !rule.field) return true;
  if (rule.kind === 'expression') {
    const value = evaluateExpression(rule.expression, ctx);
    if (typeof value === 'boolean') return value;
    const t = expressionToText(value).trim().toUpperCase();
    return !(t === '' || t === '0' || t === 'FALSE');
  }
  return matchesOperator(ctx.text(rule.field), rule.op, rule.value);
}

export function matchesOperator(cellText, op, wanted) {
  const a = String(cellText ?? '').trim();
  const b = String(wanted ?? '').trim();
  const al = a.toLocaleLowerCase(); const bl = b.toLocaleLowerCase();
  const numeric = () => {
    const x = toNumber(a); const y = toNumber(b);
    if (x !== null && y !== null) return [x, y];
    const dx = parseDateValue(a); const dy = parseDateValue(b);
    if (dx && dy) return [dx.getTime(), dy.getTime()];
    return null;
  };
  switch (op) {
    case 'equals': { const n = numeric(); return n ? n[0] === n[1] : al === bl; }
    case 'notEquals': { const n = numeric(); return n ? n[0] !== n[1] : al !== bl; }
    case 'contains': return al.includes(bl);
    case 'notContains': return !al.includes(bl);
    case 'startsWith': return al.startsWith(bl);
    case 'endsWith': return al.endsWith(bl);
    case 'isEmpty': return a === '';
    case 'isNotEmpty': return a !== '';
    case 'greaterThan': { const n = numeric(); return n ? n[0] > n[1] : al > bl; }
    case 'lessThan': { const n = numeric(); return n ? n[0] < n[1] : al < bl; }
    case 'greaterOrEqual': { const n = numeric(); return n ? n[0] >= n[1] : al >= bl; }
    case 'lessOrEqual': { const n = numeric(); return n ? n[0] <= n[1] : al <= bl; }
    default: return true;
  }
}
