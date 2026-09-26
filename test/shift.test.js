import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { comparePngFiles } from '../src/compare.js';
import { candidateBands, detectPositionShifts, rowActivity } from '../src/shift.js';
import { buildIgnoreMask } from '../src/mask.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src', 'cli.js');

let scratch;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-shift-'));
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/**
 * Deterministic integer generator, so every fixture in this file is byte-stable
 * across machines and Node versions.
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(width, height) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = 255;
    png.data[i * 4 + 1] = 255;
    png.data[i * 4 + 2] = 255;
    png.data[i * 4 + 3] = 255;
  }
  return png;
}

function rect(png, x0, y0, w, h, color) {
  for (let y = Math.max(0, y0); y < Math.min(png.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(png.width, x0 + w); x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = color[0];
      png.data[i + 1] = color[1];
      png.data[i + 2] = color[2];
      png.data[i + 3] = 255;
    }
  }
}

/**
 * Content built to constrain both axes: bars of varying height pin a vertical
 * offset, irregular ticks inside them pin a horizontal one. The ticks are
 * irregular on purpose, since an evenly spaced pattern also matches at every
 * multiple of its period and would hand out a wrong offset that scores
 * perfectly.
 */
function blocks(png, originY, height, seed) {
  const random = rng(seed);
  let y = originY;
  let index = 0;
  while (y < originY + height - 20) {
    const barHeight = 6 + Math.floor(random() * 8);
    const barWidth = Math.floor(png.width * (0.4 + random() * 0.5));
    const shade = index % 3;
    const color = shade === 0 ? [20, 20, 20] : shade === 1 ? [190, 30, 30] : [30, 30, 150];
    const x = 10 + Math.floor(random() * 6);
    rect(png, x, y, barWidth, barHeight, color);
    let tick = x;
    while (tick < x + barWidth) {
      const tickWidth = 2 + Math.floor(random() * 6);
      rect(png, tick, y, Math.min(tickWidth, 3), barHeight, shade === 1 ? [250, 215, 215] : [228, 228, 228]);
      tick += tickWidth;
    }
    y += barHeight + 5;
    index++;
  }
}

function reference(width, height, seed) {
  const png = canvas(width, height);
  blocks(png, 20, height - 40, seed);
  return png;
}

/** A page whose content lives only in [top, top + span), so masks can be aimed. */
function bandedReference(width, height, top, span, seed) {
  const png = canvas(width, height);
  blocks(png, top, span, seed);
  return png;
}

function shifted(source, dx, dy) {
  const out = canvas(source.width, source.height);
  for (let y = 0; y < source.height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= source.height) continue;
    for (let x = 0; x < source.width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= source.width) continue;
      const from = (sy * source.width + sx) * 4;
      const to = (y * source.width + x) * 4;
      out.data[to] = source.data[from];
      out.data[to + 1] = source.data[from + 1];
      out.data[to + 2] = source.data[from + 2];
      out.data[to + 3] = 255;
    }
  }
  return out;
}

function writePair(name, a, b) {
  const expected = path.join(scratch, `${name}-reference.png`);
  const actual = path.join(scratch, `${name}-actual.png`);
  fs.writeFileSync(expected, PNG.sync.write(a));
  fs.writeFileSync(actual, PNG.sync.write(b));
  return { expected, actual };
}

function compare(name, a, b, options = {}) {
  const files = writePair(name, a, b);
  return comparePngFiles({ ...files, detectShifts: true, ...options });
}

/** A grid of near-identical cards: the repeated-pattern trap. */
function repeatedCards(width, height, seed) {
  const png = canvas(width, height);
  const random = rng(seed);
  const cols = 3;
  const rows = 4;
  const cardW = Math.floor((width - 20) / cols);
  const cardH = Math.floor((height - 20) / rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = 10 + c * cardW;
      const y = 10 + r * cardH;
      rect(png, x, y, cardW - 8, cardH - 8, [246, 246, 246]);
      rect(png, x, y, cardW - 8, 3, [40, 40, 40]);
      const marker = (r * cols + c) % 4 === 0 ? 16 : 7;
      rect(png, x + 6, y + 12 + Math.floor(random() * 5), cardW - 30, marker, [80, 80, 80]);
      rect(png, x + 6, y + 40, cardW - 40, 5, [150, 150, 150]);
    }
  }
  return png;
}

