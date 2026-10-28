import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildLabel, renderLabelHtml, LABEL_CSS } from '../engine/render.js';
import { fitLabel, barcodesFor } from '../render/pipeline.js';
import { MM_TO_PX, boundsOf, snapMove, moveObjects, resizeBox, rotationFrom, hitMarquee, expandGroups } from './geometry.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const RULER = 22;

function Ruler({ orientation, lengthMm, zoom, offset, cursor }) {
  const scale = MM_TO_PX * zoom;
  const step = scale >= 12 ? 1 : scale >= 5 ? 2 : 5;
  const ticks = [];
  for (let mm = 0; mm <= lengthMm; mm += step) {
    const major = mm % 10 === 0; const mid = mm % 5 === 0;
    ticks.push(<div key={mm} className={'tick' + (major ? ' major' : mid ? ' mid' : '')}
      style={orientation === 'h' ? { left: offset + mm * scale } : { top: offset + mm * scale }}>
      {major && <span>{mm}</span>}
    </div>);
  }
  return <div className={'ruler ruler-' + orientation} aria-hidden="true">
    {ticks}
    {cursor !== null && cursor !== undefined && <div className="ruler-cursor" style={orientation === 'h' ? { left: offset + cursor * scale } : { top: offset + cursor * scale }} />}
  </div>;
}

/**
 * The WYSIWYG label canvas. Renders the label with the print renderer and draws an
 * interaction overlay (selection, move, resize, rotate, marquee, snapping guides) on top.
 */
