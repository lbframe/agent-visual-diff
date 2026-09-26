import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { buildIgnoreMask, clampRegions, paintIgnoredOverlay, parseIgnoreSpec, readMaskFile } from '../src/mask.js';
import { comparePngFiles } from '../src/compare.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avd-mask-'));
}

/** 20x10 image, white, with a black rect painted on it. */
function image(file, rect = null) {
  const p = new PNG({ width: 20, height: 10 });
  for (let i = 0; i < p.data.length; i += 4) { p.data[i]=255;p.data[i+1]=255;p.data[i+2]=255;p.data[i+3]=255; }
  if (rect) for (let y=rect.y;y<rect.y+rect.h;y++) for (let x=rect.x;x<rect.x+rect.w;x++) {
    const i=(y*20+x)*4; p.data[i]=0;p.data[i+1]=0;p.data[i+2]=0;p.data[i+3]=255;
  }
  fs.writeFileSync(file, PNG.sync.write(p));
}

test('readMaskFile accepts the documented format and rejects malformed input', () => {
  const d = tmp();
  const file = path.join(d, 'mask.json');

  fs.writeFileSync(file, JSON.stringify({ regions: [{ name: 'testimonial-carousel', x: 120, y: 2100, w: 1200, h: 600 }] }));
  assert.deepEqual(readMaskFile(file), [{ name: 'testimonial-carousel', x: 120, y: 2100, w: 1200, h: 600 }]);

  fs.writeFileSync(file, JSON.stringify({ regions: [{ x: 0, y: 0, w: 10, h: 10 }] }));
  assert.deepEqual(readMaskFile(file), [{ x: 0, y: 0, w: 10, h: 10 }]);

  const bad = [
    ['not json at all', /invalid JSON/],
    [JSON.stringify([{ x: 0, y: 0, w: 1, h: 1 }]), /must contain an object with a "regions" array/],
    [JSON.stringify({ regions: {} }), /must contain a "regions" array/],
    [JSON.stringify({ regions: [{ x: 0, y: 0, w: 1, h: 1, witdh: 2 }] }), /unknown key "witdh"/],
    [JSON.stringify({ regions: [{ x: 0, y: 0, w: 1.5, h: 1 }] }), /"w" must be an integer/],
    [JSON.stringify({ regions: [{ x: 0, y: 0, w: 0, h: 1 }] }), /"w" and "h" must be > 0/],
    [JSON.stringify({ regions: [{ x: -1, y: 0, w: 1, h: 1 }] }), /"x" and "y" must be >= 0/],
    [JSON.stringify({ regions: [{ name: '', x: 0, y: 0, w: 1, h: 1 }] }), /"name" must be a non-empty string/]
  ];
  for (const [content, expected] of bad) {
    fs.writeFileSync(file, content);
    assert.throws(() => readMaskFile(file), expected, content);
  }

  assert.throws(() => readMaskFile(path.join(d, 'nope.json')), /cannot read mask file/);
});

test('parseIgnoreSpec reads x,y,w,h and rejects anything else', () => {
  assert.deepEqual(parseIgnoreSpec('120,2100,1200,600', 'inline-1'), { name: 'inline-1', x: 120, y: 2100, w: 1200, h: 600 });
  assert.deepEqual(parseIgnoreSpec(' 0 , 7200 , 1440 , 400 '), { name: undefined, x: 0, y: 7200, w: 1440, h: 400 });
  assert.throws(() => parseIgnoreSpec('1,2,3'), /--ignore expects "x,y,w,h"/);
  assert.throws(() => parseIgnoreSpec('1,2,3,4,5'), /--ignore expects "x,y,w,h"/);
  assert.throws(() => parseIgnoreSpec('a,2,3,4'), /"x" must be an integer/);
  assert.throws(() => parseIgnoreSpec('1,2,3,0'), /"w" and "h" must be > 0/);
});

test('clampRegions trims to the viewport, names unnamed zones, rejects fully-outside zones', () => {
  assert.deepEqual(clampRegions([{ name: 'a', x: 18, y: 8, w: 10, h: 10 }], 20, 10), [
    { name: 'a', x: 18, y: 8, w: 2, h: 2 }
  ]);
  assert.deepEqual(clampRegions([{ x: 0, y: 0, w: 4, h: 4 }], 20, 10), [
    { name: 'region-1', x: 0, y: 0, w: 4, h: 4 }
  ]);
  assert.throws(
    () => clampRegions([{ name: 'off', x: 0, y: 900, w: 10, h: 10 }], 20, 10),
    /regions\[0\] \("off"\) at 0,900 10x10 lies entirely outside the 20x10 viewport/
  );
});

