import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

/**
 * Deterministic synthetic fixtures for the sensitivity presets.
 *
 * Every image is drawn from a seeded integer generator, so the same bytes are
 * produced on every machine and Node version. Nothing here reads the clock, the
 * filesystem or the environment.
 *
 * Each case declares its ground truth:
 *
 *   truth  rectangles that contain a real visual defect. A preset that reports
 *          nothing here has produced a false negative.
 *   noise  rectangles that only contain rendering variance. A preset that
 *          reports a region here has produced a false positive.
 *
 * `truth` and `noise` are written down from how the image is *built*, never from
 * what the comparator reports, so the benchmark cannot grade itself.
 */

const WIDTH = 800;
const HEIGHT = 600;

const BG = [250, 250, 250];
const INK = [45, 45, 45];
const EDGE = [150, 150, 150];
const SWATCH = [100, 100, 100];
const BLOCK = [30, 90, 180];
const CARD = [238, 238, 238];
const CARD_EDGE = [214, 214, 214];
const SHADOW_PEAK = 26;
const SHADOW_ROWS = 24;

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

function canvas(fill = BG) {
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    png.data[i * 4] = fill[0];
    png.data[i * 4 + 1] = fill[1];
    png.data[i * 4 + 2] = fill[2];
    png.data[i * 4 + 3] = 255;
  }
  return png;
}

function set(png, x, y, color) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  png.data[i] = color[0];
  png.data[i + 1] = color[1];
  png.data[i + 2] = color[2];
  png.data[i + 3] = 255;
}

function rect(png, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(png, x, y, color);
}

function outline(png, x0, y0, w, h, color) {
  for (let x = x0; x < x0 + w; x++) {
    set(png, x, y0, color);
    set(png, x, y0 + h - 1, color);
  }
  for (let y = y0; y < y0 + h; y++) {
    set(png, x0, y, color);
    set(png, x0 + w - 1, y, color);
  }
}

/** A soft shadow: strongest on the row under the card, gone by SHADOW_ROWS. */
function shadow(png, x0, w, peak = SHADOW_PEAK, rows = SHADOW_ROWS) {
  for (let i = 0; i < rows; i++) {
    const strength = Math.round(peak * (1 - i / rows) ** 1.6);
    const shade = BG[0] - strength;
    for (let x = x0; x < x0 + w; x++) set(png, x, 286 + i, [shade, shade, shade]);
  }
}

/**
 * A text line with soft edges.
 *
 * The first and last column of every bar carry an intermediate tone, which is
 * what a rasteriser produces on a fractional edge. Perturbing only those columns
 * is how the anti-aliasing noise case is built: the glyph shapes are identical,
 * only the edge sampling changed.
 */
function textLine(png, x, y, w, h = 9) {
  rect(png, x, y, w, h, INK);
  for (let j = 0; j < h; j++) {
    set(png, x, y + j, EDGE);
    set(png, x + w - 1, y + j, EDGE);
  }
}

const TEXT_LINES = Array.from({ length: 6 }, (_, i) => ({
  x: 96,
  y: 132 + i * 22,
  w: 380 + ((i * 57) % 220)
}));

const SWATCH_RECT = { name: 'gray-swatch', x: 96, y: 320, w: 120, h: 40 };
const BLOCK_RECT = { name: 'blue-block', x: 96, y: 400, w: 120, h: 120 };
const PANEL_RECT = { name: 'low-contrast-card', x: 560, y: 320, w: 180, h: 120 };
const TEXT_AREA = { name: 'card-text', x: 90, y: 126, w: 620, h: 130 };
const SHADOW_AREA = { name: 'card-shadow', x: 56, y: 286, w: 688, h: SHADOW_ROWS };

/**
 * The one page every case starts from.
 *
 * Cases differ only by the single change under test, so any difference between
 * two cases is caused by the preset and not by the content.
 */
