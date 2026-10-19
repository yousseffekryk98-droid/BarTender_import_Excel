// Safe expression language for calculated label fields.
//
// Never uses eval/Function. Grammar (case-insensitive keywords and functions):
//
//   expr     := or
//   or       := and ( OR and )*
//   and      := not ( AND not )*
//   not      := NOT not | compare
//   compare  := concat ( ( = | <> | != | < | > | <= | >= ) concat )?
//   concat   := sum ( & sum )*
//   sum      := product ( ( + | - ) product )*
//   product  := unary ( ( * | / | % ) unary )*
//   unary    := - unary | primary
//   primary  := number | string | field | prompt | call | ( expr )
//   field    := [Column Name]  |  {Column Name}
//   prompt   := {?Prompt Name}
//   call     := NAME ( args? )
//
// "+" adds when both sides are numeric, otherwise concatenates (spreadsheet-like).
// "&" always concatenates.

import { formatValue, parseDateValue, toNumber, formatDatePattern } from './format.js';

export class ExpressionError extends Error {
  constructor(message, position) {
    super(message);
    this.name = 'ExpressionError';
    this.position = position;
  }
}

const MAX_LENGTH = 2000;
const MAX_DEPTH = 40;
const MAX_STRING = 10_000;

export function tokenize(source) {
  const text = String(source ?? '');
  if (text.length > MAX_LENGTH) throw new ExpressionError('Expression is too long (max ' + MAX_LENGTH + ' characters).', 0);
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      while (i < text.length && /[0-9.]/.test(text[i])) i++;
      const raw = text.slice(start, i);
      if ((raw.match(/\./g) || []).length > 1) throw new ExpressionError('Invalid number "' + raw + '".', start);
      tokens.push({ type: 'number', value: Number(raw), pos: start });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let value = '';
      while (i < text.length) {
        if (text[i] === quote) {
          if (text[i + 1] === quote) { value += quote; i += 2; continue; }
          break;
        }
        value += text[i++];
      }
      if (text[i] !== quote) throw new ExpressionError('Missing closing quote.', start);
      i++;
      tokens.push({ type: 'string', value, pos: start });
      continue;
    }
    if (ch === '[' || ch === '{') {
      const close = ch === '[' ? ']' : '}';
      const end = text.indexOf(close, i + 1);
      if (end < 0) throw new ExpressionError('Missing closing "' + close + '" for a field name.', start);
      let name = text.slice(i + 1, end);
      i = end + 1;
      if (ch === '{' && name.startsWith('?')) {
        tokens.push({ type: 'prompt', value: name.slice(1).trim(), pos: start });
      } else {
        name = name.trim();
        if (!name) throw new ExpressionError('Empty field name.', start);
        tokens.push({ type: 'field', value: name, pos: start });
      }
      continue;
    }
    if (/[A-Za-z_؀-ۿ]/.test(ch)) {
      while (i < text.length && /[A-Za-z0-9_؀-ۿ]/.test(text[i])) i++;
      const word = text.slice(start, i);
      const upper = word.toUpperCase();
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') tokens.push({ type: 'op', value: upper, pos: start });
      else if (upper === 'TRUE' || upper === 'FALSE') tokens.push({ type: 'bool', value: upper === 'TRUE', pos: start });
      else tokens.push({ type: 'name', value: upper, pos: start });
      continue;
    }
    const two = text.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '=='].includes(two)) {
      tokens.push({ type: 'op', value: two === '!=' ? '<>' : two === '==' ? '=' : two, pos: start });
      i += 2;
      continue;
    }
    if ('+-*/%&=<>(),'.includes(ch)) {
      tokens.push({ type: ch === '(' || ch === ')' || ch === ',' ? ch : 'op', value: ch, pos: start });
      i++;
      continue;
    }
    throw new ExpressionError('Unexpected character "' + ch + '".', start);
  }
  tokens.push({ type: 'eof', pos: text.length });
  return tokens;
}

