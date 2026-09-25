import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { connectedComponents, mergeRegions, padAndClampRegions, sortRegions } from './regions.js';

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
  maxRegions = 50
}) {
  const a = readPng(expected);
  const b = readPng(actual);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`dimension mismatch: expected=${a.width}x${a.height}, actual=${b.width}x${b.height}`);
  }

  const { width, height } = a;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold,
    includeAA,
    diffMask: true,
    diffColor: [255, 0, 0],
    alpha: 1
  });

  if (diffPng) {
    fs.mkdirSync(path.dirname(diffPng), { recursive: true });
    fs.writeFileSync(diffPng, PNG.sync.write(diff));
  }

  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = diff.data[i * 4 + 3] > 0 ? 1 : 0;

  let regions = connectedComponents(mask, width, height, minRegionPixels);
  regions = mergeRegions(regions, mergeGap);
  regions = padAndClampRegions(regions, width, height, regionPadding);
  regions = sortRegions(regions).slice(0, maxRegions).map((r, index) => ({
    id: index + 1,
    ...r,
    area: r.w * r.h,
    density: round(r.px / (r.w * r.h), 4),
    shareOfDiff: diffPixels ? round(r.px / diffPixels, 4) : 0
  }));

  const totalPixels = width * height;
  const diffRatio = diffPixels / totalPixels;
  return {
    schemaVersion: 1,
    section,
    viewport: `${width}x${height}`,
    width,
    height,
    match: `${round((1 - diffRatio) * 100, 4)}%`,
    matchRatio: round(1 - diffRatio, 6),
    diffPixels,
    diffRatio: round(diffRatio, 6),
    regions,
    diffPng: diffPng ?? null,
    settings: { threshold, includeAA, minRegionPixels, mergeGap, regionPadding, maxRegions }
  };
}
