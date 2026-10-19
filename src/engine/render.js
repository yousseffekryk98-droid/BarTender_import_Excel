// Deterministic label renderer: the same HTML is used by the designer canvas,
// print preview, PDF export and Windows printing. Geometry in mm, fonts in pt.

import { makeContext, resolveText, evaluateRule } from './binding.js';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const mm = (n) => (Math.round(Number(n) * 1000) / 1000) + 'mm';
const pt = (n) => (Math.round(Number(n) * 100) / 100) + 'pt';
const cssFont = (family) => "'" + String(family || 'Arial').replace(/['"\\<>;{}]/g, '') + "', 'Segoe UI', Tahoma, Arial, sans-serif";

function snap(value, page) {
  if (!page.snapToDots) return value;
  const dot = 25.4 / (page.dpi || 203);
  return Math.round(value / dot) * dot;
}

/**
 * Evaluate every object of the template for one label.
 * Returns { items: [{ object, visible, text, error }], errors: [string], missing: [fieldNames] }
 */
export function buildLabel(template, contextOptions = {}) {
  const ctx = makeContext({ dateOrder: template.data?.dateOrder, ...contextOptions });
  const errors = [];
  const items = (template.objects || []).map((object) => {
    const item = { object, visible: true, text: '', error: '' };
    try {
      if (object.visibleIf) item.visible = evaluateRule(object.visibleIf, ctx);
    } catch (error) {
      item.error = 'Visibility rule: ' + error.message;
    }
    try {
      if (object.type === 'text' || object.type === 'barcode') item.text = resolveText(object, ctx);
      if (object.type === 'table') {
        item.cells = object.cells.map((row) => row.map((cell) => {
          try { return resolveText({ ...cell, id: object.id }, ctx); } catch (error) { item.error = item.error || error.message; return '#ERR'; }
        }));
      }
    } catch (error) {
      item.error = item.error || error.message;
      item.text = '#ERR';
    }
    if (item.error) errors.push((object.name || object.type) + ': ' + item.error);
    return item;
  });
  return { items, errors, missing: [...ctx.missing] };
}

function boxStyle(object, page, extra = []) {
  return [
    'left:' + mm(snap(object.x, page)), 'top:' + mm(snap(object.y, page)),
    'width:' + mm(snap(object.width, page)), 'height:' + mm(snap(object.height, page)),
    object.rotation ? 'transform:rotate(' + object.rotation + 'deg)' : '',
    ...extra
  ].filter(Boolean).join(';');
}

function borderCss(border) {
  if (!border || !border.width) return '';
  return 'border:' + mm(border.width) + ' ' + border.style + ' ' + border.color + (border.radius ? ';border-radius:' + mm(border.radius) : '');
}

function textHtml(item, page, fontSize, options) {
  const { object } = item;
  const s = object.style;
  const justify = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[s.vAlign] || 'flex-start';
  const outer = boxStyle(object, page, [
    'display:flex', 'flex-direction:column', 'justify-content:' + justify,
    'padding:' + mm(s.padding || 0),
    s.background && s.background !== 'transparent' ? 'background:' + s.background : '',
    borderCss(s.border),
    s.overflow === 'visible' ? 'overflow:visible' : 'overflow:hidden'
  ]);
  const decoration = [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
  const inner = [
    'font-family:' + cssFont(s.fontFamily),
    'font-size:' + pt(fontSize),
    'font-weight:' + (s.bold ? 700 : 400),
    'font-style:' + (s.italic ? 'italic' : 'normal'),
    'text-decoration:' + decoration,
    'color:' + s.color,
    'text-align:' + s.align,
    s.align === 'justify' ? 'text-align-last:auto' : '',
    'line-height:' + s.lineSpacing,
    s.letterSpacing ? 'letter-spacing:' + pt(s.letterSpacing) : '',
    'white-space:' + (s.wrap ? 'pre-wrap' : 'pre'),
    s.wrap ? 'overflow-wrap:anywhere' : '',
    s.direction === 'auto' ? 'unicode-bidi:plaintext' : 'direction:' + s.direction
  ].filter(Boolean).join(';');
  const dir = s.direction === 'auto' ? 'auto' : s.direction;
  return '<div class="els-obj els-text' + (options.ghost ? ' els-ghost' : '') + '" data-object-id="' + escapeHtml(object.id) + '" style="' + escapeHtml(outer) + '">' +
    '<div class="els-text-inner" dir="' + dir + '" style="' + escapeHtml(inner) + '">' + escapeHtml(item.text) + '</div></div>';
}

function dashArray(stroke) {
  if (stroke.style === 'dashed') return ' stroke-dasharray="' + (stroke.width * 4) + ' ' + (stroke.width * 2) + '"';
  if (stroke.style === 'dotted') return ' stroke-dasharray="' + stroke.width + ' ' + (stroke.width * 1.5) + '" stroke-linecap="round"';
  return '';
}

function shapeHtml(item, page, options) {
  const { object } = item;
  const w = Math.max(object.width, 0.01); const h = Math.max(object.height, 0.01);
  const sw = object.stroke?.width || 0;
  const strokeAttr = sw ? ' stroke="' + escapeHtml(object.stroke.color) + '" stroke-width="' + sw + '"' + dashArray(object.stroke) : ' stroke="none"';
  let body = '';
  if (object.type === 'line') {
    const [x1, y1, x2, y2] = {
      horizontal: [0, h / 2, w, h / 2], vertical: [w / 2, 0, w / 2, h],
      'diagonal-down': [0, 0, w, h], 'diagonal-up': [0, h, w, 0]
    }[object.direction] || [0, h / 2, w, h / 2];
    body = '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"' + strokeAttr + ' fill="none"/>';
  } else if (object.type === 'rect') {
    const inset = sw / 2;
    body = '<rect x="' + inset + '" y="' + inset + '" width="' + Math.max(0, w - sw) + '" height="' + Math.max(0, h - sw) + '"' +
      (object.radius ? ' rx="' + object.radius + '" ry="' + object.radius + '"' : '') +
      ' fill="' + escapeHtml(object.fill || 'none') + '"' + strokeAttr + '/>';
  } else {
    body = '<ellipse cx="' + w / 2 + '" cy="' + h / 2 + '" rx="' + Math.max(0, (w - sw) / 2) + '" ry="' + Math.max(0, (h - sw) / 2) + '" fill="' + escapeHtml(object.fill || 'none') + '"' + strokeAttr + '/>';
  }
  return '<svg class="els-obj els-shape' + (options.ghost ? ' els-ghost' : '') + '" data-object-id="' + escapeHtml(object.id) + '" style="' + escapeHtml(boxStyle(object, page, ['overflow:visible'])) +
    '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' + body + '</svg>';
}

function imageHtml(item, page, options) {
  const { object } = item;
  const fit = { contain: 'contain', cover: 'cover', stretch: 'fill' }[object.fit] || 'contain';
  const style = boxStyle(object, page, ['object-fit:' + fit]);
  if (!object.src) {
    return '<div class="els-obj els-image-empty' + (options.ghost ? ' els-ghost' : '') + '" data-object-id="' + escapeHtml(object.id) + '" style="' + escapeHtml(style) + '"></div>';
  }
  return '<img class="els-obj els-image' + (options.ghost ? ' els-ghost' : '') + '" alt="" data-object-id="' + escapeHtml(object.id) + '" src="' + escapeHtml(object.src) + '" style="' + escapeHtml(style) + '">';
}

/** Only accept SVG produced by our barcode generator, without scripts, links or handlers. */
export function safeSvg(svg) {
  const text = String(svg || '').trim();
  if (!text.startsWith('<svg') || text.length > 3_000_000) return '';
  if (/<script|<foreignObject|\son\w+\s*=|href\s*=|javascript:|<iframe|<image/i.test(text)) return '';
  return text;
}

function barcodeHtml(item, page, options) {
  const { object } = item;
  const svg = safeSvg(options.barcodes?.[object.id]);
  const style = boxStyle(object, page, ['display:flex', 'align-items:center', 'justify-content:center']);
  const twoD = ['qrcode', 'datamatrix', 'azteccode', 'pdf417'].includes(object.symbology);
  const content = svg
    ? svg.replace('<svg', '<svg preserveAspectRatio="' + (twoD ? 'xMidYMid meet' : 'none') + '" style="width:100%;height:100%"')
    : '<span class="els-barcode-error">' + escapeHtml(options.barcodeErrors?.[object.id] || item.text) + '</span>';
  return '<div class="els-obj els-barcode' + (options.ghost ? ' els-ghost' : '') + '" data-object-id="' + escapeHtml(object.id) + '" style="' + escapeHtml(style) + '">' + content + '</div>';
}

function tableHtml(item, page, options) {
  const { object } = item;
  const s = object.style;
  const totalW = object.colWidths.reduce((a, b) => a + b, 0);
  const totalH = object.rowHeights.reduce((a, b) => a + b, 0);
  const border = object.stroke?.width ? mm(object.stroke.width) + ' ' + object.stroke.style + ' ' + object.stroke.color : 'none';
  const rows = object.cells.map((row, r) => '<tr style="height:' + mm(object.height * object.rowHeights[r] / totalH) + '">' + row.map((cell, c) =>
    '<td style="' + escapeHtml('width:' + mm(object.width * object.colWidths[c] / totalW) + ';border:' + border + ';text-align:' + cell.align + ';font-weight:' + (cell.bold ? 700 : 400)) + '" dir="auto">' +
    escapeHtml(item.cells?.[r]?.[c] ?? '') + '</td>').join('') + '</tr>').join('');
  const style = boxStyle(object, page, ['font-family:' + cssFont(s.fontFamily), 'font-size:' + pt(s.fontSize), 'line-height:' + s.lineSpacing, 'color:' + s.color]);
  return '<table class="els-obj els-table' + (options.ghost ? ' els-ghost' : '') + '" data-object-id="' + escapeHtml(object.id) + '" style="' + escapeHtml(style) + '"><tbody>' + rows + '</tbody></table>';
}

/**
 * Render one evaluated label to HTML.
 * options: { mode: 'print'|'design', fit: { objectId: fontPt }, barcodes: { objectId: svg }, barcodeErrors, selection }
 */
export function renderLabelHtml(template, built, options = {}) {
  const page = template.page;
  const design = options.mode === 'design';
  const parts = [];
  for (const item of built.items) {
    const { object } = item;
    const hiddenByRule = !item.visible;
    if (!design && (hiddenByRule || object.printable === false || object.hidden)) continue;
    if (design && object.hidden) continue;
    const ghost = design && (hiddenByRule || object.printable === false);
    const opts = { ...options, ghost };
    switch (object.type) {
      case 'text': parts.push(textHtml(item, page, options.fit?.[object.id] ?? object.style.fontSize, opts)); break;
      case 'line': case 'rect': case 'ellipse': parts.push(shapeHtml(item, page, opts)); break;
      case 'image': parts.push(imageHtml(item, page, opts)); break;
      case 'barcode': parts.push(barcodeHtml(item, page, opts)); break;
      case 'table': parts.push(tableHtml(item, page, opts)); break;
      default: break;
    }
  }
  const style = 'width:' + mm(page.width) + ';height:' + mm(page.height) + ';background:' + page.background +
    (page.cornerRadius && design ? ';border-radius:' + mm(page.cornerRadius) : '');
  return '<article class="els-label" style="' + escapeHtml(style) + '">' + parts.join('') + '</article>';
}

export const LABEL_CSS = `
.els-label{position:relative;overflow:hidden;box-sizing:border-box;color:#000;flex:none;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.els-label *{box-sizing:border-box}
.els-obj{position:absolute;margin:0;transform-origin:center center}
.els-text-inner{display:block;margin:0;padding:0;max-width:100%}
.els-image,.els-image-empty{display:block}
.els-image-empty{outline:0.2mm dashed #9aa4b2}
.els-table{border-collapse:collapse;table-layout:fixed}
.els-table td{padding:0 0.4mm;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:middle}
.els-barcode svg{display:block}
.els-barcode-error{font:7pt Arial,sans-serif;color:#b42318;text-align:center}
.els-ghost{opacity:.35}
`;

/**
 * Wrap rendered labels into a printable document: one label per page, page = label size,
 * no margins. Optional print rotation (for printers that feed sideways) and offsets.
 */
export function printDocumentHtml(labelHtmls, page, options = {}) {
  const rotation = Number(page.printRotation) || 0;
  const swap = rotation === 90 || rotation === 270;
  const pw = swap ? page.height : page.width;
  const ph = swap ? page.width : page.height;
  const ox = Number(page.offsetX) || 0; const oy = Number(page.offsetY) || 0;
  const transform = {
    0: 'translate(' + mm(ox) + ',' + mm(oy) + ')',
    90: 'translate(' + mm(page.height + ox) + ',' + mm(oy) + ') rotate(90deg)',
    180: 'translate(' + mm(page.width + ox) + ',' + mm(page.height + oy) + ') rotate(180deg)',
    270: 'translate(' + mm(ox) + ',' + mm(page.width + oy) + ') rotate(270deg)'
  }[rotation];
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  const pages = labelHtmls.map((html) => '<section class="els-page"><div class="els-place">' + html + '</div></section>').join('');
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
    '<title>' + escapeHtml(options.title || 'Labels') + '</title><style>' +
    '@page{size:' + mm(pw) + ' ' + mm(ph) + ';margin:0}' +
    'html,body{margin:0;padding:0;background:#fff}' +
    '.els-page{position:relative;width:' + mm(pw) + ';height:' + mm(ph) + ';overflow:hidden;break-after:page;page-break-after:always}' +
    '.els-page:last-child{break-after:auto;page-break-after:auto}' +
    '.els-place{position:absolute;left:0;top:0;transform-origin:0 0;transform:' + transform + '}' +
    LABEL_CSS + '</style></head><body>' + pages + '</body></html>';
}

/** Alignment test page: border, centre cross, 5 mm ticks and the configured size. */
export function testPatternLabelHtml(page) {
  const w = page.width; const h = page.height;
  const ticks = [];
  for (let x = 5; x < w; x += 5) ticks.push('<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + (x % 10 === 0 ? 3 : 1.8) + '" stroke="#000" stroke-width="0.2"/>');
  for (let y = 5; y < h; y += 5) ticks.push('<line x1="0" y1="' + y + '" x2="' + (y % 10 === 0 ? 3 : 1.8) + '" y2="' + y + '" stroke="#000" stroke-width="0.2"/>');
  const size = Math.max(4, Math.min(10, h / 5));
  const svg = '<svg style="position:absolute;left:0;top:0;width:' + mm(w) + ';height:' + mm(h) + '" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="0.5" y="0.5" width="' + (w - 1) + '" height="' + (h - 1) + '" fill="none" stroke="#000" stroke-width="0.3"/>' +
    '<line x1="' + (w / 2 - 3) + '" y1="' + h / 2 + '" x2="' + (w / 2 + 3) + '" y2="' + h / 2 + '" stroke="#000" stroke-width="0.2"/>' +
    '<line x1="' + w / 2 + '" y1="' + (h / 2 - 3) + '" x2="' + w / 2 + '" y2="' + (h / 2 + 3) + '" stroke="#000" stroke-width="0.2"/>' +
    ticks.join('') + '</svg>';
  const text = '<div style="position:absolute;left:4mm;right:4mm;top:' + mm(h / 2 + 1) + ';text-align:center;font:' + pt(size) + ' Arial,sans-serif">' +
    escapeHtml(w + ' × ' + h + ' mm') + '</div>';
  return '<article class="els-label" style="width:' + mm(w) + ';height:' + mm(h) + ';background:#fff">' + svg + text + '</article>';
}
