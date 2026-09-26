import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

/**
 * Deterministic synthetic fixtures for position shift detection.
 *
 * Every image is drawn from a seeded integer generator, so the same bytes are
 * produced on every machine and Node version. Nothing here reads the clock, the
 * filesystem or the environment.
 *
 * Content is built from high-contrast bars and blocks rather than gradients on
 * purpose: a gradient matches at almost any offset, so a fixture made of one
 * could not tell a working detector from a lucky one.
 */

/** Mulberry32: small, fast, fully specified by its seed. */
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

function canvas(width, height, fill = [255, 255, 255]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = fill[0];
    png.data[i * 4 + 1] = fill[1];
    png.data[i * 4 + 2] = fill[2];
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
 * Paint a distinctive "section" of content at an offset.
 *
 * Two structures are drawn, because a fixture needs to constrain both axes for
 * a delta to be provable at all:
 *
 *   - bars of varying height, so a vertical displacement is uniquely pinned
 *   - irregular vertical ticks inside each bar, so a horizontal displacement is
 *     pinned too
 *
 * The ticks are irregular on purpose. Evenly spaced stripes would be periodic,
 * and a periodic pattern matches at every multiple of its period, which would
 * hand the detector a wrong offset that scores perfectly.
 */
function section(png, originX, originY, width, height, random) {
  let y = originY;
  let bar = 0;
  while (y < originY + height) {
    const barHeight = 6 + Math.floor(random() * 10);
    const barWidth = Math.floor(width * (0.35 + random() * 0.6));
    const shade = bar % 3;
    const color = shade === 0 ? [20, 20, 20] : shade === 1 ? [200, 30, 30] : [30, 30, 160];
    const x = originX + Math.floor(random() * 8);
    rect(png, x, y, barWidth, barHeight, color);

    let tick = x;
    while (tick < x + barWidth) {
      const tickWidth = 2 + Math.floor(random() * 7);
      rect(png, tick, y, Math.min(tickWidth, 3), barHeight, shade === 1 ? [250, 210, 210] : [225, 225, 225]);
      tick += tickWidth;
    }

    y += barHeight + 4 + Math.floor(random() * 6);
    bar++;
  }
  rect(png, originX, originY + height - 40, width, 40, [15, 15, 15]);
}

function shiftedCopy(source, dx, dy) {
  const out = canvas(source.width, source.height, [255, 255, 255]);
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

/** A page of independent sections, used as the base for most cases. */
function page(width, height, seed, originY = 0) {
  const png = canvas(width, height);
  const random = rng(seed);
  const slice = Math.floor(height / 3);
  section(png, 40, originY + 30, width - 80, slice - 90, random);
  section(png, 40, originY + slice + 30, width - 80, slice - 90, rng(seed + 1));
  section(png, 40, originY + slice * 2 + 30, width - 80, slice - 90, rng(seed + 2));
  return png;
}

/** A grid of near-identical cards: the repeated-pattern trap. */
function repeatedCards(width, height, seed) {
  const png = canvas(width, height);
  const random = rng(seed);
  const cols = 3;
  const rows = 3;
  const cardW = Math.floor((width - 80) / cols);
  const cardH = Math.floor((height - 80) / rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = 40 + c * cardW;
      const y = 40 + r * cardH;
      rect(png, x, y, cardW - 16, cardH - 16, [245, 245, 245]);
      rect(png, x, y, cardW - 16, 4, [40, 40, 40]);
      // The one deliberate variation keeps the cards distinguishable to a
      // human without making them unique to a patch matcher.
      const marker = (r * cols + c) % 4 === 0 ? 24 : 10;
      rect(png, x + 12, y + 20 + Math.floor(random() * 6), cardW - 60, marker, [90, 90, 90]);
      rect(png, x + 12, y + 60, cardW - 70, 8, [160, 160, 160]);
      rect(png, x + 12, y + 76, cardW - 90, 8, [160, 160, 160]);
    }
  }
  return png;
}

function write(dir, name, png) {
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}

/**
 * Build every fixture. Each case declares the shift it contains, if any, and
 * what a correct detector must conclude; the benchmark asserts against these
 * rather than against hard-coded numbers.
 */
export function buildFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cases = [];
  const add = (name, expected, a, b, mask) => {
    cases.push({
      name,
      expected,
      reference: write(dir, `${name}-reference`, a),
      actual: write(dir, `${name}-actual`, b),
      mask
    });
  };

  // 1. pure vertical shift, +20
  {
    const a = page(600, 900, 11);
    add('case1-vertical-plus-20', { deltaX: 0, deltaY: 20 }, a, shiftedCopy(a, 0, 20));
  }

  // 2. large vertical shift, +100
  {
    const a = page(600, 900, 22);
    add('case2-vertical-plus-100', { deltaX: 0, deltaY: 100 }, a, shiftedCopy(a, 0, 100));
  }

  // 3. horizontal shift, +32
  {
    const a = page(600, 900, 33);
    add('case3-horizontal-plus-32', { deltaX: 32, deltaY: 0 }, a, shiftedCopy(a, 32, 0));
  }

  // 4. diagonal shift, +15 / -25
  {
    const a = page(600, 900, 44);
    add('case4-diagonal', { deltaX: 15, deltaY: -25 }, a, shiftedCopy(a, 15, -25));
  }

  // 5. real content change in place: must never be called a shift
  {
    const a = page(600, 900, 55);
    const b = page(600, 900, 66);
    add('case5-content-change', null, a, b);
  }

  // 6. shifted and materially modified across the whole page, so no window is
  //    cleanly explainable as a displacement
  {
    const a = page(600, 900, 77);
    const b = shiftedCopy(a, 0, 40);
    rect(b, 60, 120, 480, 200, [255, 0, 255]);
    rect(b, 60, 420, 480, 120, [0, 200, 200]);
    rect(b, 60, 700, 480, 140, [255, 140, 0]);
    add('case6-shifted-and-modified', null, a, b);
  }

  // 7. repeated card grid: must never produce a confident false shift
  {
    const a = repeatedCards(600, 900, 88);
    const b = repeatedCards(600, 900, 99);
    rect(b, 0, 0, 600, 900, [255, 255, 255]);
    b.data.set(a.data);
    rect(b, 250, 420, 120, 90, [0, 0, 0]);
    add('case7-repeated-cards', null, a, b);
  }

  // 8. a real shift partly hidden behind a mask
  {
    const a = page(600, 900, 111);
    const b = shiftedCopy(a, 0, 30);
    const mask = [{ name: 'dynamic-strip', x: 0, y: 0, w: 600, h: 120 }];
    add('case8-mask-intersection', { deltaX: 0, deltaY: 30 }, a, b, mask);
  }

  return cases;
}
