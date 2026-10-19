// Pure geometry for the designer: snapping, moving, resizing, aligning and distributing (all in mm).

export const MM_TO_PX = 96 / 25.4;
export const round = (n, step = 0.05) => Math.round(n / step) * step;
const fix = (n) => Math.round(n * 1000) / 1000;

export function boundsOf(objects) {
  if (!objects.length) return null;
  const left = Math.min(...objects.map((o) => o.x));
  const top = Math.min(...objects.map((o) => o.y));
  const right = Math.max(...objects.map((o) => o.x + o.width));
  const bottom = Math.max(...objects.map((o) => o.y + o.height));
  return { x: left, y: top, width: right - left, height: bottom - top, right, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

/** Snap targets: label edges/centre plus edges/centres of objects that are not moving. */
export function snapTargets(page, objects, excludeIds) {
  const xs = [0, page.width / 2, page.width];
  const ys = [0, page.height / 2, page.height];
  for (const o of objects) {
    if (excludeIds.has(o.id) || o.hidden) continue;
    xs.push(o.x, o.x + o.width / 2, o.x + o.width);
    ys.push(o.y, o.y + o.height / 2, o.y + o.height);
  }
  return { xs, ys };
}

function nearest(values, candidates, threshold) {
  let best = null;
  for (const value of values) {
    for (const c of candidates) {
      const d = c - value;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: c };
    }
  }
  return best;
}

/**
 * Compute the move delta for dragging a selection.
 * opts: { grid: mm|0, snapGrid, snapObjects, threshold (mm), page, objects }
 * Returns { dx, dy, guides: [{ axis:'x'|'y', at }] }
 */
export function snapMove(startBounds, rawDx, rawDy, opts) {
  let dx = rawDx; let dy = rawDy;
  const guides = [];
  const b = { x: startBounds.x + dx, y: startBounds.y + dy, w: startBounds.width, h: startBounds.height };
  let snappedX = false; let snappedY = false;
  if (opts.snapObjects) {
    const { xs, ys } = snapTargets(opts.page, opts.objects, opts.excludeIds || new Set());
    const sx = nearest([b.x, b.x + b.w / 2, b.x + b.w], xs, opts.threshold);
    const sy = nearest([b.y, b.y + b.h / 2, b.y + b.h], ys, opts.threshold);
    if (sx) { dx += sx.delta; guides.push({ axis: 'x', at: sx.at }); snappedX = true; }
    if (sy) { dy += sy.delta; guides.push({ axis: 'y', at: sy.at }); snappedY = true; }
  }
  if (opts.snapGrid && opts.grid > 0) {
    if (!snappedX) dx = round(startBounds.x + dx, opts.grid) - startBounds.x;
    if (!snappedY) dy = round(startBounds.y + dy, opts.grid) - startBounds.y;
  }
  return { dx: fix(dx), dy: fix(dy), guides };
}

/** Apply a move to objects (locked objects stay). */
export function moveObjects(objects, ids, dx, dy) {
  const set = new Set(ids);
  return objects.map((o) => (set.has(o.id) && !o.locked ? { ...o, x: fix(o.x + dx), y: fix(o.y + dy) } : o));
}

/**
 * Resize a box from a handle ('n','s','e','w','ne','nw','se','sw') by a delta in mm.
 * opts: { min, keepRatio, grid, snapGrid }
 */
export function resizeBox(box, handle, dx, dy, opts = {}) {
  const min = opts.min ?? 0.5;
  let { x, y, width, height } = box;
  const ratio = box.width / Math.max(box.height, 0.0001);
  const snap = (v) => (opts.snapGrid && opts.grid > 0 ? round(v, opts.grid) : v);
  if (handle.includes('e')) width = Math.max(min, snap(box.x + box.width + dx) - box.x);
  if (handle.includes('s')) height = Math.max(min, snap(box.y + box.height + dy) - box.y);
  if (handle.includes('w')) { const left = Math.min(snap(box.x + dx), box.x + box.width - min); width = box.x + box.width - left; x = left; }
  if (handle.includes('n')) { const top = Math.min(snap(box.y + dy), box.y + box.height - min); height = box.y + box.height - top; y = top; }
  if (opts.keepRatio && handle.length === 2) {
    if (width / ratio > height) height = width / ratio; else width = height * ratio;
    if (handle.includes('w')) x = box.x + box.width - width;
    if (handle.includes('n')) y = box.y + box.height - height;
  }
  return { x: fix(x), y: fix(y), width: fix(width), height: fix(height) };
}

/** Rotation angle (degrees, snapped to 15° unless free) from the object centre to the pointer. */
export function rotationFrom(center, pointer, free = false) {
  const angle = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI + 90;
  const normalized = ((angle % 360) + 360) % 360;
  return free ? Math.round(normalized) : (Math.round(normalized / 15) * 15) % 360;
}

/**
 * Align objects. mode: left|hcenter|right|top|vcenter|bottom.
 * With one object (or reference 'label') it aligns to the label; otherwise to the selection bounds.
 */
export function alignObjects(objects, ids, mode, page, reference = 'selection') {
  const targets = objects.filter((o) => ids.includes(o.id) && !o.locked);
  if (!targets.length) return objects;
  const ref = reference === 'label' || targets.length === 1
    ? { x: 0, y: 0, right: page.width, bottom: page.height, cx: page.width / 2, cy: page.height / 2 }
    : boundsOf(targets);
  return objects.map((o) => {
    if (!targets.includes(o)) return o;
    switch (mode) {
      case 'left': return { ...o, x: fix(ref.x) };
      case 'hcenter': return { ...o, x: fix(ref.cx - o.width / 2) };
      case 'right': return { ...o, x: fix(ref.right - o.width) };
      case 'top': return { ...o, y: fix(ref.y) };
      case 'vcenter': return { ...o, y: fix(ref.cy - o.height / 2) };
      case 'bottom': return { ...o, y: fix(ref.bottom - o.height) };
      default: return o;
    }
  });
}

/** Distribute 3+ objects so the gaps between them are equal. axis: 'x'|'y' */
export function distributeObjects(objects, ids, axis) {
  const targets = objects.filter((o) => ids.includes(o.id) && !o.locked);
  if (targets.length < 3) return objects;
  const pos = axis === 'x' ? 'x' : 'y'; const size = axis === 'x' ? 'width' : 'height';
  const sorted = [...targets].sort((a, b) => a[pos] - b[pos]);
  const start = sorted[0][pos];
  const end = Math.max(...sorted.map((o) => o[pos] + o[size]));
  const gap = (end - start - sorted.reduce((s, o) => s + o[size], 0)) / (sorted.length - 1);
  const placed = new Map();
  let cursor = start;
  for (const o of sorted) { placed.set(o.id, fix(cursor)); cursor += o[size] + gap; }
  return objects.map((o) => (placed.has(o.id) ? { ...o, [pos]: placed.get(o.id) } : o));
}

export function sameSize(objects, ids, dimension) {
  const targets = objects.filter((o) => ids.includes(o.id) && !o.locked);
  if (targets.length < 2) return objects;
  const first = objects.find((o) => o.id === ids[0]) || targets[0];
  return objects.map((o) => (targets.includes(o) ? { ...o, ...(dimension !== 'height' ? { width: first.width } : {}), ...(dimension !== 'width' ? { height: first.height } : {}) } : o));
}

/** Z-order: front|back|forward|backward */
export function reorder(objects, ids, mode) {
  const set = new Set(ids);
  const moving = objects.filter((o) => set.has(o.id));
  const rest = objects.filter((o) => !set.has(o.id));
  if (mode === 'front') return [...rest, ...moving];
  if (mode === 'back') return [...moving, ...rest];
  const list = [...objects];
  if (mode === 'forward') {
    for (let i = list.length - 2; i >= 0; i--) if (set.has(list[i].id) && !set.has(list[i + 1].id)) [list[i], list[i + 1]] = [list[i + 1], list[i]];
  } else {
    for (let i = 1; i < list.length; i++) if (set.has(list[i].id) && !set.has(list[i - 1].id)) [list[i], list[i - 1]] = [list[i - 1], list[i]];
  }
  return list;
}

/** Objects whose boxes intersect a marquee rectangle (mm). */
export function hitMarquee(objects, rect) {
  const r = { x1: Math.min(rect.x1, rect.x2), y1: Math.min(rect.y1, rect.y2), x2: Math.max(rect.x1, rect.x2), y2: Math.max(rect.y1, rect.y2) };
  return objects.filter((o) => !o.hidden && o.x < r.x2 && o.x + o.width > r.x1 && o.y < r.y2 && o.y + Math.max(o.height, 0.3) > r.y1).map((o) => o.id);
}

/** Expand a selection to whole groups. */
export function expandGroups(objects, ids) {
  const groups = new Set(objects.filter((o) => ids.includes(o.id) && o.groupId).map((o) => o.groupId));
  if (!groups.size) return ids;
  return [...new Set([...ids, ...objects.filter((o) => o.groupId && groups.has(o.groupId)).map((o) => o.id)])];
}