function basePage() {
  const png = canvas();
  rect(png, 60, 40, 320, 22, [15, 15, 15]);
  rect(png, 60, 96, 680, 190, [255, 255, 255]);
  outline(png, 60, 96, 680, 190, [228, 228, 228]);
  for (const line of TEXT_LINES) textLine(png, line.x, line.y, line.w);
  shadow(png, 56, 688);
  rect(png, SWATCH_RECT.x, SWATCH_RECT.y, SWATCH_RECT.w, SWATCH_RECT.h, SWATCH);
  rect(png, BLOCK_RECT.x, BLOCK_RECT.y, BLOCK_RECT.w, BLOCK_RECT.h, BLOCK);
  // Deliberately low contrast. A spacing defect on a saturated panel against a
  // white page is a delta of 192 and every threshold sees it; on a real card
  // with a hairline border it is a delta of 36, and the threshold decides.
  rect(png, PANEL_RECT.x, PANEL_RECT.y, PANEL_RECT.w, PANEL_RECT.h, CARD);
  outline(png, PANEL_RECT.x, PANEL_RECT.y, PANEL_RECT.w, PANEL_RECT.h, CARD_EDGE);
  rect(png, 60, 500, 680, 1, [200, 200, 200]);
  rect(png, 60, 520, 680, 1, [200, 200, 200]);
  rect(png, 60, 540, 240, 12, [90, 90, 90]);
  return png;
}

function clone(png) {
  const out = new PNG({ width: png.width, height: png.height });
  out.data.set(png.data);
  return out;
}

/** Shift every channel of one pixel by `amount`, staying inside 0..255. */
function nudge(png, x, y, amount) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  for (let c = 0; c < 3; c++) {
    png.data[i + c] = Math.max(0, Math.min(255, png.data[i + c] + amount));
  }
}

/** Move a solid rectangle by a whole number of pixels. */
function moveBlock(png, box, dx, dy) {
  rect(png, box.x, box.y, box.w, box.h, BG);
  rect(png, box.x + dx, box.y + dy, box.w, box.h, CARD);
  outline(png, box.x + dx, box.y + dy, box.w, box.h, CARD_EDGE);
  return png;
}

/** Perturb only the soft edge columns of the text lines. */
function jitterEdges(png, amount) {
  for (const line of TEXT_LINES) {
    for (let j = 0; j < 9; j++) {
      for (const x of [line.x, line.x + line.w - 1]) {
        const i = (line.y + j) * WIDTH + x;
        const base = png.data[i * 4];
        png.data[i * 4] = base + amount;
        png.data[i * 4 + 1] = base + amount;
        png.data[i * 4 + 2] = base + amount;
      }
    }
  }
}

/**
 * A deterministic field of low-amplitude specks, the shape capture noise and
 * font antialiasing actually take: mostly isolated, with a few dense clusters
 * that stand in for a line of small text.
 *
 * Every speck nudges the pixel that is already there, so the amplitude is
 * exactly what is asked for regardless of the colour underneath.
 */
function speckle(png, seed, { specks = 240, clusters = 8, low = 6, high = 10 } = {}) {
  const random = rng(seed);
  const taken = new Set();
  const free = (x, y) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (taken.has(`${x + dx},${y + dy}`)) return false;
      }
    }
    return true;
  };
  const paint = (x, y, w, h, amount) => {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        nudge(png, x + dx, y + dy, amount);
        taken.add(`${x + dx},${y + dy}`);
      }
    }
  };

  for (let i = 0; i < specks; i++) {
    const w = random() < 0.5 ? 1 : 2;
    const h = w === 1 ? 2 : 1;
    const x = 56 + Math.floor(random() * (WIDTH - 116));
    const y = 30 + Math.floor(random() * (HEIGHT - 90));
    if (!free(x, y)) continue;
    const amount = low + Math.floor(random() * (high - low + 1));
    paint(x, y, w, h, random() < 0.5 ? -amount : amount);
  }

  // A line of small text: dense, connected enough to survive any region-size
  // filter, which is exactly why it can only be suppressed by the threshold.
  // A speck never lands on a pixel already painted, so the amplitude of every
  // single one of them stays inside the declared low..high range.
  for (let i = 0; i < clusters; i++) {
    const x = 60 + Math.floor(random() * (WIDTH - 190));
    const y = 30 + Math.floor(random() * (HEIGHT - 120));
    let placed = 0;
    let guard = 0;
    while (placed < 400 && guard++ < 8000) {
      const sx = x + Math.floor(random() * 90);
      const sy = y + Math.floor(random() * 40);
      if (taken.has(`${sx},${sy}`)) continue;
      const amount = low + Math.floor(random() * (high - low + 1));
      paint(sx, sy, 1, 1, random() < 0.5 ? -amount : amount);
      placed++;
    }
  }
}

function write(dir, name, png) {
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}

/**
 * Build every fixture.
 *
 * `kind` records what the case is for: `signal` cases carry a real defect and
 * nothing else, `noise` cases carry only rendering variance, `mixed` cases
 * carry a real defect buried in it.
 */
