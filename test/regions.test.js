import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedComponents, mergeRegions } from '../src/regions.js';

test('finds deterministic 8-connected components', () => {
  const w = 8, h = 5;
  const m = new Uint8Array(w * h);
  [[1,1],[2,1],[2,2],[6,3],[7,4]].forEach(([x,y]) => m[y*w+x] = 1);
  assert.deepEqual(connectedComponents(m, w, h), [
    { x: 1, y: 1, w: 2, h: 2, px: 3 },
    { x: 6, y: 3, w: 2, h: 2, px: 2 }
  ]);
});

test('merges nearby components and preserves changed-pixel count', () => {
  const input = [
    {x:0,y:0,w:2,h:2,px:4},
    {x:4,y:0,w:2,h:2,px:4},
    {x:20,y:20,w:1,h:1,px:1}
  ];
  assert.deepEqual(mergeRegions(input, 2), [
    {x:0,y:0,w:6,h:2,px:8},
    {x:20,y:20,w:1,h:1,px:1}
  ]);
});