test('the programmatic API holds regions to the same contract as a mask file', () => {
  const invalid = [
    ['negative x', { name: 'bad', x: -10, y: 0, w: 20, h: 100 }, /"x" and "y" must be >= 0, got x=-10 y=0/],
    ['negative y', { name: 'bad', x: 0, y: -5, w: 5, h: 5 }, /"x" and "y" must be >= 0, got x=0 y=-5/],
    ['negative w', { name: 'bad', x: 0, y: 0, w: -5, h: 5 }, /"w" and "h" must be > 0, got w=-5 h=5/],
    ['zero h', { name: 'bad', x: 0, y: 0, w: 5, h: 0 }, /"w" and "h" must be > 0, got w=5 h=0/],
    ['fractional x', { name: 'bad', x: 0.5, y: 0, w: 5, h: 5 }, /"x" must be an integer, got 0.5/],
    ['NaN w', { name: 'bad', x: 0, y: 0, w: NaN, h: 5 }, /"w" must be an integer, got null/],
    ['string coords', { name: 'bad', x: '0', y: 0, w: 5, h: 5 }, /"x" must be an integer, got "0"/],
    ['missing h', { name: 'bad', x: 0, y: 0, w: 5 }, /"h" must be an integer, got undefined/],
    ['empty name', { name: '', x: 0, y: 0, w: 2, h: 2 }, /"name" must be a non-empty string/],
    ['numeric name', { name: 123, x: 0, y: 0, w: 2, h: 2 }, /"name" must be a non-empty string/],
    ['unknown key', { name: 'k', x: 0, y: 0, w: 2, h: 2, colour: 'red' }, /unknown key "colour"/],
    ['not an object', 'nope', /must be an object with x, y, w, h/]
  ];

  const d = tmp();
  const expected = path.join(d, 'a.png');
  const actual = path.join(d, 'b.png');
  image(expected);
  image(actual, { x: 5, y: 2, w: 3, h: 2 });

  for (const key of ['mask', 'ignore']) {
    for (const [label, region, expectedError] of invalid) {
      assert.throws(
        () => comparePngFiles({ expected, actual, [key]: [region] }),
        expectedError,
        `${key}: ${label}`
      );
    }
  }
});

test('a region that would rasterize into the previous scanline is rejected, not clamped', () => {
  const { mask } = buildIgnoreMask(clampRegions([{ x: 0, y: 0, w: 2, h: 2 }], 20, 10), 20, 10);
  assert.equal(mask[0], 1);

  assert.throws(
    () => clampRegions([{ name: 'bad', x: -3, y: 2, w: 5, h: 3 }], 20, 10),
    /"x" and "y" must be >= 0/
  );
});

test('no invalid region can produce an ignoredPixels/evaluatedPixels pair off the total', () => {
  const d = tmp();
  const expected = path.join(d, 'a.png');
  const actual = path.join(d, 'b.png');
  image(expected);
  image(actual, { x: 5, y: 2, w: 3, h: 2 });
  const totalPixels = 20 * 10;

  const bad = [
    { name: 'neg-x', x: -1, y: 0, w: 1, h: 1 },
    { name: 'neg-x-wrap', x: -3, y: 2, w: 5, h: 3 },
    { name: 'neg-y', x: 0, y: -5, w: 5, h: 5 },
    { name: 'neg-w', x: 0, y: 0, w: -5, h: 5 },
    { name: 'frac', x: 0, y: 0, w: 2.5, h: 2 },
    { name: 'off-screen', x: 500, y: 500, w: 10, h: 10 }
  ];

  for (const region of bad) {
    assert.throws(() => comparePngFiles({ expected, actual, mask: [region] }), Error, JSON.stringify(region));
    assert.throws(() => comparePngFiles({ expected, actual, ignore: [region] }), Error, JSON.stringify(region));
  }

  const valid = comparePngFiles({ expected, actual, mask: [{ name: 'ok', x: 0, y: 0, w: 4, h: 4 }] });
  assert.equal(valid.ignoredPixels, 16);
  assert.equal(valid.evaluatedPixels, totalPixels - 16);
  assert.equal(valid.ignoredPixels + valid.evaluatedPixels, totalPixels);
});

test('buildIgnoreMask counts the union of overlapping regions once', () => {
  const { mask, ignoredPixels } = buildIgnoreMask([
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 5, y: 5, w: 10, h: 10 }
  ], 20, 20);
  assert.equal(ignoredPixels, 100 + 100 - 25);
  assert.equal(mask[0], 1);
  assert.equal(mask[5 * 20 + 5], 1);
  assert.equal(mask[7 * 20 + 7], 1);
  assert.equal(mask[18 * 20 + 18], 0);
});

test('paintIgnoredOverlay grays ignored pixels and leaves evaluated pixels untouched', () => {
  const data = Buffer.alloc(4 * 2 * 4);
  data.fill(255);
  const mask = new Uint8Array([0, 1]);
  paintIgnoredOverlay(data, mask, 4, 2);
  assert.deepEqual([...data.slice(0, 4)], [255, 255, 255, 255]);
  assert.deepEqual([...data.slice(4, 8)], [230, 230, 230, 255]);
});

