import fs from 'node:fs';

const ALLOWED_KEYS = ['name', 'x', 'y', 'w', 'h'];

/** Visual treatment of excluded zones in the diff PNG: 20% gray, never touching evaluated pixels. */
export const IGNORED_OVERLAY = { strength: 0.2, gray: 128 };

function validateRegion(region, where) {
  if (region === null || typeof region !== 'object' || Array.isArray(region)) {
    throw new Error(`${where} must be an object with ${ALLOWED_KEYS.slice(1).join(', ')}`);
  }
  for (const key of Object.keys(region)) {
    if (!ALLOWED_KEYS.includes(key)) {
      throw new Error(`${where}: unknown key "${key}" (expected ${ALLOWED_KEYS.join(', ')})`);
    }
  }
  for (const key of ['x', 'y', 'w', 'h']) {
    if (!Number.isInteger(region[key])) {
      throw new Error(`${where}: "${key}" must be an integer, got ${JSON.stringify(region[key])}`);
    }
  }
  if (region.x < 0 || region.y < 0) throw new Error(`${where}: "x" and "y" must be >= 0, got x=${region.x} y=${region.y}`);
  if (region.w <= 0 || region.h <= 0) throw new Error(`${where}: "w" and "h" must be > 0, got w=${region.w} h=${region.h}`);
  if (region.name != null && (typeof region.name !== 'string' || region.name === '')) {
    throw new Error(`${where}: "name" must be a non-empty string when present`);
  }
  return region;
}

/** Read and validate a JSON mask file: `{ "regions": [{ name, x, y, w, h }] }`. */
export function readMaskFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read mask file ${file}: ${err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in mask file ${file}: ${err.message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`mask file ${file} must contain an object with a "regions" array`);
  }
  if (!Array.isArray(doc.regions)) {
    throw new Error(`mask file ${file} must contain a "regions" array`);
  }
  return doc.regions.map((region, index) => validateRegion(region, `regions[${index}]`));
}

/** Parse one inline `--ignore x,y,w,h` spec. */
export function parseIgnoreSpec(spec, name) {
  const parts = String(spec).split(',').map(s => s.trim());
  if (parts.length !== 4) {
    throw new Error(`--ignore expects "x,y,w,h", got "${spec}"`);
  }
  const [x, y, w, h] = parts.map(p => Number(p));
  return validateRegion({ name, x, y, w, h }, '--ignore');
}

/** Clamp regions to the viewport, name unnamed ones, and reject zones fully outside it. */
export function clampRegions(regions, width, height) {
  return regions.map((r, index) => {
    for (const key of ['x', 'y', 'w', 'h']) {
      if (!Number.isInteger(r?.[key])) {
        throw new Error(`regions[${index}]: "${key}" must be an integer, got ${JSON.stringify(r?.[key])}`);
      }
    }
    const name = r.name ?? `region-${index + 1}`;
    const x0 = Math.min(r.x, width);
    const y0 = Math.min(r.y, height);
    const x1 = Math.min(r.x + r.w, width);
    const y1 = Math.min(r.y + r.h, height);
    if (x1 <= x0 || y1 <= y0) {
      throw new Error(`region "${name}" at ${r.x},${r.y} ${r.w}x${r.h} lies entirely outside the ${width}x${height} viewport`);
    }
    return { name, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  });
}

/** Rasterize the union of all regions; overlapping pixels are counted once. */
export function buildIgnoreMask(regions, width, height) {
  const mask = new Uint8Array(width * height);
  let ignoredPixels = 0;
  for (const r of regions) {
    for (let y = r.y; y < r.y + r.h; y++) {
      const row = y * width;
      for (let x = r.x; x < r.x + r.w; x++) {
        const index = row + x;
        if (!mask[index]) {
          mask[index] = 1;
          ignoredPixels++;
        }
      }
    }
  }
  return { mask, ignoredPixels };
}

/** Blend a deterministic gray wash over ignored zones in a diff image. Alpha is preserved. */
export function paintIgnoredOverlay(data, ignoreMask, { strength = IGNORED_OVERLAY.strength, gray = IGNORED_OVERLAY.gray } = {}) {
  const lut = new Uint8Array(256);
  for (let value = 0; value < 256; value++) {
    lut[value] = Math.floor(value * (1 - strength) + gray * strength + 0.5);
  }
  for (let index = 0; index < ignoreMask.length; index++) {
    if (!ignoreMask[index]) continue;
    const p = index * 4;
    data[p] = lut[data[p]];
    data[p + 1] = lut[data[p + 1]];
    data[p + 2] = lut[data[p + 2]];
  }
}
