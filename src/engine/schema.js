// Template document model (schema v2), validation/sanitizing, and migrations.
//
// All geometry is in millimetres relative to the top-left corner of the label.
// Font sizes are in typographic points (1 pt = 1/72 inch).

export const TEMPLATE_SCHEMA = 'excel-label-studio/template';
export const TEMPLATE_VERSION = 2;
export const OBJECT_TYPES = ['text', 'line', 'rect', 'ellipse', 'image', 'barcode', 'table'];
export const CONTENT_MODES = ['static', 'field', 'template', 'expression', 'date', 'serial', 'prompt'];
export const SAFE_FONTS = ['Arial', 'Tahoma', 'Segoe UI', 'Calibri', 'Verdana', 'Times New Roman', 'Courier New', 'Consolas', 'Georgia', 'Trebuchet MS', 'Arial Narrow', 'Traditional Arabic', 'Simplified Arabic', 'Sakkal Majalla', 'Dubai', 'Cairo', 'Noto Sans Arabic', 'Noto Naskh Arabic', 'Amiri'];
export const BARCODE_TYPES = ['code128', 'gs1-128', 'code39', 'ean13', 'ean8', 'upca', 'upce', 'itf14', 'interleaved2of5', 'codabar', 'qrcode', 'datamatrix', 'pdf417', 'azteccode'];
export const FILTER_OPERATORS = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty', 'greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual'];

export const LIMITS = Object.freeze({
  minPage: 5, maxPageWidth: 500, maxPageHeight: 1000,
  maxObjects: 300, maxText: 5000, maxName: 120, maxImageBytes: 2_000_000,
  minFont: 2, maxFont: 400, maxPrompts: 30, maxTableCells: 400
});

const clamp = (value, low, high, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : fallback;
};
const str = (value, max, fallback = '') => (value === null || value === undefined ? fallback : String(value).slice(0, max));
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);
const bool = (value, fallback = false) => (value === undefined ? fallback : Boolean(value));
const round3 = (n) => Math.round(n * 1000) / 1000;
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|^transparent$/;
const color = (value, fallback) => (typeof value === 'string' && COLOR.test(value.trim()) ? value.trim() : fallback);

export function newId(prefix = 'obj') {
  const random = globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  return prefix + '-' + random;
}

export function defaultTextStyle() {
  return {
    fontFamily: 'Arial', fontSize: 10, bold: false, italic: false, underline: false, strike: false,
    color: '#000000', background: 'transparent', align: 'left', vAlign: 'top',
    lineSpacing: 1.1, letterSpacing: 0, wrap: true, overflow: 'shrink', minFontSize: 4,
    direction: 'auto', padding: 0, border: { width: 0, color: '#000000', style: 'solid', radius: 0 }
  };
}

export function defaultContent() {
  return {
    mode: 'static', text: 'Text', field: '', template: '', expression: '', prompt: '',
    date: { offsetDays: 0, offsetMonths: 0 },
    serial: { start: '1', step: 1, width: 0, mode: 'numeric', perCopy: true, continueFromLast: false }
  };
}

export function defaultFormat() {
  return { kind: 'none', decimals: null, thousands: false, currencySymbol: 'EGP', symbolPosition: 'after', datePattern: 'dd/MM/yyyy', pattern: '', case: 'none', digits: 'latin', emptyText: '', trim: true, locale: 'en', minInteger: 1 };
}