test('a pure vertical shift is reported with its delta and nothing else', () => {
  const a = reference(240, 640, 11);
  const report = compare('vertical-20', a, shifted(a, 0, 20));

  assert.equal(report.shifts.length, 1);
  const [shift] = report.shifts;
  assert.equal(shift.type, 'position-shift');
  assert.equal(shift.deltaY, 20);
  assert.equal(shift.deltaX, 0);
  assert.ok(shift.confidence > 0 && shift.confidence <= 1);
  assert.equal(shift.w, 240);
  // The region still reports as a diff region too: a shift is extra evidence,
  // not a replacement for the pixels that actually differ.
  assert.ok(report.regions.length > 0);
});

test('a large vertical shift is reported with its delta', () => {
  const a = reference(240, 900, 22);
  const report = compare('vertical-100', a, shifted(a, 0, 100));

  assert.equal(report.shifts.length, 1);
  assert.equal(report.shifts[0].deltaY, 100);
  assert.equal(report.shifts[0].deltaX, 0);
});

test('a purely horizontal shift is reported on the horizontal axis', () => {
  const a = reference(360, 640, 33);
  const report = compare('horizontal-32', a, shifted(a, 32, 0));

  assert.equal(report.shifts.length, 1);
  assert.equal(report.shifts[0].deltaX, 32);
  assert.equal(report.shifts[0].deltaY, 0);
});

test('a diagonal shift is reported as one translation, not one axis at a time', () => {
  const a = reference(360, 640, 44);
  const report = compare('diagonal', a, shifted(a, 15, -25));

  assert.equal(report.shifts.length, 1);
  assert.equal(report.shifts[0].deltaX, 15);
  assert.equal(report.shifts[0].deltaY, -25);
});

test('content that changed in place is never called a position shift', () => {
  const report = compare('content-change', reference(240, 640, 55), reference(240, 640, 66));

  assert.ok(report.diffPixels > 0, 'the fixture must actually differ');
  assert.deepEqual(report.shifts, []);
});

test('content that is both moved and materially changed is not called a shift', () => {
  const a = reference(240, 640, 77);
  const b = shifted(a, 0, 40);
  rect(b, 20, 80, 200, 160, [255, 0, 255]);
  rect(b, 20, 320, 200, 160, [0, 190, 190]);
  rect(b, 20, 520, 200, 100, [255, 150, 0]);

  const report = compare('shifted-and-modified', a, b);

  assert.ok(report.diffPixels > 0);
  assert.deepEqual(report.shifts, []);
});

test('a repeated card grid produces no confident false shift', () => {
  const a = repeatedCards(360, 640, 88);
  const b = canvas(360, 640);
  b.data.set(a.data);
  rect(b, 150, 300, 60, 50, [0, 0, 0]);

  const report = compare('repeated-cards', a, b);

  assert.ok(report.diffPixels > 0);
  assert.deepEqual(report.shifts, []);
});

test('a real shift is still reported when part of the region is ignored', () => {
  const a = reference(240, 640, 111);
  const b = shifted(a, 0, 30);
  const mask = [{ name: 'dynamic-strip', x: 0, y: 0, w: 240, h: 100 }];

  const report = compare('mask-intersection', a, b, { mask });

  assert.equal(report.ignoredPixels, 240 * 100);
  assert.equal(report.shifts.length, 1);
  assert.equal(report.shifts[0].deltaY, 30);
});

test('ignored pixels cannot open a shift candidate', () => {
  // Content occupies y=100..300. Shifting it by 40 puts the whole difference
  // inside y=100..340, so ignoring y=0..500 leaves only blank, identical rows
  // evaluated: there is no difference left to build a candidate from.
  const a = bandedReference(240, 640, 100, 200, 121);
  const b = shifted(a, 0, 40);

  const report = compare('mask-eats-candidate', a, b, {
    mask: [{ name: 'covers-the-difference', x: 0, y: 0, w: 240, h: 500 }]
  });

  assert.equal(report.ignoredPixels, 240 * 500);
  assert.ok(report.evaluatedPixels > 0, 'the fixture must leave something evaluated');
  assert.equal(report.diffPixels, 0, 'the difference is entirely inside the mask');
  assert.deepEqual(report.shifts, []);
});