test('masked pixels leave diffPixels, regions and the diffRatio denominator', () => {
  const d = tmp();
  const expected = path.join(d, 'a.png');
  const actual = path.join(d, 'b.png');
  image(expected);
  image(actual, { x: 5, y: 2, w: 3, h: 2 });

  const plain = comparePngFiles({ expected, actual, minRegionPixels: 1, mergeGap: 0, regionPadding: 0 });
  assert.equal(plain.diffPixels, 6);
  assert.equal(plain.evaluatedPixels, 200);
  assert.equal(plain.ignoredPixels, 0);
  assert.deepEqual(plain.ignoredRegions, []);
  assert.equal(plain.diffRatio, 0.03);

  const masked = comparePngFiles({
    expected, actual, minRegionPixels: 1, mergeGap: 0, regionPadding: 0,
    ignore: [{ name: 'inline-1', x: 5, y: 2, w: 3, h: 2 }]
  });
  assert.equal(masked.diffPixels, 0);
  assert.equal(masked.ignoredPixels, 6);
  assert.equal(masked.evaluatedPixels, 194);
  assert.equal(masked.regions.length, 0);
  assert.equal(masked.diffRatio, 0);
  assert.deepEqual(masked.ignoredRegions, [{ name: 'inline-1', x: 5, y: 2, w: 3, h: 2 }]);

  assert.throws(
    () => comparePngFiles({ expected, actual, mask: [{ name: 'all', x: 0, y: 0, w: 20, h: 10 }] }),
    /all 200 pixels are ignored: nothing left to compare/
  );
});

test('a real diff outside the mask survives a mask covering everything else', () => {
  const d = tmp();
  const expected = path.join(d, 'a.png');
  const actual = path.join(d, 'b.png');
  image(expected);
  image(actual, { x: 5, y: 2, w: 3, h: 2 });

  const r = comparePngFiles({
    expected, actual, minRegionPixels: 1, mergeGap: 0, regionPadding: 0,
    mask: [
      { name: 'noise-top', x: 0, y: 0, w: 20, h: 2 },
      { name: 'noise-bottom', x: 0, y: 4, w: 20, h: 6 }
    ]
  });
  assert.equal(r.diffPixels, 6);
  assert.equal(r.regions.length, 1);
  assert.deepEqual(
    { x: r.regions[0].x, y: r.regions[0].y, w: r.regions[0].w, h: r.regions[0].h },
    { x: 5, y: 2, w: 3, h: 2 }
  );
  assert.equal(r.evaluatedPixels, 20 * 2);
  assert.equal(r.ignoredPixels, 200 - 40);
});

test('mask file regions and inline --ignore combine in declaration order', () => {
  const d = tmp();
  const expected = path.join(d, 'a.png');
  const actual = path.join(d, 'b.png');
  image(expected);
  image(actual, { x: 5, y: 2, w: 3, h: 2 });

  const r = comparePngFiles({
    expected, actual,
    mask: [{ name: 'from-file', x: 0, y: 0, w: 20, h: 2 }],
    ignore: [{ name: 'inline-1', x: 0, y: 4, w: 20, h: 6 }]
  });
  assert.deepEqual(r.ignoredRegions.map(x => x.name), ['from-file', 'inline-1']);
  assert.equal(r.ignoredPixels, 40 + 120);
});

test('diffPixels is exactly the count pixelmatch reports when nothing is masked', () => {
  const d = tmp();
  const expected = path.join(d, 'a.png');
  const actual = path.join(d, 'b.png');
  image(expected);
  image(actual, { x: 1, y: 1, w: 4, h: 3 });

  const a = PNG.sync.read(fs.readFileSync(expected));
  const b = PNG.sync.read(fs.readFileSync(actual));
  const out = new PNG({ width: 20, height: 10 });
  const expectedPixels = pixelmatch(a.data, b.data, out.data, 20, 10, {
    threshold: 0.1, includeAA: false, diffMask: true, diffColor: [255, 0, 0], alpha: 1
  });

  const r = comparePngFiles({ expected, actual, minRegionPixels: 1, mergeGap: 0, regionPadding: 0 });
  assert.equal(r.diffPixels, expectedPixels);
});

test('identical inputs produce byte-identical reports', () => {
  const d = tmp();
  const expected = path.join(d, 'a.png');
  const actual = path.join(d, 'b.png');
  image(expected);
  image(actual, { x: 5, y: 2, w: 3, h: 2 });

  const opts = {
    expected, actual, minRegionPixels: 1,
    mask: [{ name: 'carousel', x: 0, y: 8, w: 20, h: 2 }],
    ignore: [{ name: 'inline-1', x: 0, y: 0, w: 20, h: 1 }]
  };
  assert.equal(JSON.stringify(comparePngFiles(opts)), JSON.stringify(comparePngFiles(opts)));
});
