import test from 'node:test';
import assert from 'node:assert/strict';
import { snapMove, moveObjects, resizeBox, rotationFrom, alignObjects, distributeObjects, sameSize, reorder, hitMarquee, expandGroups, boundsOf } from '../../src/ui/geometry.js';

const page = { width: 50, height: 30 };
const objs = [
  { id: 'a', x: 2, y: 3, width: 20, height: 5 },
  { id: 'b', x: 30, y: 10, width: 10, height: 4 },
  { id: 'c', x: 5, y: 20, width: 8, height: 8, locked: true },
  { id: 'd', x: 40, y: 22, width: 6, height: 3, groupId: 'g' },
  { id: 'e', x: 44, y: 26, width: 4, height: 2, groupId: 'g' }
];

test('dragging moves selected, unlocked objects by exact millimetres', () => {
  const moved = moveObjects(objs, ['a', 'c'], 1.25, -0.5);
  assert.deepEqual([moved[0].x, moved[0].y], [3.25, 2.5]);
  assert.deepEqual([moved[2].x, moved[2].y], [5, 20], 'locked object stays');
});

test('snapping to grid and to other objects/label edges', () => {
  const b = boundsOf([objs[0]]);
  const grid = snapMove(b, 0.37, 0.81, { grid: 1, snapGrid: true, snapObjects: false, threshold: 0.5, page, objects: objs });
  assert.deepEqual([grid.dx, grid.dy], [0, 1]);
  const toEdge = snapMove(b, 7.8, 0, { grid: 0, snapGrid: false, snapObjects: true, threshold: 0.5, page, objects: objs, excludeIds: new Set(['a']) });
  assert.equal(toEdge.dx, 8, 'right edge (22+7.8=29.8) snaps to b.x = 30');
  assert.deepEqual(toEdge.guides, [{ axis: 'x', at: 30 }]);
  const centre = snapMove(b, 12.9, 0, { grid: 0, snapGrid: false, snapObjects: true, threshold: 0.3, page, objects: [], excludeIds: new Set(['a']) });
  assert.equal(centre.dx, 13, 'centre 12+12.9 snaps to label centre 25');
});

test('resizing from every handle with minimum size, grid and aspect ratio', () => {
  const box = { x: 10, y: 10, width: 20, height: 10 };
  assert.deepEqual(resizeBox(box, 'se', 5, 2), { x: 10, y: 10, width: 25, height: 12 });
  assert.deepEqual(resizeBox(box, 'nw', 2, 3), { x: 12, y: 13, width: 18, height: 7 });
  assert.deepEqual(resizeBox(box, 'w', 25, 0, { min: 1 }), { x: 29, y: 10, width: 1, height: 10 });
  assert.deepEqual(resizeBox(box, 'e', 0.4, 0, { grid: 1, snapGrid: true }), { x: 10, y: 10, width: 20, height: 10 });
  assert.deepEqual(resizeBox(box, 'se', 10, 0, { keepRatio: true }), { x: 10, y: 10, width: 30, height: 15 });
  assert.deepEqual(resizeBox(box, 'n', 0, -4), { x: 10, y: 6, width: 20, height: 14 });
});

test('rotation snaps to 15° unless free', () => {
  assert.equal(rotationFrom({ x: 0, y: 0 }, { x: 10, y: 0 }), 90);
  assert.equal(rotationFrom({ x: 0, y: 0 }, { x: 0, y: 10 }), 180);
  assert.equal(rotationFrom({ x: 0, y: 0 }, { x: 10, y: -9 }), 45);
  assert.equal(rotationFrom({ x: 0, y: 0 }, { x: 10, y: -9 }, true), 48);
});

test('align to selection bounds, or to the label for a single object', () => {
  const left = alignObjects(objs, ['a', 'b'], 'left', page);
  assert.equal(left[1].x, 2);
  const centred = alignObjects(objs, ['b'], 'hcenter', page);
  assert.equal(centred[1].x, 20);
  const bottom = alignObjects(objs, ['a', 'b'], 'bottom', page);
  assert.equal(bottom[0].y, 9);
  const lockedIgnored = alignObjects(objs, ['a', 'c'], 'right', page);
  assert.equal(lockedIgnored[2].x, 5);
});

test('distribute, same size and z-order', () => {
  const list = [{ id: '1', x: 0, y: 0, width: 4, height: 1 }, { id: '2', x: 5, y: 0, width: 4, height: 1 }, { id: '3', x: 20, y: 0, width: 4, height: 1 }];
  const d = distributeObjects(list, ['1', '2', '3'], 'x');
  assert.deepEqual(d.map((o) => o.x), [0, 10, 20]);
  const s = sameSize(objs, ['a', 'b'], 'height');
  assert.equal(s[1].height, 5);
  assert.deepEqual(reorder(objs, ['a'], 'front').map((o) => o.id), ['b', 'c', 'd', 'e', 'a']);
  assert.deepEqual(reorder(objs, ['e'], 'back').map((o) => o.id), ['e', 'a', 'b', 'c', 'd']);
  assert.deepEqual(reorder(objs, ['b'], 'forward').map((o) => o.id), ['a', 'c', 'b', 'd', 'e']);
  assert.deepEqual(reorder(objs, ['b'], 'backward').map((o) => o.id), ['b', 'a', 'c', 'd', 'e']);
});

test('marquee selection and group expansion', () => {
  assert.deepEqual(hitMarquee(objs, { x1: 0, y1: 0, x2: 25, y2: 9 }), ['a']);
  assert.deepEqual(hitMarquee(objs, { x1: 50, y1: 30, x2: 35, y2: 21 }).sort(), ['d', 'e']);
  assert.deepEqual(expandGroups(objs, ['d']).sort(), ['d', 'e']);
});
