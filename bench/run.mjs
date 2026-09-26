#!/usr/bin/env node
/**
 * Mask benchmark: baseline vs masked vs masked+injected-bug, on real captures.
 *
 *   node bench/run.mjs
 *
 * Fixtures live outside this repository (the clone repos' design-references
 * folders). Override any path with the matching AVD_BENCH_* env var.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { comparePngFiles } from '../src/compare.js';
import { readMaskFile } from '../src/mask.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.env.AVD_BENCH_OUT ?? path.join(here, 'out');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-bench-'));

const SITES = [
  {
    key: 'duna',
    label: 'Duna desktop 1440x9610',
    expected: process.env.AVD_BENCH_DUNA_A ?? '/Users/leonardoballand/lab/ai-website-cloner/docs/design-references/duna-com-7c5a0f0d/root-8a5edab2/desktop-full.png',
    actual: process.env.AVD_BENCH_DUNA_B ?? '/Users/leonardoballand/lab/ai-website-cloner/docs/design-references/duna-com-7c5a0f0d/root-8a5edab2/desktop-full-hydrated.png',
    mask: path.join(here, 'masks', 'duna-desktop.json'),
    settings: { minRegionPixels: 20, mergeGap: 10, regionPadding: 2, includeAA: true },
    bug: { op: 'fill', x: 200, y: 400, w: 420, h: 180, arg: '255,0,0' }
  },
  {
    key: 'stripe',
    label: 'Stripe reco 1440x900',
    expected: process.env.AVD_BENCH_STRIPE_A ?? '/Users/leonardoballand/lab/stripe/docs/design-references/stripe-com-9ababc9a/root-8a5edab2/reco-desktop.png',
    actual: process.env.AVD_BENCH_STRIPE_B ?? '/Users/leonardoballand/lab/stripe/docs/design-references/stripe-com-9ababc9a/root-8a5edab2/reco-clone-typed.png',
    mask: path.join(here, 'masks', 'stripe-reco.json'),
    settings: { minRegionPixels: 20, mergeGap: 10, regionPadding: 2, includeAA: true },
    bug: { op: 'fill', x: 1150, y: 520, w: 180, h: 120, arg: '255,0,0' }
  },
  {
    key: 'apple',
    label: 'Apple gallery 1440x1000',
    expected: process.env.AVD_BENCH_APPLE_A ?? '/Users/leonardoballand/lab/apple/ai-website-cloner-template/docs/design-references/apple-com-736d3707/spacing-review-2026-09-25/reference-desktop-gallery-1440x1000.png',
    actual: process.env.AVD_BENCH_APPLE_B ?? '/Users/leonardoballand/lab/apple/ai-website-cloner-template/docs/design-references/apple-com-736d3707/spacing-review-2026-09-25/clone-desktop-gallery-1440x1000.png',
    mask: path.join(here, 'masks', 'apple-gallery.json'),
    settings: { minRegionPixels: 10, mergeGap: 10, regionPadding: 2, includeAA: true },
    bug: { op: 'fill', x: 560, y: 250, w: 200, h: 120, arg: '255,0,0' }
  }
];

function injectBug(site) {
  const { op, x, y, w, h, arg } = site.bug;
  const output = path.join(scratch, `${site.key}-bug.png`);
  const result = spawnSync(
    process.execPath,
    [path.join(here, 'inject-bug.mjs'), site.actual, output, op, String(x), String(y), String(w), String(h), String(arg)],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) throw new Error(`inject-bug failed: ${result.stderr}`);
  return output;
}

function run(site, actual, maskRegions, tag) {
  const report = comparePngFiles({
    expected: site.expected,
    actual,
    section: site.key,
    diffPng: path.join(outDir, `${site.key}-${tag}.png`),
    ...site.settings,
    mask: maskRegions,
    maskFile: tag === 'masked' ? site.mask : null
  });
  fs.writeFileSync(path.join(outDir, `${site.key}-${tag}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const n = value => value.toLocaleString('en-US');
const pct = value => `${(value * 100).toFixed(4)}%`;
const rows = [];

fs.mkdirSync(outDir, { recursive: true });

for (const site of SITES) {
  for (const file of [site.expected, site.actual, site.mask]) {
    if (!fs.existsSync(file)) throw new Error(`missing fixture: ${file}`);
  }

  const mask = readMaskFile(site.mask);
  const bugged = injectBug(site);

  const baseline = run(site, site.actual, [], 'baseline');
  const masked = run(site, site.actual, mask, 'masked');
  const withBug = comparePngFiles({
    expected: site.expected, actual: bugged, section: site.key, ...site.settings,
    mask, maskFile: site.mask,
    diffPng: path.join(outDir, `${site.key}-masked-bug.png`)
  });
  fs.writeFileSync(path.join(outDir, `${site.key}-masked-bug.json`), `${JSON.stringify(withBug, null, 2)}\n`);

  const overlaps = (r, box) => !(r.x > box.x + box.w || r.x + r.w < box.x || r.y > box.y + box.h || r.y + r.h < box.y);
  const bugRegions = withBug.regions.filter(r => overlaps(r, site.bug));
  const bugDetected = withBug.diffPixels > masked.diffPixels;
  const inBounds = bugRegions.length > 0;

  const totalPixels = masked.width * masked.height;
  const invariantsOk =
    masked.evaluatedPixels === totalPixels - masked.ignoredPixels &&
    masked.diffPixels <= baseline.diffPixels &&
    masked.regions.reduce((sum, r) => sum + r.px, 0) <= masked.diffPixels;

  const maskedRepeat = comparePngFiles({
    expected: site.expected, actual: site.actual, section: site.key, ...site.settings,
    mask, maskFile: site.mask
  });
  const deterministic = JSON.stringify(masked) === JSON.stringify({
    ...maskedRepeat,
    diffPng: path.join(outDir, `${site.key}-masked.png`)
  });

  rows.push({
    site: site.label,
    baselinePx: baseline.diffPixels,
    baselinePct: pct(baseline.diffRatio),
    baselineRegions: baseline.regions.length,
    maskedPx: masked.diffPixels,
    maskedPct: pct(masked.diffRatio),
    maskedRegions: masked.regions.length,
    ignoredPx: masked.ignoredPixels,
    evaluatedPx: masked.evaluatedPixels,
    removedPct: baseline.diffPixels ? 1 - masked.diffPixels / baseline.diffPixels : 0,
    bugPx: withBug.diffPixels,
    bugRegion: bugRegions[0] ? `${bugRegions[0].x},${bugRegions[0].y} ${bugRegions[0].w}x${bugRegions[0].h}` : 'none',
    bugDetected,
    bugInBounds: inBounds,
    paddedOverlap: masked.regions.filter(r => mask.some(m => overlaps(r, m))).length,
    invariantsOk,
    deterministic
  });
}

const header = [
  '| Site | Baseline px | Baseline % | Masked px | Masked % | Ignored px | Evaluated px | FP removed | Regions base→masked |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
];
const body = rows.map(r =>
  `| ${r.site} | ${n(r.baselinePx)} | ${r.baselinePct} | ${n(r.maskedPx)} | ${r.maskedPct} | ${n(r.ignoredPx)} | ${n(r.evaluatedPx)} | ${pct(r.removedPct)} | ${r.baselineRegions} → ${r.maskedRegions} |`
);

const checkHeader = ['| Site | Masked px | Bug px | Bug region | Detected | Inside injected rect | Invariants | Repeat run identical | Region boxes overlapping a mask edge |', '| --- | ---: | ---: | --- | :---: | :---: | :---: | :---: | ---: |'];
const checkBody = rows.map(r =>
  `| ${r.site} | ${n(r.maskedPx)} | ${n(r.bugPx)} | ${r.bugRegion} | ${r.bugDetected ? 'yes' : 'NO'} | ${r.bugInBounds ? 'yes' : 'no'} | ${r.invariantsOk ? 'ok' : 'BROKEN'} | ${r.deterministic ? 'yes' : 'NO'} | ${r.paddedOverlap} |`
);

process.stdout.write(`${header.join('\n')}\n\n${body.join('\n')}\n\n`);
process.stdout.write(`${checkHeader.join('\n')}\n\n${checkBody.join('\n')}\n`);

const failed = rows.filter(r => !r.bugDetected || !r.bugInBounds || !r.deterministic || !r.invariantsOk);
if (failed.length) {
  process.stderr.write(`\nbenchmark FAILED for: ${failed.map(r => r.site).join(', ')}\n`);
  process.exit(1);
}