export function parseExpression(source) {
  const tokens = tokenize(source);
  let index = 0;
  let depth = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];
  const isOp = (value) => peek().type === 'op' && peek().value === value;
  const expect = (type) => {
    const token = next();
    if (token.type !== type) throw new ExpressionError('Expected "' + type + '".', token.pos);
    return token;
  };
  const guard = (fn) => {
    if (++depth > MAX_DEPTH) throw new ExpressionError('Expression is nested too deeply.', peek().pos);
    try { return fn(); } finally { depth--; }
  };

  function parseOr() {
    let left = parseAnd();
    while (isOp('OR')) { next(); left = { k: 'bin', op: 'OR', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (isOp('AND')) { next(); left = { k: 'bin', op: 'AND', left, right: parseNot() }; }
    return left;
  }
  function parseNot() {
    if (isOp('NOT')) { next(); return guard(() => ({ k: 'not', arg: parseNot() })); }
    return parseCompare();
  }
  function parseCompare() {
    const left = parseConcat();
    const token = peek();
    if (token.type === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(token.value)) {
      next();
      return { k: 'bin', op: token.value, left, right: parseConcat() };
    }
    return left;
  }
  function parseConcat() {
    let left = parseSum();
    while (isOp('&')) { next(); left = { k: 'bin', op: '&', left, right: parseSum() }; }
    return left;
  }
  function parseSum() {
    let left = parseProduct();
    while (isOp('+') || isOp('-')) { const op = next().value; left = { k: 'bin', op, left, right: parseProduct() }; }
    return left;
  }
  function parseProduct() {
    let left = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) { const op = next().value; left = { k: 'bin', op, left, right: parseUnary() }; }
    return left;
  }
  function parseUnary() {
    if (isOp('-')) { next(); return guard(() => ({ k: 'neg', arg: parseUnary() })); }
    if (isOp('+')) { next(); return guard(() => parseUnary()); }
    return parsePrimary();
  }
  function parsePrimary() {
    const token = next();
    switch (token.type) {
      case 'number': return { k: 'lit', value: token.value };
      case 'string': return { k: 'lit', value: token.value };
      case 'bool': return { k: 'lit', value: token.value };
      case 'field': return { k: 'field', name: token.value };
      case 'prompt': return { k: 'prompt', name: token.value };
      case '(': {
        const inner = guard(() => parseOr());
        expect(')');
        return inner;
      }
      case 'name': {
        if (peek().type !== '(') throw new ExpressionError('Unknown name "' + token.value + '". Put column names in [brackets].', token.pos);
        next();
        const args = [];
        if (peek().type !== ')') {
          do { args.push(guard(() => parseOr())); } while (peek().type === ',' && next());
        }
        expect(')');
        if (!Object.hasOwn(FUNCTIONS, token.value)) throw new ExpressionError('Unknown function ' + token.value + '().', token.pos);
        const spec = FUNCTIONS[token.value];
        if (args.length < spec.min || args.length > spec.max) {
          throw new ExpressionError(token.value + '() expects ' + (spec.min === spec.max ? spec.min : spec.min + '–' + spec.max) + ' argument(s).', token.pos);
        }
        return { k: 'call', name: token.value, args };
      }
      default:
        throw new ExpressionError(token.type === 'eof' ? 'Expression ended unexpectedly.' : 'Unexpected "' + (token.value ?? token.type) + '".', token.pos);
    }
  }

  const ast = parseOr();
  if (peek().type !== 'eof') throw new ExpressionError('Unexpected "' + (peek().value ?? peek().type) + '".', peek().pos);
  return ast;
}

// ---------- evaluation ----------

const isBlank = (v) => v === null || v === undefined || v === '';
const asText = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return formatDatePattern(v, 'yyyy-MM-dd');
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1e10) / 1e10) : '';
  return String(v);
};
const asNumber = (v, name) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isBlank(v)) return 0;
  const n = toNumber(v);
  if (n === null) throw new ExpressionError((name ? name + ': ' : '') + '"' + asText(v).slice(0, 40) + '" is not a number.');
  return n;
};
const asBool = (v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const t = asText(v).trim().toUpperCase();
  return !(t === '' || t === '0' || t === 'FALSE' || t === 'NO');
};
const asDate = (v, ctx) => {
  if (v instanceof Date) return v;
  const parsed = parseDateValue(v, ctx?.dateOrder || 'DMY');
  if (!parsed) throw new ExpressionError('"' + asText(v).slice(0, 40) + '" is not a date.');
  return parsed;
};
const clip = (s) => (s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s);
const looksNumeric = (v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && toNumber(v) !== null);

