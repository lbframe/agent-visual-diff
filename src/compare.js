import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { connectedComponents, mergeRegions, padAndClampRegions, sortRegions } from './regions.js';
import { buildIgnoreMask, clampRegions, paintIgnoredOverlay } from './mask.js';
import { detectPositionShifts } from './shift.js';

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function round(value, digits = 4) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

export function comparePngFiles({
  expected,
  actual,
  diffPng,
  section = path.basename(actual, path.extname(actual)),
  threshold = 0.1,
  includeAA = false,
  minRegionPixels = 2,
  mergeGap = 6,
  regionPadding = 2,
  maxRegions = 50,
  mask = [],
  ignore = [],
  maskFile = null,
  detectShifts = false
}) {
  const a = readPng(expected);
  const b = readPng(actual);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`dimension mismatch: expected=${a.width}x${a.height}, actual=${b.width}x${b.height}`);
  }

  const { width, height } = a;
  const diff = new PNG({ width, height });
  pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold,
    includeAA,
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

  let regions = connectedComponents(diffMask, width, height, minRegionPixels);
  regions = mergeRegions(regions, mergeGap);
  regions = padAndClampRegions(regions, width, height, regionPadding);
  regions = sortRegions(regions).slice(0, maxRegions).map((r, index) => ({
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
    settings: { threshold, includeAA, minRegionPixels, mergeGap, regionPadding, maxRegions, mask: maskFile }
  };

  // `shifts` and `settings.detectShifts` appear only when asked for, so a run
  // without the flag serialises to exactly the bytes it always did.
  if (detected) {
    report.shifts = detected.shifts;
    report.settings.detectShifts = true;
  }

  return report;
}
