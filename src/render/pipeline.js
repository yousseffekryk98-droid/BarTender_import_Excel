// Renderer-side label pipeline: evaluates labels, generates barcodes, fits text using the
// browser's own layout engine (the same engine that prints), and builds print chunks.

import { buildLabel, renderLabelHtml, printDocumentHtml, LABEL_CSS } from '../engine/render.js';
import { iterateLabels, chunkRanges, SPOOL_CHUNK, serialStartsFor } from '../engine/jobs.js';
import { barcodeSvg } from '../engine/barcode.js';

let measureRoot = null;
function root() {
  if (measureRoot && document.body.contains(measureRoot)) return measureRoot;
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:auto;height:auto;visibility:hidden;pointer-events:none;contain:layout style';
  const style = document.createElement('style');
  style.textContent = LABEL_CSS;
  host.appendChild(style);
  const box = document.createElement('div');
  host.appendChild(box);
  document.body.appendChild(host);
  measureRoot = box;
  return box;
}

const fitCache = new Map();
const EPS = 0.5; // px tolerance for sub-pixel rounding

// Measured on un-rotated copies so bounding boxes equal layout boxes.
function overflows(outer, inner) {
  const cs = getComputedStyle(outer);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
  const o = outer.getBoundingClientRect();
  const r = inner.getBoundingClientRect();
  const contentH = Math.max(r.height, inner.scrollHeight - 0.5);
  const contentW = Math.max(r.width, inner.scrollWidth - 0.5);
  return contentH > o.height - padY + EPS || contentW > o.width - padX + EPS;
}

/**
 * Compute fitted font sizes and clipping for the text objects of one built label.
 * Returns { fit: { id: pt }, clipped: [{ id, name, text }] }
 */
export function fitLabel(template, built) {
  const fit = {};
  const clipped = [];
  const candidates = built.items.filter((i) => i.object.type === 'text' && i.visible && !i.object.hidden && i.object.printable !== false && i.text && i.object.style.overflow !== 'visible');
  if (!candidates.length) return { fit, clipped };
  const pending = [];
  for (const item of candidates) {
    const o = item.object; const s = o.style;
    const key = [o.width, o.height, s.fontFamily, s.fontSize, s.minFontSize, s.bold, s.italic, s.lineSpacing, s.letterSpacing, s.wrap, s.padding, s.border.width, s.overflow, s.direction, item.text].join('\u0001');
    const cached = fitCache.get(key);
    if (cached) { if (cached.size !== s.fontSize) fit[o.id] = cached.size; if (cached.clipped) clipped.push({ id: o.id, name: o.name, text: item.text }); continue; }
    pending.push({ item, key });
  }
  if (!pending.length) return { fit, clipped };
  const box = root();
  box.innerHTML = renderLabelHtml(template, { items: pending.map((p) => ({ ...p.item, object: { ...p.item.object, rotation: 0 } })) }, { mode: 'print' });
  for (const { item, key } of pending) {
    const o = item.object; const s = o.style;
    const outer = box.querySelector('[data-object-id="' + CSS.escape(o.id) + '"]');
    const inner = outer?.firstElementChild;
    if (!outer || !inner) continue;
    let size = s.fontSize;
    let isClipped = overflows(outer, inner);
    if (isClipped && s.overflow === 'shrink') {
      let lo = Math.min(s.minFontSize, s.fontSize); let hi = s.fontSize; let best = null;
      for (let i = 0; i < 10 && hi - lo > 0.1; i++) {
        const mid = (lo + hi) / 2;
        inner.style.fontSize = mid + 'pt';
        if (overflows(outer, inner)) hi = mid; else { best = mid; lo = mid; }
      }
      if (best === null) {
        inner.style.fontSize = lo + 'pt';
        if (!overflows(outer, inner)) best = lo;
      }
      if (best !== null) { size = Math.floor(best * 10) / 10; isClipped = false; } else { size = Math.min(s.minFontSize, s.fontSize); isClipped = true; }
    }
    if (fitCache.size > 20000) fitCache.clear();
    fitCache.set(key, { size, clipped: isClipped });
    if (size !== s.fontSize) fit[o.id] = size;
    if (isClipped) clipped.push({ id: o.id, name: o.name, text: item.text });
  }
  box.innerHTML = '';
  return { fit, clipped };
}