function compare(a, b) {
  if (looksNumeric(a) && looksNumeric(b)) {
    const x = asNumber(a); const y = asNumber(b);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (a instanceof Date || b instanceof Date) {
    try { const x = asDate(a).getTime(); const y = asDate(b).getTime(); return x === y ? 0 : x < y ? -1 : 1; } catch { /* fall through */ }
  }
  const x = asText(a).toLocaleLowerCase(); const y = asText(b).toLocaleLowerCase();
  return x === y ? 0 : x < y ? -1 : 1;
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

const FUNCTIONS = {
  CONCAT: { min: 1, max: 30, fn: (a) => clip(a.map(asText).join('')) },
  UPPER: { min: 1, max: 1, fn: ([s]) => asText(s).toLocaleUpperCase() },
  LOWER: { min: 1, max: 1, fn: ([s]) => asText(s).toLocaleLowerCase() },
  PROPER: { min: 1, max: 1, fn: ([s]) => asText(s).toLocaleLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (m, p, c) => p + c.toLocaleUpperCase()) },
  TRIM: { min: 1, max: 1, fn: ([s]) => asText(s).trim().replace(/\s+/g, ' ') },
  LEFT: { min: 1, max: 2, fn: ([s, n = 1]) => [...asText(s)].slice(0, Math.max(0, asNumber(n))).join('') },
  RIGHT: { min: 1, max: 2, fn: ([s, n = 1]) => { const c = [...asText(s)]; const k = Math.max(0, asNumber(n)); return k ? c.slice(-k).join('') : ''; } },
  MID: { min: 3, max: 3, fn: ([s, start, n]) => [...asText(s)].slice(Math.max(0, asNumber(start) - 1), Math.max(0, asNumber(start) - 1) + Math.max(0, asNumber(n))).join('') },
  LEN: { min: 1, max: 1, fn: ([s]) => [...asText(s)].length },
  REPLACE: { min: 3, max: 3, fn: ([s, find, rep]) => { const f = asText(find); return f ? clip(asText(s).split(f).join(asText(rep))) : asText(s); } },
  PADLEFT: { min: 2, max: 3, fn: ([s, n, ch = '0']) => asText(s).padStart(Math.min(200, asNumber(n)), asText(ch).slice(0, 1) || ' ') },
  PADRIGHT: { min: 2, max: 3, fn: ([s, n, ch = ' ']) => asText(s).padEnd(Math.min(200, asNumber(n)), asText(ch).slice(0, 1) || ' ') },
  ROUND: { min: 1, max: 2, fn: ([n, d = 0]) => { const f = 10 ** Math.max(0, Math.min(10, asNumber(d))); return Math.round(asNumber(n) * f) / f; } },
  FIXED: { min: 1, max: 2, fn: ([n, d = 2]) => asNumber(n).toFixed(Math.max(0, Math.min(10, asNumber(d)))) },
  NUMBER: { min: 1, max: 1, fn: ([s]) => asNumber(s, 'NUMBER') },
  ABS: { min: 1, max: 1, fn: ([n]) => Math.abs(asNumber(n)) },
  MIN: { min: 1, max: 30, fn: (a) => Math.min(...a.map((v) => asNumber(v))) },
  MAX: { min: 1, max: 30, fn: (a) => Math.max(...a.map((v) => asNumber(v))) },
  IF: { min: 2, max: 3, lazy: true },
  IFEMPTY: { min: 2, max: 2, fn: ([a, b]) => (isBlank(a) || asText(a).trim() === '' ? b : a) },
  COALESCE: { min: 1, max: 30, fn: (a) => a.find((v) => !isBlank(v) && asText(v).trim() !== '') ?? '' },
  ISEMPTY: { min: 1, max: 1, fn: ([a]) => isBlank(a) || asText(a).trim() === '' },
  CONTAINS: { min: 2, max: 2, fn: ([s, f]) => asText(s).toLocaleLowerCase().includes(asText(f).toLocaleLowerCase()) },
  TEXT: { min: 2, max: 2, fn: ([v, pattern], ctx) => formatValue(v, { kind: 'pattern', pattern: asText(pattern) }, ctx) },
  FORMATNUMBER: { min: 1, max: 3, fn: ([v, decimals = 0, thousands = true], ctx) => formatValue(asNumber(v), { kind: 'number', decimals: asNumber(decimals), thousands: asBool(thousands) }, ctx) },
  FORMATDATE: { min: 2, max: 2, fn: ([v, pattern], ctx) => formatDatePattern(asDate(v, ctx), asText(pattern)) },
  TODAY: { min: 0, max: 0, fn: (a, ctx) => { const n = ctx.now(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())); } },
  NOW: { min: 0, max: 0, fn: (a, ctx) => { const n = ctx.now(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds())); } },
  DATE: { min: 3, max: 3, fn: ([y, m, d]) => new Date(Date.UTC(asNumber(y), asNumber(m) - 1, asNumber(d))) },
  DATEVALUE: { min: 1, max: 1, fn: ([s], ctx) => asDate(s, ctx) },
  ADDDAYS: { min: 2, max: 2, fn: ([d, n], ctx) => new Date(asDate(d, ctx).getTime() + Math.round(asNumber(n)) * 86400000) },
  ADDMONTHS: { min: 2, max: 2, fn: ([d, n], ctx) => addMonths(asDate(d, ctx), Math.round(asNumber(n))) },
  ADDYEARS: { min: 2, max: 2, fn: ([d, n], ctx) => addMonths(asDate(d, ctx), Math.round(asNumber(n)) * 12) },
  YEAR: { min: 1, max: 1, fn: ([d], ctx) => asDate(d, ctx).getUTCFullYear() },
  MONTH: { min: 1, max: 1, fn: ([d], ctx) => asDate(d, ctx).getUTCMonth() + 1 },
  DAY: { min: 1, max: 1, fn: ([d], ctx) => asDate(d, ctx).getUTCDate() },
  RECORDNUMBER: { min: 0, max: 0, fn: (a, ctx) => ctx.recordNumber ?? 1 },
  LABELNUMBER: { min: 0, max: 0, fn: (a, ctx) => ctx.labelNumber ?? 1 },
  COPYNUMBER: { min: 0, max: 0, fn: (a, ctx) => ctx.copyNumber ?? 1 },
  COPIES: { min: 0, max: 0, fn: (a, ctx) => ctx.copies ?? 1 },
  FIELD: { min: 1, max: 1, fn: ([name], ctx) => ctx.field(asText(name)) },
  LOOKUP: { min: 4, max: 4, fn: ([source, keyCol, key, returnCol], ctx) => (ctx.lookup ? ctx.lookup(asText(source), asText(keyCol), asText(key), asText(returnCol)) : '') }
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();

