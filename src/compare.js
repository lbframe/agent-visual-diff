import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { connectedComponents, mergeRegions, padAndClampRegions, sortRegions } from './regions.js';
import { buildIgnoreMask, clampRegions, paintIgnoredOverlay } from './mask.js';
import { detectPositionShifts } from './shift.js';
import { resolveSettings } from './presets.js';

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function round(value, digits = 4) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

/**
 * Compare two PNGs.
 *
 * `preset` names a sensitivity profile from `./presets.js`. Every comparison
 * option left `undefined` falls back to the preset, and to the v0.1 defaults
 * when there is no preset, so an explicit option always wins over a preset
 * value. Options are detected by being `undefined` rather than by a sentinel,
 * which is why a caller can pass `threshold: 0` and mean it.
 */
export function comparePngFiles({
  expected,
  actual,
  diffPng,
  section = path.basename(actual, path.extname(actual)),
  preset = null,
  threshold,
  includeAA,
  minRegionPixels,
  mergeGap,
  regionPadding,
  maxRegions,
  mask = [],
  ignore = [],
  maskFile = null,
  detectShifts = false
}) {
  const settings = resolveSettings({ preset, threshold, includeAA, minRegionPixels, mergeGap, regionPadding, maxRegions });

  const a = readPng(expected);
  const b = readPng(actual);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`dimension mismatch: expected=${a.width}x${a.height}, actual=${b.width}x${b.height}`);
  }

  const { width, height } = a;
  const diff = new PNG({ width, height });
  pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: settings.threshold,
    includeAA: settings.includeAA,
    diffMask: true,
    diffColor: [255, 0, 0],
    alpha: 1
  });

  const totalPixels = width * height;
  const ignoredRegions = clampRegions([...mask, ...ignore], width, height);
  const { mask: ignoreMask, ignoredPixels } = buildIgnoreMask(ignoredRegions, width, height);
  const evaluatedPixels = totalPixels - ignoredPixels;
  if (evaluatedPixels === 0) {
    throw new Error(`all ${totalPixels} pixels are ignored: nothing left to compare`);
  }

  const diffMask = new Uint8Array(totalPixels);
  let diffPixels = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (ignoreMask[i]) continue;
    if (diff.data[i * 4 + 3] > 0) {
      diffMask[i] = 1;
      diffPixels++;
    }
  }

  let regions = connectedComponents(diffMask, width, height, settings.minRegionPixels);
  regions = mergeRegions(regions, settings.mergeGap);
  regions = padAndClampRegions(regions, width, height, settings.regionPadding);
  regions = sortRegions(regions).slice(0, settings.maxRegions).map((r, index) => ({
    id: index + 1,
    ...r,
    area: r.w * r.h,
    density: round(r.px / (r.w * r.h), 4),
    shareOfDiff: diffPixels ? round(r.px / diffPixels, 4) : 0
  }));

  const diffRatio = diffPixels / evaluatedPixels;

  // Shift detection reads the diff mask and the ignore mask that were just
  // built, so it inherits masking for free: an ignored pixel can neither open
  // a candidate nor be re-matched at a translated destination.
  const detected = detectShifts
    ? detectPositionShifts({ a, b, diffMask, ignoreMask: ignoredPixels > 0 ? ignoreMask : null, width, height })
    : null;

  paintIgnoredOverlay(diff.data, ignoreMask);
  if (diffPng) {
    fs.mkdirSync(path.dirname(diffPng), { recursive: true });
    fs.writeFileSync(diffPng, PNG.sync.write(diff));
  }

  const report = {
    schemaVersion: 2,
    section,
    viewport: `${width}x${height}`,
    width,
    height,
    match: `${round((1 - diffRatio) * 100, 4)}%`,
    matchRatio: round(1 - diffRatio, 6),
    diffPixels,
    diffRatio: round(diffRatio, 6),
    ignoredPixels,
    evaluatedPixels,
    ignoredRegions,
    regions,
    diffPng: diffPng ?? null,
    // `preset` appears only when one was asked for, so a run without the flag
    // serialises to exactly the bytes it always did. `settings` below already
    // carries the values that actually ran, which is what makes the two
    // together enough for an agent to know what it got.
    ...(preset ? { preset } : {}),
    settings: {
      threshold: settings.threshold,
      includeAA: settings.includeAA,
      minRegionPixels: settings.minRegionPixels,
      mergeGap: settings.mergeGap,
      regionPadding: settings.regionPadding,
      maxRegions: settings.maxRegions,
      mask: maskFile
    }
  };

  // `shifts` and `settings.detectShifts` appear only when asked for, so a run
  // without the flag serialises to exactly the bytes it always did.
  if (detected) {
    report.shifts = detected.shifts;
    report.settings.detectShifts = true;
  }

  return report;
}