/** Generate barcode SVGs for one built label. */
export async function barcodesFor(built) {
  const barcodes = {}; const barcodeErrors = {};
  for (const item of built.items) {
    if (item.object.type !== 'barcode' || !item.visible) continue;
    const result = await barcodeSvg(item.object, item.text);
    if (result.svg) barcodes[item.object.id] = result.svg; else barcodeErrors[item.object.id] = result.error;
  }
  return { barcodes, barcodeErrors };
}

/** Render one label (built) to HTML with fitting and barcodes. */
export async function renderPreparedLabel(template, built, mode = 'print') {
  const { fit, clipped } = fitLabel(template, built);
  const { barcodes, barcodeErrors } = await barcodesFor(built);
  return { html: renderLabelHtml(template, built, { mode, fit, barcodes, barcodeErrors }), clipped, barcodeErrors };
}

export function paperSize(page) {
  const swap = page.printRotation === 90 || page.printRotation === 270;
  return swap ? { width: page.height, height: page.width } : { width: page.width, height: page.height };
}

/**
 * Validate a planned job by evaluating every label once (expressions, barcodes, clipping),
 * without building documents. Returns { errors, clipped, barcodeErrors, checked }.
 */
export async function validateJob({ template, plan, headers, prompts, sources, now, limit = 5000, onProgress, signal }) {
  const errors = []; const clipped = []; const barcodeErrors = [];
  const serialStart = serialStartsFor(template);
  let checked = 0;
  for (const label of iterateLabels(plan, 0, Math.min(plan.total, limit))) {
    if (signal?.aborted) break;
    const built = buildLabel(template, { headers, record: label.record, prompts, sources, now, recordNumber: label.recordIndex + 1, recordIndex: label.recordIndex, labelNumber: label.labelIndex + 1, labelIndex: label.labelIndex, copyNumber: label.copyNumber, copies: label.copies, serialStart });
    const where = 'Row ' + (label.record.rowNumber ?? label.record.id);
    for (const e of built.errors) if (errors.length < 50) errors.push(where + ': ' + e);
    if (label.copyNumber === 1 || template.objects.some((o) => o.content?.mode === 'serial' || o.content?.mode === 'expression')) {
      const { clipped: c } = fitLabel(template, built);
      for (const x of c) if (clipped.length < 50) clipped.push(where + ': "' + (x.name || 'Text') + '" is cut off ("' + x.text.slice(0, 40) + (x.text.length > 40 ? '…' : '') + '")');
      const { barcodeErrors: be } = await barcodesFor(built);
      for (const [id, message] of Object.entries(be)) if (barcodeErrors.length < 50) barcodeErrors.push(where + ': barcode "' + (template.objects.find((o) => o.id === id)?.name || id) + '": ' + message);
    }
    checked++;
    if (checked % 200 === 0) { onProgress?.(checked); await new Promise((r) => setTimeout(r, 0)); }
  }
  return { errors, clipped, barcodeErrors, checked };
}

/**
 * Build print documents for a planned job in spool-sized chunks.
 * Calls onChunk({ html, labelCount, index, count, start, end }) sequentially; stops when signal aborts.
 */
export async function buildChunks({ template, plan, headers, prompts, sources, now, onChunk, onProgress, signal, chunkSize = SPOOL_CHUNK, title }) {
  const ranges = chunkRanges(plan.total, chunkSize);
  const serialStart = serialStartsFor(template);
  let done = 0;
  for (let index = 0; index < ranges.length; index++) {
    if (signal?.aborted) return { cancelled: true, done };
    const [start, end] = ranges[index];
    const htmls = [];
    for (const label of iterateLabels(plan, start, end)) {
      const built = buildLabel(template, { headers, record: label.record, prompts, sources, now, recordNumber: label.recordIndex + 1, recordIndex: label.recordIndex, labelNumber: label.labelIndex + 1, labelIndex: label.labelIndex, copyNumber: label.copyNumber, copies: label.copies, serialStart });
      if (built.errors.length) throw new Error('Row ' + (label.record.rowNumber ?? label.record.id) + ': ' + built.errors[0]);
      htmls.push((await renderPreparedLabel(template, built)).html);
      done++;
      if (done % 50 === 0) { onProgress?.(done, plan.total); await new Promise((r) => setTimeout(r, 0)); }
    }
    const html = printDocumentHtml(htmls, template.page, { title: title || template.name });
    const keepGoing = await onChunk({ html, labelCount: htmls.length, index, count: ranges.length, start, end });
    onProgress?.(done, plan.total);
    if (keepGoing === false) return { cancelled: true, done };
  }
  return { cancelled: false, done };
}