function evaluateNode(node, ctx) {
  switch (node.k) {
    case 'lit': return node.value;
    case 'field': return ctx.field(node.name);
    case 'prompt': return ctx.prompt(node.name);
    case 'neg': return -asNumber(evaluateNode(node.arg, ctx));
    case 'not': return !asBool(evaluateNode(node.arg, ctx));
    case 'call': {
      const spec = FUNCTIONS[node.name];
      if (spec.lazy) {
        // IF(condition, then, else)
        return asBool(evaluateNode(node.args[0], ctx))
          ? evaluateNode(node.args[1], ctx)
          : (node.args[2] ? evaluateNode(node.args[2], ctx) : '');
      }
      const args = node.args.map((arg) => evaluateNode(arg, ctx));
      try { return spec.fn(args, ctx); }
      catch (error) {
        if (error instanceof ExpressionError && !error.message.startsWith(node.name)) {
          throw new ExpressionError(node.name + '(): ' + error.message);
        }
        throw error;
      }
    }
    case 'bin': {
      if (node.op === 'AND') return asBool(evaluateNode(node.left, ctx)) && asBool(evaluateNode(node.right, ctx));
      if (node.op === 'OR') return asBool(evaluateNode(node.left, ctx)) || asBool(evaluateNode(node.right, ctx));
      const a = evaluateNode(node.left, ctx);
      const b = evaluateNode(node.right, ctx);
      switch (node.op) {
        case '&': return clip(asText(a) + asText(b));
        case '+':
          if (a instanceof Date && looksNumeric(b)) return new Date(a.getTime() + asNumber(b) * 86400000);
          if (looksNumeric(a) && looksNumeric(b)) return asNumber(a) + asNumber(b);
          return clip(asText(a) + asText(b));
        case '-': return asNumber(a) - asNumber(b);
        case '*': return asNumber(a) * asNumber(b);
        case '/': { const d = asNumber(b); if (d === 0) throw new ExpressionError('Division by zero.'); return asNumber(a) / d; }
        case '%': { const d = asNumber(b); if (d === 0) throw new ExpressionError('Division by zero.'); return asNumber(a) % d; }
        case '=': return compare(a, b) === 0;
        case '<>': return compare(a, b) !== 0;
        case '<': return compare(a, b) < 0;
        case '>': return compare(a, b) > 0;
        case '<=': return compare(a, b) <= 0;
        case '>=': return compare(a, b) >= 0;
        default: throw new ExpressionError('Unknown operator ' + node.op);
      }
    }
    default: throw new ExpressionError('Invalid expression.');
  }
}

