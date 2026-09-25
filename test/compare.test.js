import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { comparePngFiles } from '../src/compare.js';

function image(file, rect = null) {
  const p = new PNG({width: 20, height: 10});
  for (let i=0;i<p.data.length;i+=4) { p.data[i]=255;p.data[i+1]=255;p.data[i+2]=255;p.data[i+3]=255; }
  if (rect) for (let y=rect.y;y<rect.y+rect.h;y++) for (let x=rect.x;x<rect.x+rect.w;x++) {
    const i=(y*20+x)*4; p.data[i]=0;p.data[i+1]=0;p.data[i+2]=0;p.data[i+3]=255;
  }
  fs.writeFileSync(file, PNG.sync.write(p));
}

test('reports pixels, region and writes diff png', () => {
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'avd-'));
  const expected=path.join(d,'a.png'), actual=path.join(d,'b.png'), diff=path.join(d,'diff.png');
  image(expected); image(actual,{x:5,y:2,w:3,h:2});
  const r=comparePngFiles({expected,actual,diffPng:diff,minRegionPixels:1,mergeGap:0,regionPadding:0});
  assert.equal(r.diffPixels,6);
  assert.equal(r.regions.length,1);
  assert.deepEqual({x:r.regions[0].x,y:r.regions[0].y,w:r.regions[0].w,h:r.regions[0].h,px:r.regions[0].px},{x:5,y:2,w:3,h:2,px:6});
  assert.equal(fs.existsSync(diff),true);
});