export default function Canvas({
  template, selection, onSelect, onChange, onEndChange, zoom, onZoom, showGrid, gridSize, snapGrid, snapObjects,
  headers, record, prompts, onDropField, onEditText, onTextCommit, onCursor, onContextMenu, dataLoaded
}) {
  const scrollRef = useRef(null);
  const paperRef = useRef(null);
  const dragRef = useRef(null);
  const inlineRef = useRef(null);
  const [inlineEdit, setInlineEdit] = useState(null);
  const [guides, setGuides] = useState([]);
  const [marquee, setMarquee] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [extras, setExtras] = useState({ barcodes: {}, barcodeErrors: {} });
  const [paperOffset, setPaperOffset] = useState({ x: 40, y: 40 });
  const page = template.page;
  useEffect(() => { if (inlineEdit) { inlineRef.current?.focus(); inlineRef.current?.select(); } }, [inlineEdit?.id]);
  function beginEdit(id) {
    const obj = template.objects.find((o) => o.id === id);
    if (!obj || obj.type !== 'text') return;
    onSelect([id]);
    if (obj.content.mode !== 'static') { onEditText?.(id); return; }
    setInlineEdit({ id, text: obj.content.text || '' });
  }
  function finishEdit(shouldSave) {
    if (!inlineEdit) return;
    if (shouldSave) onTextCommit?.(inlineEdit.id, inlineEdit.text);
    setInlineEdit(null);
  }
  const scale = MM_TO_PX * zoom;

  const built = useMemo(() => buildLabel(template, {
    headers: headers || [], record: record || { cells: [], raw: [] }, prompts, placeholders: !dataLoaded,
    recordNumber: 1, labelNumber: 1, recordIndex: 0, labelIndex: 0
  }), [template, headers, record, prompts, dataLoaded]);

  useEffect(() => {
    let cancelled = false;
    if (!built.items.some((i) => i.object.type === 'barcode')) { setExtras({ barcodes: {}, barcodeErrors: {} }); return undefined; }
    barcodesFor(built).then((r) => { if (!cancelled) setExtras(r); });
    return () => { cancelled = true; };
  }, [built]);

  const { html, clipped } = useMemo(() => {
    const { fit, clipped: c } = fitLabel(template, built);
    return { html: renderLabelHtml(template, built, { mode: 'design', fit, ...extras }), clipped: new Set(c.map((x) => x.id)) };
  }, [template, built, extras]);

  // centre the paper in the scroll area
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const update = () => {
      const w = page.width * scale; const h = page.height * scale;
      setPaperOffset({ x: Math.max(40, (el.clientWidth - RULER - w) / 2), y: Math.max(40, (el.clientHeight - RULER - h) / 2) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page.width, page.height, scale]);

  const toMm = (event) => {
    const rect = paperRef.current.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  };

  const objects = template.objects;
  const selectedObjects = objects.filter((o) => selection.includes(o.id));
  const single = selectedObjects.length === 1 ? selectedObjects[0] : null;
  const threshold = 6 / scale; // 6 screen px

  function startMove(event, id) {
    const target = objects.find((o) => o.id === id);
    let ids = selection;
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      ids = selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id];
      onSelect(event.altKey ? ids : expandGroups(objects, ids));
      return;
    }
    if (!selection.includes(id)) { ids = event.altKey ? [id] : expandGroups(objects, [id]); onSelect(ids); }
    const moving = objects.filter((o) => ids.includes(o.id) && !o.locked);
    if (!moving.length || target?.locked) return;
    dragRef.current = { kind: 'move', start: toMm(event), ids: moving.map((o) => o.id), bounds: boundsOf(moving), original: objects, moved: false };
  }

  function startResize(event, handle) {
    event.stopPropagation();
    if (!single || single.locked) return;
    dragRef.current = { kind: 'resize', handle, start: toMm(event), box: { x: single.x, y: single.y, width: single.width, height: single.height }, id: single.id, moved: false };
  }

  function startRotate(event) {
    event.stopPropagation();
    if (!single || single.locked) return;
    dragRef.current = { kind: 'rotate', id: single.id, center: { x: single.x + single.width / 2, y: single.y + single.height / 2 }, moved: false };
  }

  function onPointerDown(event) {
    if (event.button !== 0 || event.target.closest('[data-inline-editor]')) return;
    const handle = event.target.closest('[data-handle]');
    const hit = event.target.closest('[data-hit]');
    paperRef.current.parentElement.setPointerCapture(event.pointerId);
    if (handle) {
      if (handle.dataset.handle === 'rotate') startRotate(event);
      else startResize(event, handle.dataset.handle);
    } else if (hit) {
      startMove(event, hit.dataset.hit);
    } else {
      const start = toMm(event);
      if (!event.shiftKey) onSelect([]);
      dragRef.current = { kind: 'marquee', start, additive: event.shiftKey };
      setMarquee({ x1: start.x, y1: start.y, x2: start.x, y2: start.y });
    }
  }

  function onPointerMove(event) {
    const p = paperRef.current ? toMm(event) : null;
    if (p) { setCursor(p); onCursor?.(p); }
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'move') {
      const raw = { dx: p.x - d.start.x, dy: p.y - d.start.y };
      if (!d.moved && Math.hypot(raw.dx, raw.dy) * scale < 3) return;
      d.moved = true;
      const snap = event.altKey ? { dx: raw.dx, dy: raw.dy, guides: [] } : snapMove(d.bounds, raw.dx, raw.dy, { grid: gridSize, snapGrid, snapObjects, threshold, page, objects: d.original, excludeIds: new Set(d.ids) });
      setGuides(snap.guides);
      onChange((t) => ({ ...t, objects: moveObjects(d.original, d.ids, snap.dx, snap.dy) }), 'move-' + d.ids.join(','));
    } else if (d.kind === 'resize') {
      d.moved = true;
      const box = resizeBox(d.box, d.handle, p.x - d.start.x, p.y - d.start.y, { keepRatio: event.shiftKey, grid: gridSize, snapGrid: snapGrid && !event.altKey, min: 0.3 });
      onChange((t) => ({ ...t, objects: t.objects.map((o) => (o.id === d.id ? { ...o, ...box } : o)) }), 'resize-' + d.id);
    } else if (d.kind === 'rotate') {
      d.moved = true;
      const angle = rotationFrom(d.center, p, event.shiftKey);
      onChange((t) => ({ ...t, objects: t.objects.map((o) => (o.id === d.id ? { ...o, rotation: angle } : o)) }), 'rotate-' + d.id);
    } else if (d.kind === 'marquee') {
      setMarquee({ x1: d.start.x, y1: d.start.y, x2: p.x, y2: p.y });
    }
  }

  function onPointerUp(event) {
    const d = dragRef.current;
    dragRef.current = null;
    setGuides([]);
    try { paperRef.current?.parentElement.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
    if (!d) return;
    if (d.kind === 'marquee') {
      const p = toMm(event);
      const ids = hitMarquee(objects, { x1: d.start.x, y1: d.start.y, x2: p.x, y2: p.y });
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) * scale > 3) onSelect(expandGroups(objects, d.additive ? [...new Set([...selection, ...ids])] : ids));
      setMarquee(null);
      return;
    }
    if (d.moved) onEndChange();
  }

  function onWheel(event) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    onZoom((z) => Math.max(0.25, Math.min(16, Math.round(z * (event.deltaY < 0 ? 1.15 : 1 / 1.15) * 100) / 100)));
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  function onDrop(event) {
    const name = event.dataTransfer.getData('application/x-els-field');
    const tool = event.dataTransfer.getData('application/x-els-tool');
    if (!name && !tool) return;
    event.preventDefault();
    const p = toMm(event);
    onDropField?.({ field: name, tool, x: Math.max(0, Math.round(p.x * 2) / 2), y: Math.max(0, Math.round(p.y * 2) / 2) });
  }

  const paperStyle = { width: page.width * scale, height: page.height * scale, left: paperOffset.x, top: paperOffset.y };
  const gridStyle = showGrid ? { backgroundSize: (gridSize * scale) + 'px ' + (gridSize * scale) + 'px' } : {};
  const contentW = paperOffset.x * 2 + page.width * scale;
  const contentH = paperOffset.y * 2 + page.height * scale;

  return <div className="canvas-shell">
    <div className="ruler-corner" />
    <Ruler orientation="h" lengthMm={Math.ceil(page.width)} zoom={zoom} offset={paperOffset.x - (scrollRef.current?.scrollLeft || 0)} cursor={cursor?.x} />
    <Ruler orientation="v" lengthMm={Math.ceil(page.height)} zoom={zoom} offset={paperOffset.y - (scrollRef.current?.scrollTop || 0)} cursor={cursor?.y} />
    <div className="canvas-scroll" ref={scrollRef} onScroll={() => setCursor((c) => (c ? { ...c } : c))}
      onDragOver={(e) => { if ([...e.dataTransfer.types].some((t) => t.startsWith('application/x-els'))) e.preventDefault(); }} onDrop={onDrop}
      onContextMenu={(e) => { if (onContextMenu) { e.preventDefault(); onContextMenu(e); } }} data-testid="canvas">
      <div className="canvas-content" style={{ width: contentW, height: contentH }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onPointerLeave={() => { setCursor(null); onCursor?.(null); }}
        onDoubleClick={(e) => { if (e.target.closest('[data-inline-editor]')) return; const hit = e.target.closest('[data-hit]'); if (hit) beginEdit(hit.dataset.hit); }}>
        <div className={'canvas-paper' + (showGrid ? ' grid' : '')} ref={paperRef} style={{ ...paperStyle, ...gridStyle, borderRadius: page.cornerRadius * scale }} data-testid="canvas-paper">
          <style>{LABEL_CSS}</style>
          <div className="canvas-render" style={{ transform: 'scale(' + zoom + ')' }} dangerouslySetInnerHTML={{ __html: html }} />
          <div className="canvas-overlay">
            {objects.map((o) => {
              if (o.hidden) return null;
              const isSelected = selection.includes(o.id);
              const minPx = 6;
              const w = Math.max(o.width * scale, minPx); const h = Math.max(o.height * scale, minPx);
              const style = {
                left: o.x * scale - (w - o.width * scale) / 2, top: o.y * scale - (h - o.height * scale) / 2, width: w, height: h,
                transform: o.rotation ? 'rotate(' + o.rotation + 'deg)' : undefined
              };
              return <div key={o.id} className={'hit' + (isSelected ? ' selected' : '') + (o.locked ? ' locked' : '') + (clipped.has(o.id) ? ' clipped' : '')}
                data-hit={o.id} style={style} title={(o.name || o.type) + (clipped.has(o.id) ? ' — text does not fit' : '') + (o.locked ? ' (locked)' : '')} data-testid={'object-' + (o.name || o.type)}>
                {inlineEdit?.id === o.id && <div className="canvas-inline-editor" data-inline-editor data-testid="canvas-inline-editor" onDoubleClick={(e) => e.stopPropagation()}>
                  <textarea ref={inlineRef} rows={3} value={inlineEdit.text} dir="auto" aria-label="Edit text directly on the label"
                    data-testid="canvas-inline-input" maxLength={5000}
                    onChange={(e) => setInlineEdit((draft) => draft && { ...draft, text: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); finishEdit(false); } else if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); finishEdit(true); } }}
                    onBlur={(e) => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) finishEdit(true); }} />
                  <div className="canvas-inline-buttons">
                    <button type="button" onClick={() => finishEdit(true)} data-testid="canvas-inline-save">Save</button>
                    <button type="button" onClick={() => finishEdit(false)} data-testid="canvas-inline-cancel">Cancel</button>
                  </div>
                </div>}
                {isSelected && o.type === 'text' && inlineEdit?.id !== o.id && <button type="button"
                  className="canvas-edit-trigger" title="Edit text or choose an Excel column"
                  onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onEditText?.(o.id); }}
                  data-testid={'canvas-edit-' + o.id}>Edit</button>}
                {isSelected && single && !o.locked && <>
                  {HANDLES.map((hd) => <span key={hd} className={'handle handle-' + hd} data-handle={hd} />)}
                  <span className="handle handle-rotate" data-handle="rotate" title="Rotate (Shift: free angle)" />
                </>}
              </div>;
            })}
            {guides.map((g, i) => <div key={i} className={'guide guide-' + g.axis} style={g.axis === 'x' ? { left: g.at * scale } : { top: g.at * scale }} />)}
            {marquee && <div className="marquee" style={{
              left: Math.min(marquee.x1, marquee.x2) * scale, top: Math.min(marquee.y1, marquee.y2) * scale,
              width: Math.abs(marquee.x2 - marquee.x1) * scale, height: Math.abs(marquee.y2 - marquee.y1) * scale
            }} />}
          </div>
        </div>
      </div>
    </div>
  </div>;
}