/** Create a new object of the given type with sensible defaults. */
export function createObject(type, patch = {}) {
  const base = { id: newId(type), type, name: '', x: 2, y: 2, width: 30, height: 6, rotation: 0, locked: false, hidden: false, printable: true, groupId: '', visibleIf: null };
  let object;
  switch (type) {
    case 'text':
      object = { ...base, name: 'Text', content: defaultContent(), prefix: '', suffix: '', format: defaultFormat(), style: defaultTextStyle() };
      break;
    case 'line':
      object = { ...base, name: 'Line', height: 0.5, direction: 'horizontal', stroke: { width: 0.3, color: '#000000', style: 'solid' } };
      break;
    case 'rect':
      object = { ...base, name: 'Rectangle', height: 10, stroke: { width: 0.3, color: '#000000', style: 'solid' }, fill: 'transparent', radius: 0 };
      break;
    case 'ellipse':
      object = { ...base, name: 'Ellipse', width: 10, height: 10, stroke: { width: 0.3, color: '#000000', style: 'solid' }, fill: 'transparent' };
      break;
    case 'image':
      object = { ...base, name: 'Image', width: 12, height: 12, src: '', fit: 'contain', mimeType: '' };
      break;
    case 'barcode':
      object = { ...base, name: 'Barcode', width: 35, height: 12, symbology: 'code128', content: { ...defaultContent(), mode: 'static', text: '123456' }, prefix: '', suffix: '', format: defaultFormat(), humanReadable: true, textSize: 7, color: '#000000', quietZone: true };
      break;
    case 'table':
      object = { ...base, name: 'Table', width: 40, height: 15, rows: 2, columns: 2, cells: [], stroke: { width: 0.2, color: '#000000', style: 'solid' }, style: { ...defaultTextStyle(), fontSize: 7 } };
      break;
    default:
      throw new Error('Unknown object type ' + type);
  }
  return sanitizeObject({ ...object, ...patch }, { width: 500, height: 1000 });
}

function sanitizeContent(src) {
  const c = src && typeof src === 'object' ? src : {};
  const d = defaultContent();
  const serial = c.serial && typeof c.serial === 'object' ? c.serial : {};
  const date = c.date && typeof c.date === 'object' ? c.date : {};
  return {
    mode: oneOf(c.mode, CONTENT_MODES, 'static'),
    text: str(c.text, LIMITS.maxText, d.text),
    field: str(c.field, 200),
    template: str(c.template, LIMITS.maxText),
    expression: str(c.expression, 2000),
    prompt: str(c.prompt, 80),
    date: { offsetDays: Math.round(clamp(date.offsetDays, -36500, 36500, 0)), offsetMonths: Math.round(clamp(date.offsetMonths, -1200, 1200, 0)) },
    serial: {
      start: str(serial.start, 40, '1') || '1',
      step: Math.round(clamp(serial.step, -1_000_000, 1_000_000, 1)) || 1,
      width: Math.round(clamp(serial.width, 0, 30, 0)),
      mode: oneOf(serial.mode, ['numeric', 'hex', 'alpha', 'alphanumeric'], 'numeric'),
      perCopy: bool(serial.perCopy, true),
      continueFromLast: bool(serial.continueFromLast, false)
    }
  };
}

function sanitizeFormat(src) {
  const f = src && typeof src === 'object' ? src : {};
  const d = defaultFormat();
  const decimals = f.decimals === null || f.decimals === undefined || f.decimals === '' ? null : Math.round(clamp(f.decimals, 0, 10, 2));
  return {
    kind: oneOf(f.kind, ['none', 'number', 'currency', 'percent', 'date', 'pattern'], 'none'),
    decimals,
    thousands: bool(f.thousands, false),
    currencySymbol: str(f.currencySymbol, 12, d.currencySymbol),
    symbolPosition: oneOf(f.symbolPosition, ['before', 'after'], 'after'),
    datePattern: str(f.datePattern, 60, d.datePattern) || d.datePattern,
    pattern: str(f.pattern, 60),
    case: oneOf(f.case, ['none', 'upper', 'lower', 'title'], 'none'),
    digits: oneOf(f.digits, ['latin', 'arabic'], 'latin'),
    emptyText: str(f.emptyText, 200),
    trim: bool(f.trim, true),
    locale: oneOf(f.locale, ['en', 'ar'], 'en'),
    minInteger: Math.round(clamp(f.minInteger, 1, 30, 1))
  };
}

function sanitizeStroke(src, fallbackWidth = 0.3) {
  const s = src && typeof src === 'object' ? src : {};
  return { width: round3(clamp(s.width, 0, 20, fallbackWidth)), color: color(s.color, '#000000'), style: oneOf(s.style, ['solid', 'dashed', 'dotted'], 'solid') };
}