test('a translation justified only by ignored pixels is rejected', () => {
  // The actual image really does hold the reference content translated down by
  // 140px, so an unmasked run must find it.
  const a = bandedReference(240, 640, 100, 400, 131);
  const b = shifted(a, 0, 140);

  const plain = compare('residue-plain', a, b);
  assert.equal(plain.shifts.length, 1, 'the fixture is a pure translation');
  assert.equal(plain.shifts[0].deltaY, 140);

  // Ignoring exactly where that content now sits leaves the reference pixels
  // evaluated but every candidate destination ignored. A scorer that checked
  // the mask only at the source would still match them and confidently report
  // a 140px shift built entirely out of ignored pixels.
  const masked = compare('residue-masked', a, b, {
    mask: [{ name: 'destination-only', x: 0, y: 240, w: 240, h: 400 }]
  });

  assert.equal(masked.ignoredPixels, 240 * 400);
  assert.ok(masked.evaluatedPixels > 0, 'the source side is still evaluated');
  assert.deepEqual(masked.shifts, [], 'ignored pixels must not create a shift');
});

test('repeated runs produce byte-identical JSON', () => {
  const a = reference(240, 640, 141);
  const b = shifted(a, 0, 25);
  const files = writePair('determinism', a, b);

  const options = { ...files, detectShifts: true, minRegionPixels: 20 };
  const first = JSON.stringify(comparePngFiles(options));
  const second = JSON.stringify(comparePngFiles(options));
  const third = JSON.stringify(comparePngFiles(options));

  assert.equal(first, second);
  assert.equal(first, third);
  assert.ok(JSON.parse(first).shifts.length > 0, 'the fixture must produce a shift');
});

test('without the option the report is exactly what it always was', () => {
  const a = reference(240, 640, 151);
  const b = shifted(a, 0, 20);
  const files = writePair('no-flag', a, b);

  const omitted = comparePngFiles(files);
  const explicit = comparePngFiles({ ...files, detectShifts: false });

  assert.equal(JSON.stringify(omitted), JSON.stringify(explicit));
  assert.equal('shifts' in omitted, false);
  assert.equal('detectShifts' in omitted.settings, false);
});

test('masked runs keep working unchanged alongside shift detection', () => {
  const a = reference(240, 640, 161);
  const b = shifted(a, 0, 20);
  const files = writePair('feature1-intact', a, b);
  const mask = [{ name: 'carousel', x: 0, y: 0, w: 240, h: 80 }];

  const report = comparePngFiles({ ...files, mask, detectShifts: true });

  assert.equal(report.ignoredPixels, 240 * 80);
  assert.equal(report.evaluatedPixels, 240 * 640 - 240 * 80);
  assert.equal(report.ignoredRegions.length, 1);
  assert.equal(report.ignoredRegions[0].name, 'carousel');
  assert.equal(report.evaluatedPixels + report.ignoredPixels, report.width * report.height);
});

test('candidate bands are bounded and rows are counted from the diff mask', () => {
  const width = 240;
  const height = 3000;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x += 3) mask[y * width + x] = 1;
  }
  const activity = rowActivity(mask, width, height);
  assert.equal(activity.length, height);
  assert.equal(activity[0], 80);

  const bands = candidateBands(activity, height, { minHeight: 100 });
  assert.equal(bands.length, 1, 'a fully active page is one band, not thousands');
  assert.deepEqual([bands[0].y0, bands[0].y1], [0, height]);
});

test('a long page analyses a bounded number of windows', () => {
  const width = 200;
  const height = 6000;
  const a = reference(width, height, 171);
  const b = shifted(a, 0, 30);
  const files = writePair('long-page', a, b);

  const started = process.hrtime.bigint();
  const report = comparePngFiles({ ...files, detectShifts: true });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(report.height, height);
  assert.equal(report.shifts.length, 1);
  assert.equal(report.shifts[0].deltaY, 30);
  // The cap is what keeps a 200x6000 page from being swept row by row.
  assert.ok(report.shifts[0].windows <= 40, `expected a bounded window count, got ${report.shifts[0].windows}`);
  assert.ok(ms < 20000, `expected a practical runtime, got ${ms.toFixed(0)}ms`);
});