export function buildFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cases = [];
  const add = (name, kind, truth, noise, build) => {
    const reference = basePage();
    const actual = build(reference);
    cases.push({
      name,
      kind,
      truth,
      noise,
      reference: write(dir, `${name}-reference`, reference),
      actual: write(dir, `${name}-actual`, actual)
    });
  };

  // 1. flat colour field moved by 5/255. Invisible to a human at a glance, and
  //    a real design-token change. The amplitude is far below what the default
  //    threshold can see, which is the whole point of a strict profile.
  add('case1-subtle-color', 'signal', [SWATCH_RECT], [], p => {
    const out = clone(p);
    rect(out, SWATCH_RECT.x, SWATCH_RECT.y, SWATCH_RECT.w, SWATCH_RECT.h, [105, 105, 105]);
    return out;
  });

  // 2. the same swatch moved by 40/255. A colour change anyone would call a bug.
  add('case2-strong-color', 'signal', [SWATCH_RECT], [], p => {
    const out = clone(p);
    rect(out, SWATCH_RECT.x, SWATCH_RECT.y, SWATCH_RECT.w, SWATCH_RECT.h, [140, 140, 140]);
    return out;
  });

  // 3. a low-contrast card 1px lower. Spacing is the defect this tool is used
  //    to catch, and 1px on a hairline border is the amplitude that separates a
  //    careful review from a lucky one.
  add('case3-spacing-1px', 'signal', [{ ...PANEL_RECT, h: PANEL_RECT.h + 1 }], [], p =>
    moveBlock(clone(p), PANEL_RECT, 0, 1));

  // 4. the same card 2px lower.
  add('case4-spacing-2px', 'signal', [{ ...PANEL_RECT, h: PANEL_RECT.h + 2 }], [], p =>
    moveBlock(clone(p), PANEL_RECT, 0, 2));

  // 5. identical glyphs, resampled edges. No design change exists in this image;
  //    every difference is a rasteriser telling the truth slightly differently.
  add('case5-aa-edge-noise', 'noise', [], [TEXT_AREA], p => {
    const out = clone(p);
    jitterEdges(out, 7);
    return out;
  });

  // 6. same shadow, one step lighter and one row shorter. Note the amplitude is
  //    the same 5/255 as case 1, which is the point: the ground truth cannot be
  //    read off the amplitude, only off what the change means.
  add('case6-shadow-variance', 'noise', [], [SHADOW_AREA], p => {
    const out = clone(p);
    shadow(out, 56, 688, SHADOW_PEAK - 5, SHADOW_ROWS - 1);
    return out;
  });

  // 7. a 120x120 block removed. Any sane profile must find this.
  add('case7-structural-block', 'signal', [BLOCK_RECT], [], p => {
    const out = clone(p);
    rect(out, BLOCK_RECT.x, BLOCK_RECT.y, BLOCK_RECT.w, BLOCK_RECT.h, BG);
    return out;
  });

  // 8. twelve isolated single pixels moved by 3/255. A single pixel is never
  //    actionable, so the correct answer is zero regions at every profile.
  add('case8-single-pixel-noise', 'noise', [], [], p => {
    const out = clone(p);
    const random = rng(7);
    const taken = [];
    let placed = 0;
    while (placed < 12) {
      const x = 60 + Math.floor(random() * (WIDTH - 120));
      const y = 30 + Math.floor(random() * (HEIGHT - 60));
      if (taken.some(([tx, ty]) => Math.abs(tx - x) < 4 && Math.abs(ty - y) < 4)) continue;
      taken.push([x, y]);
      nudge(out, x, y, -3);
      placed++;
    }
    return out;
  });

  // 9. a field of low-amplitude specks, plus dense clusters standing in for
  //    small text. The purest noise-rejection case there is.
  add('case9-low-level-noise', 'noise', [], [], p => {
    const out = clone(p);
    speckle(out, 1337);
    return out;
  });

  // 10. the case7 defect with the case9 field painted over the rest of the page.
  //     The question is whether a profile can drop the noise and keep the block.
  add('case10-defect-plus-noise', 'mixed', [BLOCK_RECT], [], p => {
    const out = clone(p);
    rect(out, BLOCK_RECT.x, BLOCK_RECT.y, BLOCK_RECT.w, BLOCK_RECT.h, BG);
    speckle(out, 1337);
    return out;
  });

  return cases;
}

export const FIXTURE_SIZE = { width: WIDTH, height: HEIGHT };