function sanitizeTextStyle(src) {
  const s = src && typeof src === 'object' ? src : {};
  const d = defaultTextStyle();
  const border = s.border && typeof s.border === 'object' ? s.border : {};
  const family = str(s.fontFamily, 80, d.fontFamily).replace(/["'<>;{}\\]/g, '').trim() || d.fontFamily;
  return {
    fontFamily: family,
    fontSize: round3(clamp(s.fontSize, LIMITS.minFont, LIMITS.maxFont, d.fontSize)),
    bold: bool(s.bold), italic: bool(s.italic), underline: bool(s.underline), strike: bool(s.strike),
    color: color(s.color, d.color), background: color(s.background, d.background),
    align: oneOf(s.align, ['left', 'center', 'right', 'justify'], d.align),
    vAlign: oneOf(s.vAlign, ['top', 'middle', 'bottom'], d.vAlign),
    lineSpacing: round3(clamp(s.lineSpacing, 0.6, 4, d.lineSpacing)),
    letterSpacing: round3(clamp(s.letterSpacing, -2, 10, 0)),
    wrap: bool(s.wrap, true),
    overflow: oneOf(s.overflow, ['shrink', 'clip', 'visible'], d.overflow),
    minFontSize: round3(clamp(s.minFontSize, LIMITS.minFont, LIMITS.maxFont, d.minFontSize)),
    direction: oneOf(s.direction, ['auto', 'ltr', 'rtl'], 'auto'),
    padding: round3(clamp(s.padding, 0, 50, 0)),
    border: { width: round3(clamp(border.width, 0, 10, 0)), color: color(border.color, '#000000'), style: oneOf(border.style, ['solid', 'dashed', 'dotted'], 'solid'), radius: round3(clamp(border.radius, 0, 50, 0)) }
  };
}

export function sanitizeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  // Incomplete rules are kept (so the editor can be filled in) and evaluate as "always print".
  if (rule.kind === 'expression') return { kind: 'expression', expression: str(rule.expression, 2000) };
  if (rule.kind !== 'field' && rule.kind !== undefined) return null;
  return { kind: 'field', field: str(rule.field, 200).trim(), op: oneOf(rule.op, FILTER_OPERATORS, 'isNotEmpty'), value: str(rule.value, 500) };
}

const IMAGE_DATA_URI = /^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/;

export function sanitizeObject(candidate, page) {
  const src = candidate && typeof candidate === 'object' ? candidate : {};
  const type = oneOf(src.type, OBJECT_TYPES, 'text');
  const pw = page?.width ?? 500; const ph = page?.height ?? 1000;
  // Objects may extend beyond the label edge (bleed) but stay within a sane envelope.
  const x = round3(clamp(src.x, -pw, pw * 2, 0));
  const y = round3(clamp(src.y, -ph, ph * 2, 0));
  const base = {
    id: str(src.id, 120) || newId(type),
    type,
    name: str(src.name, LIMITS.maxName),
    x, y,
    width: round3(clamp(src.width, 0.1, pw * 3, Math.max(1, pw - 4))),
    height: round3(clamp(src.height, type === 'line' ? 0 : 0.1, ph * 3, 5)),
    rotation: round3(((clamp(src.rotation, -3600, 3600, 0) % 360) + 360) % 360),
    locked: bool(src.locked), hidden: bool(src.hidden), printable: bool(src.printable, true),
    groupId: str(src.groupId, 120),
    visibleIf: sanitizeRule(src.visibleIf)
  };
  switch (type) {
    case 'text':
      return { ...base, content: sanitizeContent(src.content), prefix: str(src.prefix, 200), suffix: str(src.suffix, 200), format: sanitizeFormat(src.format), style: sanitizeTextStyle(src.style) };
    case 'line':
      return { ...base, direction: oneOf(src.direction, ['horizontal', 'vertical', 'diagonal-down', 'diagonal-up'], 'horizontal'), stroke: sanitizeStroke(src.stroke) };
    case 'rect':
      return { ...base, stroke: sanitizeStroke(src.stroke), fill: color(src.fill, 'transparent'), radius: round3(clamp(src.radius, 0, 100, 0)) };
    case 'ellipse':
      return { ...base, stroke: sanitizeStroke(src.stroke), fill: color(src.fill, 'transparent') };
    case 'image': {
      const raw = typeof src.src === 'string' ? src.src : '';
      const ok = raw.length <= LIMITS.maxImageBytes * 1.4 && IMAGE_DATA_URI.test(raw);
      return { ...base, src: ok ? raw : '', fit: oneOf(src.fit, ['contain', 'cover', 'stretch'], 'contain'), mimeType: ok ? raw.slice(5, raw.indexOf(';')) : '' };
    }
    case 'barcode':
      return { ...base, symbology: oneOf(src.symbology, BARCODE_TYPES, 'code128'), content: sanitizeContent(src.content), prefix: str(src.prefix, 200), suffix: str(src.suffix, 200), format: sanitizeFormat(src.format), humanReadable: bool(src.humanReadable, true), textSize: round3(clamp(src.textSize, 3, 30, 7)), color: color(src.color, '#000000'), quietZone: bool(src.quietZone, true) };
    case 'table': {
      const rows = Math.round(clamp(src.rows, 1, 40, 2));
      const columns = Math.round(clamp(src.columns, 1, 20, 2));
      const cells = [];
      for (let r = 0; r < rows; r++) {
        const row = [];
        for (let c = 0; c < columns; c++) {
          const cell = Array.isArray(src.cells) && Array.isArray(src.cells[r]) ? src.cells[r][c] : null;
          row.push({ content: sanitizeContent(cell?.content || { mode: 'static', text: '' }), prefix: str(cell?.prefix, 100), suffix: str(cell?.suffix, 100), format: sanitizeFormat(cell?.format), align: oneOf(cell?.align, ['left', 'center', 'right'], 'left'), bold: bool(cell?.bold) });
        }
        cells.push(row);
      }
      const colWidths = Array.isArray(src.colWidths) && src.colWidths.length === columns ? src.colWidths.map((w) => clamp(w, 0.05, 100, 1)) : Array(columns).fill(1);
      const rowHeights = Array.isArray(src.rowHeights) && src.rowHeights.length === rows ? src.rowHeights.map((h) => clamp(h, 0.05, 100, 1)) : Array(rows).fill(1);
      return { ...base, rows, columns, cells, colWidths, rowHeights, stroke: sanitizeStroke(src.stroke, 0.2), style: sanitizeTextStyle(src.style) };
    }
    default:
      return base;
  }
}

export function defaultPage() {
  return { width: 50, height: 30, unit: 'mm', cornerRadius: 0, background: '#ffffff', dpi: 203, printRotation: 0, offsetX: 0, offsetY: 0, printerName: '', copies: 1, snapToDots: false };
}

function sanitizePage(src) {
  const p = src && typeof src === 'object' ? src : {};
  const d = defaultPage();
  return {
    width: round3(clamp(p.width, LIMITS.minPage, LIMITS.maxPageWidth, d.width)),
    height: round3(clamp(p.height, LIMITS.minPage, LIMITS.maxPageHeight, d.height)),
    unit: 'mm',
    cornerRadius: round3(clamp(p.cornerRadius, 0, 50, 0)),
    background: color(p.background, '#ffffff'),
    dpi: oneOf(Number(p.dpi), [150, 200, 203, 300, 600], 203),
    printRotation: oneOf(Number(p.printRotation), [0, 90, 180, 270], 0),
    offsetX: round3(clamp(p.offsetX, -20, 20, 0)),
    offsetY: round3(clamp(p.offsetY, -20, 20, 0)),
    printerName: str(p.printerName, 300),
    copies: Math.round(clamp(p.copies, 1, 10000, 1)),
    snapToDots: bool(p.snapToDots, false)
  };
}

function sanitizeData(src) {
  const d = src && typeof src === 'object' ? src : {};
  const filters = Array.isArray(d.filters) ? d.filters.slice(0, 20).map((f) => {
    const rule = sanitizeRule({ ...f, kind: 'field' });
    return rule && rule.field ? { field: rule.field, op: rule.op, value: rule.value } : null;
  }).filter(Boolean) : [];
  const sort = Array.isArray(d.sort) ? d.sort.slice(0, 5).map((s) => ({ field: str(s?.field, 200), dir: s?.dir === 'desc' ? 'desc' : 'asc' })).filter((s) => s.field) : [];
  return {
    connectionName: str(d.connectionName, 120),
    fileName: str(d.fileName, 260),
    sheetName: str(d.sheetName, 120),
    headerRow: Math.round(clamp(d.headerRow, 1, 1000, 1)),
    quantityField: str(d.quantityField, 200),
    quantityMode: oneOf(d.quantityMode, ['fixed', 'field'], d.quantityField ? 'field' : 'fixed'),
    filters, sort,
    dateOrder: oneOf(d.dateOrder, ['DMY', 'MDY', 'YMD'], 'DMY')
  };
}

function sanitizePrompt(src, index) {
  const p = src && typeof src === 'object' ? src : {};
  const name = str(p.name, 80).replace(/[{}?]/g, '').trim() || 'Prompt' + (index + 1);
  return {
    name,
    label: str(p.label, 120) || name,
    type: oneOf(p.type, ['text', 'number', 'date', 'choice'], 'text'),
    default: str(p.default, 500),
    required: bool(p.required),
    pattern: str(p.pattern, 200),
    choices: Array.isArray(p.choices) ? p.choices.slice(0, 50).map((c) => str(c, 200)) : []
  };
}

export function createTemplate(patch = {}) {
  const now = new Date().toISOString();
  return sanitizeTemplate({
    schema: TEMPLATE_SCHEMA, version: TEMPLATE_VERSION, id: newId('tpl'), name: 'New label', description: '', category: 'General', tags: [],
    createdAt: now, updatedAt: now, revision: 0, page: defaultPage(), objects: [], data: {}, prompts: [], serialState: {},
    ...patch
  });
}

/**
 * Validate and normalise any candidate template (including older versions).
 * Returns null if the candidate is not recognisable as a template.
 */
export function sanitizeTemplate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  let src = candidate;
  if (!src.version || src.version < 2 || Array.isArray(src.fields)) src = migrateV1(src);
  if (!src) return null;
  if (Number(src.version) > TEMPLATE_VERSION) {
    throw new Error('This template was created by a newer version of Excel Label Studio (format v' + src.version + '). Update the app to open it.');
  }
  const page = sanitizePage(src.page);
  const rawObjects = Array.isArray(src.objects) ? src.objects : [];
  if (rawObjects.length > LIMITS.maxObjects) throw new Error('Templates may contain at most ' + LIMITS.maxObjects + ' objects.');
  const seen = new Set();
  const objects = rawObjects.map((o) => sanitizeObject(o, page)).map((o) => {
    if (seen.has(o.id)) o = { ...o, id: newId(o.type) };
    seen.add(o.id);
    return o;
  });
  const prompts = Array.isArray(src.prompts) ? src.prompts.slice(0, LIMITS.maxPrompts).map(sanitizePrompt) : [];
  const serialState = {};
  if (src.serialState && typeof src.serialState === 'object') {
    for (const [key, value] of Object.entries(src.serialState).slice(0, 200)) serialState[str(key, 120)] = str(value, 40);
  }
  return {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    id: str(src.id, 120) || newId('tpl'),
    name: str(src.name, LIMITS.maxName, 'Untitled label'),
    description: str(src.description, 1000),
    category: str(src.category, 60, 'General') || 'General',
    tags: Array.isArray(src.tags) ? src.tags.slice(0, 20).map((t) => str(t, 40)).filter(Boolean) : [],
    createdAt: validIso(src.createdAt) || new Date().toISOString(),
    updatedAt: validIso(src.updatedAt) || new Date().toISOString(),
    revision: Math.max(0, Math.round(clamp(src.revision, 0, Number.MAX_SAFE_INTEGER, 0))),
    page, objects, data: sanitizeData(src.data), prompts, serialState,
    meta: { migratedFrom: Number(src.meta?.migratedFrom) === 1 ? 1 : 0 },
    ...(src.starter ? { starter: true } : {})
  };
}