test('a shift entry carries the documented fields and no others', () => {
  const a = reference(240, 640, 181);
  const report = compare('shift-shape', a, shifted(a, 0, 20));

  const [shift] = report.shifts;
  assert.deepEqual(Object.keys(shift).sort(), [
    'confidence', 'deltaX', 'deltaY', 'diffPixels', 'evaluatedSamples', 'h', 'id', 'type', 'w', 'windows', 'x', 'y'
  ].sort());
  assert.equal(shift.type, 'position-shift');
  assert.equal(shift.x, 0);
  assert.equal(shift.w, 240);
  assert.ok(Number.isInteger(shift.deltaX) && Number.isInteger(shift.deltaY));
  assert.ok(shift.confidence > 0 && shift.confidence <= 1);
  assert.deepEqual(report.regions.map((r) => r.type ?? 'pixel-diff'), report.regions.map(() => 'pixel-diff'));
});

test('the detector rejects invalid tuning instead of silently ignoring it', () => {
  const a = reference(120, 400, 191);
  const b = shifted(a, 0, 20);
  const diff = new PNG({ width: a.width, height: a.height });
  const diffMask = new Uint8Array(a.width * a.height).fill(1);

  const call = (tuning) => () => detectPositionShifts({
    a, b, diffMask, width: a.width, height: a.height, tuning
  });

  assert.throws(call({ maxShift: 0 }), /"maxShift" must be an integer between 1 and 4000/);
  assert.throws(call({ maxShift: 1.5 }), /"maxShift" must be an integer/);
  assert.throws(call({ maxShift: '100' }), /"maxShift" must be an integer/);
  assert.throws(call({ nope: 4 }), /unknown option "nope"/);
  assert.throws(call([]), /shift tuning must be an object/);
  assert.doesNotThrow(call({ maxShift: 64, step: 3 }));
  assert.equal(diff.data.length, a.width * a.height * 4);
});

test('the ignore mask is honoured when scoring directly', () => {
  const a = reference(240, 640, 201);
  const b = shifted(a, 0, 20);
  const diff = new PNG({ width: 240, height: 640 });
  const diffMask = new Uint8Array(240 * 640);
  for (let y = 0; y < 640; y++) diffMask[y * 240] = 1;

  const regions = [{ name: 'strip', x: 0, y: 0, w: 240, h: 320 }];
  const { mask, ignoredPixels } = buildIgnoreMask(regions, 240, 640);
  assert.equal(ignoredPixels, 240 * 320);

  const result = detectPositionShifts({ a, b, diffMask, ignoreMask: mask, width: 240, height: 640 });
  assert.equal(result.tuning.maxShift, 200);
  assert.ok(Array.isArray(result.shifts));
});

test('the CLI flag adds shifts and the human summary reports them', () => {
  const a = reference(240, 640, 211);
  const b = shifted(a, 0, 20);
  const { expected, actual } = writePair('cli-shift', a, b);

  const withoutFlag = spawnSync(process.execPath, [cli, expected, actual, '--json'], { encoding: 'utf8' });
  assert.equal(withoutFlag.status, 0);
  assert.equal('shifts' in JSON.parse(withoutFlag.stdout), false);

  const withFlag = spawnSync(process.execPath, [cli, expected, actual, '--json', '--detect-shifts'], { encoding: 'utf8' });
  assert.equal(withFlag.status, 0);
  const report = JSON.parse(withFlag.stdout);
  assert.equal(report.settings.detectShifts, true);
  assert.equal(report.shifts.length, 1);
  assert.equal(report.shifts[0].deltaY, 20);

  const human = spawnSync(process.execPath, [cli, expected, actual, '--detect-shifts'], { encoding: 'utf8' });
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Position shifts: 1/);
  assert.match(human.stdout, /dy=20/);
});

test('the CLI rejects a value after the boolean shift flag', () => {
  const a = reference(120, 400, 221);
  const b = shifted(a, 0, 20);
  const { expected, actual } = writePair('cli-bad-flag', a, b);

  const result = spawnSync(process.execPath, [cli, expected, actual, '--detect-shifts', 'yes'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly <expected\.png> and <actual\.png>/);
});

test('the CLI help documents the shift flag and its contract', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--detect-shifts/);
  assert.match(help.stdout, /position-shift/);
  assert.match(help.stdout, /deltaX/);
  assert.match(help.stdout, /conservative/);
});