const cache = new Map();
export function compileExpression(source) {
  const key = String(source ?? '');
  if (cache.has(key)) return cache.get(key);
  const ast = parseExpression(key);
  if (cache.size > 500) cache.clear();
  cache.set(key, ast);
  return ast;
}

/**
 * Evaluate an expression. ctx = { field(name), prompt(name), now(), recordNumber, labelNumber, copyNumber, copies, dateOrder, lookup }
 * Returns the raw value (string | number | boolean | Date).
 */
export function evaluateExpression(source, ctx) {
  const ast = compileExpression(source);
  const full = {
    field: () => '', prompt: () => '', now: () => new Date(), ...ctx
  };
  return evaluateNode(ast, full);
}

export function expressionToText(value) {
  return asText(value);
}

/** Field names referenced by an expression (for missing-column checks). */
export function referencedFields(source) {
  const names = new Set();
  const walk = (node) => {
    if (!node) return;
    if (node.k === 'field') names.add(node.name);
    if (node.left) walk(node.left);
    if (node.right) walk(node.right);
    if (node.arg) walk(node.arg);
    if (node.args) node.args.forEach(walk);
    if (node.k === 'call' && node.name === 'FIELD' && node.args[0]?.k === 'lit') names.add(String(node.args[0].value));
  };
  walk(compileExpression(source));
  return [...names];
}

export function referencedPrompts(source) {
  const names = new Set();
  const walk = (node) => {
    if (!node) return;
    if (node.k === 'prompt') names.add(node.name);
    [node.left, node.right, node.arg, ...(node.args || [])].forEach((child) => child && walk(child));
  };
  walk(compileExpression(source));
  return [...names];
}

// ---------- {Field} text templates ----------
// "Product: {Product Name} – {Price} EGP"   ({{ and }} are literal braces, {?Prompt} is a prompt)

export function parseTextTemplate(source) {
  const text = String(source ?? '');
  const parts = [];
  let buffer = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' && text[i + 1] === '{') { buffer += '{'; i++; continue; }
    if (ch === '}' && text[i + 1] === '}') { buffer += '}'; i++; continue; }
    if (ch === '{') {
      const end = text.indexOf('}', i + 1);
      if (end < 0) { buffer += text.slice(i); break; }
      if (buffer) { parts.push({ k: 'text', value: buffer }); buffer = ''; }
      const name = text.slice(i + 1, end).trim();
      if (name.startsWith('?')) parts.push({ k: 'prompt', name: name.slice(1).trim() });
      else if (name.startsWith('=')) parts.push({ k: 'expr', source: name.slice(1) });
      else if (name) parts.push({ k: 'field', name });
      i = end;
      continue;
    }
    buffer += ch;
  }
  if (buffer) parts.push({ k: 'text', value: buffer });
  return parts;
}

export function templateFields(source) {
  const names = new Set();
  for (const part of parseTextTemplate(source)) {
    if (part.k === 'field') names.add(part.name);
    if (part.k === 'expr') { try { referencedFields(part.source).forEach((n) => names.add(n)); } catch { /* reported at render */ } }
  }
  return [...names];
}

export function renderTextTemplate(source, ctx) {
  return parseTextTemplate(source).map((part) => {
    if (part.k === 'text') return part.value;
    if (part.k === 'field') return asText(ctx.field(part.name));
    if (part.k === 'prompt') return asText(ctx.prompt(part.name));
    return asText(evaluateExpression(part.source, ctx));
  }).join('');
}