function validIso(value) {
  if (typeof value !== 'string') return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

// ---------- migration from v0.2.0 (format v1) ----------

const LEGACY_AUTO_FIELDS = { name: 'Product Name', price: 'Price', barcode: 'Barcode', quantity: 'Quantity', description: 'Description' };

/**
 * v0.2.0 templates: { id, name, width, height, fields: [{ type:'column'|'text', columnKey, autoField, text,
 *   prefix, suffix, x, y, width, height, fontSize(px), bold, italic, underline, fontFamily, wrap, rotation, align }] }
 */
export function migrateV1(old) {
  if (!old || typeof old !== 'object') return null;
  if (!Array.isArray(old.fields) && !Array.isArray(old.objects)) return null;
  if (!Array.isArray(old.fields)) return { ...old, version: TEMPLATE_VERSION };
  const width = clamp(old.width, LIMITS.minPage, LIMITS.maxPageWidth, 50);
  const height = clamp(old.height, LIMITS.minPage, LIMITS.maxPageHeight, 30);
  const objects = old.fields.slice(0, LIMITS.maxObjects).map((f, index) => {
    const field = f && typeof f === 'object' ? f : {};
    const isColumn = field.type !== 'text';
    const columnKey = String(field.columnKey || '') || (isColumn ? LEGACY_AUTO_FIELDS[field.autoField] || '' : '');
    const px = clamp(field.fontSize, 4, 200, 12);
    return {
      id: String(field.id || 'field-' + index),
      type: 'text',
      name: String(field.label || (isColumn ? columnKey : 'Text') || 'Text'),
      x: field.x, y: field.y, width: field.width, height: field.height,
      rotation: field.rotation || 0,
      content: isColumn ? { mode: 'field', field: columnKey, text: '' } : { mode: 'static', text: String(field.text ?? '') },
      prefix: field.prefix || '', suffix: field.suffix || '',
      format: { kind: 'none' },
      style: {
        fontFamily: field.fontFamily || 'Arial',
        // v1 stored CSS pixels (1px = 0.75pt)
        fontSize: Math.round(px * 0.75 * 2) / 2,
        bold: Boolean(field.bold), italic: Boolean(field.italic), underline: Boolean(field.underline),
        align: field.align || 'center', vAlign: 'top', wrap: field.wrap !== false, overflow: 'clip', lineSpacing: 1.1
      }
    };
  });
  return {
    schema: TEMPLATE_SCHEMA, version: TEMPLATE_VERSION,
    id: old.id, name: old.name || 'Migrated template', category: 'Migrated',
    page: { ...defaultPage(), width, height },
    objects,
    data: {},
    meta: { migratedFrom: 1 }
  };
}

/** Field names a template needs from the data source (for missing-column warnings). */
export function objectFieldNames(object, helpers) {
  const names = new Set();
  const add = (name) => { if (name) names.add(name); };
  const contentFields = (content) => {
    if (!content) return;
    if (content.mode === 'field') add(content.field);
    if (content.mode === 'template') helpers.templateFields(content.template).forEach(add);
    if (content.mode === 'expression') { try { helpers.referencedFields(content.expression).forEach(add); } catch { /* invalid expression reported elsewhere */ } }
  };
  if (object.content) contentFields(object.content);
  if (object.type === 'table') object.cells.flat().forEach((cell) => contentFields(cell.content));
  if (object.visibleIf?.kind === 'field' && object.visibleIf.field) add(object.visibleIf.field);
  if (object.visibleIf?.kind === 'expression' && object.visibleIf.expression.trim()) { try { helpers.referencedFields(object.visibleIf.expression).forEach(add); } catch { /* reported elsewhere */ } }
  return [...names];
}
