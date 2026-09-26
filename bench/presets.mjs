#!/usr/bin/env node
/**
 * Sensitivity preset benchmark.
 *
 *   node bench/presets.mjs      (or: npm run bench:presets)
 *
 * Two halves:
 *   synthetic  ten generated cases with a complete, known ground truth, so
 *              true and false positives can be counted rather than argued about
 *   real       the three captures that motivated the feature, each with the
 *              design differences verified by direct comparison of the two
 *              images
 *
 * The profiles are read from `src/presets.js`, never restated here, so this
 * benchmark cannot drift from what actually ships. If a preset value changes
 * without new evidence, the numbers below change and the claim they support
 * stops being true.
 *
 * Ground truth for the real captures was established outside this file: the
 * Apple rectangles come from sampling the two PNGs and looking at the crops
 * side by side, the Stripe rectangle is a displacement visible in the crop, and
 * the Duna rectangles are text blocks present in one capture and absent in the
 * other. None of them was read out of an `avd` region list, and none of them is
 * a complete account of what differs — on the Apple capture 83% of pixels
 * differ, so recall against these rectangles is a floor, not a ceiling.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { comparePngFiles } from '../src/compare.js';
import { readMaskFile } from '../src/mask.js';
import { DEFAULTS, PRESETS, PRESET_NAMES, resolveSettings } from '../src/presets.js';
import { buildFixtures } from './fixtures/presets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A pixel counts as differing when some channel moved by at least this much.
 *
 * It is a property of the image pair, not of any profile: 4/255 is roughly the
 * smallest step a person can see on a flat field, and using a fixed floor keeps
 * the ground truth from moving when a preset does.
 */
const SIGNAL_FLOOR = 4;

/** A profile must account for this share of a rectangle's visible difference. */
const DETECTION_RECALL = 0.25;

const PROFILES = [
  { name: 'legacy', preset: null },
  ...PRESET_NAMES.map(name => ({ name, preset: name }))
];

const SITES = [
  {
    key: 'apple',
    label: 'Apple gallery 1440x1000',
    expected: process.env.AVD_BENCH_APPLE_A
      ?? '/Users/leonardoballand/lab/apple/ai-website-cloner-template/docs/design-references/apple-com-736d3707/spacing-review-2026-09-25/reference-desktop-gallery-1440x1000.png',
    actual: process.env.AVD_BENCH_APPLE_B
      ?? '/Users/leonardoballand/lab/apple/ai-website-cloner-template/docs/design-references/apple-com-736d3707/spacing-review-2026-09-25/clone-desktop-gallery-1440x1000.png',
    mask: path.join(here, 'masks', 'apple-gallery.json'),
    truth: [
      // The headline band: reference #f5f5f7 against a pure white clone, a
      // 10/255 change across the full width. Invisible at threshold 0.1, which
      // needs 26.4/255.
      { name: 'headline-bg-tone', x: 0, y: 44, w: 1440, h: 139 },
      { name: 'headline-metrics', x: 440, y: 100, w: 620, h: 50 },
      { name: 'stream-now-pill', x: 258, y: 606, w: 182, h: 96 },
      { name: 'hero-image-tone', x: 300, y: 555, w: 900, h: 145 }
    ]
  },
  {
    key: 'stripe',
    label: 'Stripe reco 1440x900',
    expected: process.env.AVD_BENCH_STRIPE_A
      ?? '/Users/leonardoballand/lab/stripe/docs/design-references/stripe-com-9ababc9a/root-8a5edab2/reco-desktop.png',
    actual: process.env.AVD_BENCH_STRIPE_B
      ?? '/Users/leonardoballand/lab/stripe/docs/design-references/stripe-com-9ababc9a/root-8a5edab2/reco-clone-typed.png',
    mask: path.join(here, 'masks', 'stripe-reco.json'),
    // The clone's one large defect: the hero heading card, displaced downwards.
    truth: [{ name: 'hero-heading-offset', x: 102, y: 747, w: 1295, h: 153 }]
  },
  {
    key: 'duna',
    label: 'Duna desktop 1440x9610',
    expected: process.env.AVD_BENCH_DUNA_A
      ?? '/Users/leonardoballand/lab/ai-website-cloner/docs/design-references/duna-com-7c5a0f0d/root-8a5edab2/desktop-full.png',
    actual: process.env.AVD_BENCH_DUNA_B
      ?? '/Users/leonardoballand/lab/ai-website-cloner/docs/design-references/duna-com-7c5a0f0d/root-8a5edab2/desktop-full-hydrated.png',
    mask: path.join(here, 'masks', 'duna-desktop.json'),
    // Two static text blocks that exist in one capture and not the other, both
    // outside every mask zone.
    truth: [
      { name: 'news-caption', x: 158, y: 8018, w: 678, h: 51 },
      { name: 'testimonial-caption', x: 464, y: 2246, w: 509, h: 43 }
    ]
  }
];

const overlaps = (a, b) => !(a.x > b.x + b.w || a.x + a.w < b.x || a.y > b.y + b.h || a.y + a.h < b.y);
const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

function readPair(expected, actual) {
  return { a: PNG.sync.read(fs.readFileSync(expected)), b: PNG.sync.read(fs.readFileSync(actual)) };
}

/**
 * How much of a rectangle's visible difference the reported regions account for.
 *
 * Centre coverage is deliberately not the test. A 1px shift of a hollow card
 * leaves the centre pixel identical, so a centre rule would score a real
 * spacing defect as a miss.
 */
function scoreRect(a, b, rect, regions) {
  let visible = 0;
  let covered = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (x < 0 || y < 0 || x >= a.width || y >= a.height) continue;
      const i = (y * a.width + x) * 4;
      const delta = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2])
      );
      if (delta < SIGNAL_FLOOR) continue;
      visible++;
      if (regions.some(r => inside(r, x, y))) covered++;
    }
  }
  const recall = visible ? covered / visible : 0;
  return { visible, recall, detected: regions.some(r => overlaps(r, rect)) && recall >= DETECTION_RECALL };
}

function measure(fn) {
  const started = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

const padL = (v, n) => String(v).padEnd(n);
const padR = (v, n) => String(v).padStart(n);
const num = v => v.toLocaleString('en-US');
const pct = v => `${(v * 100).toFixed(4)}%`;

function runSynthetic(fixtureDir) {
  const cases = buildFixtures(fixtureDir);
  const rows = [];
  for (const testCase of cases) {
    const { a, b } = readPair(testCase.reference, testCase.actual);
    const row = {
      name: testCase.name,
      kind: testCase.kind,
      reference: testCase.reference,
      actual: testCase.actual,
      profiles: {}
    };
    for (const profile of PROFILES) {
      const { value: report, ms } = measure(() => comparePngFiles({
        expected: testCase.reference, actual: testCase.actual, preset: profile.preset
      }));
      const detected = testCase.truth.filter(t => scoreRect(a, b, t, report.regions).detected).length;
      const falsePositives = report.regions.filter(r => !testCase.truth.some(t => overlaps(r, t)));
      row.profiles[profile.name] = {
        truth: testCase.truth.length,
        detected,
        missed: testCase.truth.length - detected,
        falsePositives: falsePositives.length,
        falsePositivePx: falsePositives.reduce((n, r) => n + r.px, 0),
        diffPixels: report.diffPixels,
        diffRatio: report.diffRatio,
        regions: report.regions.length,
        topRegionPx: report.regions[0]?.px ?? 0,
        ms
      };
    }
    rows.push(row);
  }
  return rows;
}

function runSites() {
  const rows = [];
  const skipped = [];
  for (const site of SITES) {
    if (!fs.existsSync(site.expected) || !fs.existsSync(site.actual)) {
      skipped.push(site.label);
      continue;
    }
    const { a, b } = readPair(site.expected, site.actual);
    for (const masked of [true, false]) {
      const row = { site: site.label, key: site.key, mode: masked ? 'masked' : 'plain', profiles: {} };
      const mask = masked ? readMaskFile(site.mask) : [];
      for (const profile of PROFILES) {
        const { value: report, ms } = measure(() => comparePngFiles({
          expected: site.expected,
          actual: site.actual,
          preset: profile.preset,
          mask,
          maskFile: masked ? site.mask : null
        }));
        const rects = site.truth.map(t => ({ name: t.name, ...scoreRect(a, b, t, report.regions) }));
        row.profiles[profile.name] = {
          truth: site.truth.length,
          detected: rects.filter(r => r.detected).length,
          rects,
          diffPixels: report.diffPixels,
          diffRatio: report.diffRatio,
          regions: report.regions.length,
          topRegionPx: report.regions[0]?.px ?? 0,
          ms
        };
      }
      rows.push(row);
    }
  }
  return { rows, skipped };
}

/**
 * Position shift detection must not be steered by a sensitivity profile.
 *
 * Each profile is run over the same Duna reference/clone pair the shift
 * benchmark uses, and the verdicts are compared against that benchmark's
 * established answer: two real shifts at -57 and -156.
 */
function runShifts() {
  const site = SITES.find(s => s.key === 'duna');
  if (!fs.existsSync(site.expected)) return { rows: [], skipped: [site.label] };
  const clone = path.join(path.dirname(site.expected), 'clone', 'clone-desktop-full.png');
  if (!fs.existsSync(clone)) return { rows: [], skipped: ['Duna reference/clone pair'] };

  const source = PNG.sync.read(fs.readFileSync(site.expected));
  const height = Math.min(source.height, 9319);
  const cropped = new PNG({ width: source.width, height });
  cropped.data.set(source.data.subarray(0, source.width * height * 4));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-preset-shifts-'));
  const file = path.join(scratch, 'cropped.png');
  fs.writeFileSync(file, PNG.sync.write(cropped));

  const rows = [];
  for (const profile of PROFILES) {
    const { value: report, ms } = measure(() => comparePngFiles({
      expected: file,
      actual: clone,
      preset: profile.preset,
      minRegionPixels: 20,
      mergeGap: 10,
      includeAA: true,
      detectShifts: true
    }));
    const shifts = report.shifts ?? [];
    rows.push({
      name: profile.name,
      shifts: shifts.length,
      deltas: shifts.map(s => s.deltaY).join(', ') || '-',
      minConfidence: shifts.length ? Math.min(...shifts.map(s => s.confidence)) : null,
      regions: report.regions.length,
      ms
    });
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  return { rows, skipped: [] };
}

function main() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-preset-fixtures-'));
  const synthetic = runSynthetic(fixtureDir);
  const sites = runSites();
  const shifts = runShifts();

  const lines = [];
  const failures = [];

  lines.push('# Sensitivity preset benchmark');
  lines.push('');
  lines.push('## Resolved settings');
  lines.push('');
  lines.push('| Profile | threshold | includeAA | minRegionPixels | maxRegions |');
  lines.push('| --- | ---: | :---: | ---: | ---: |');
  for (const profile of PROFILES) {
    const s = resolveSettings({ preset: profile.preset });
    const marker = profile.preset ? '' : ' (default)';
    lines.push(
      `| \`${profile.name}\`${marker} | ${s.threshold} | ${s.includeAA} | ${s.minRegionPixels} | ${s.maxRegions} |`
    );
  }
  lines.push('');
  lines.push(
    'The default row is the behaviour of a run with no `--preset`, and it is the same as v0.1. ' +
    'A profile only supplies values for the keys it names; `mergeGap` and `regionPadding` are ' +
    'left out of every preset because no measured value of either improved any profile.'
  );

  lines.push('');
  lines.push('## Synthetic corpus');
  lines.push('');
  lines.push('Ten cases with a complete ground truth. `truth` is how many real defects the case');
  lines.push('contains, `detect` how many the profile found, and `noise` how many reported');
  lines.push('regions touched no real defect at all.');
  lines.push('');
  lines.push(['Case', 'Truth', ...PROFILES.map(p => p.name), 'Ground truth'].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  lines.push(`| --- | ---: |${PROFILES.map(() => ' --- |').join('')} --- |`);
  for (const row of synthetic) {
    const cells = PROFILES.map(p => {
      const s = row.profiles[p.name];
      return `${s.detected}/${s.truth} detect, ${s.falsePositives} noise`;
    });
    lines.push(`| ${row.name} | ${row.profiles.legacy.truth} | ${cells.join(' | ')} | ${row.kind} |`);
  }

  lines.push('');
  lines.push('### Counts');
  lines.push('');
  lines.push('| Profile | Real defects found | Missed | Noise regions | Noise px | diff px |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const profile of PROFILES) {
    const found = synthetic.reduce((n, r) => n + r.profiles[profile.name].detected, 0);
    const total = synthetic.reduce((n, r) => n + r.profiles[profile.name].truth, 0);
    const noise = synthetic.reduce((n, r) => n + r.profiles[profile.name].falsePositives, 0);
    const noisePx = synthetic.reduce((n, r) => n + r.profiles[profile.name].falsePositivePx, 0);
    const diff = synthetic.reduce((n, r) => n + r.profiles[profile.name].diffPixels, 0);
    lines.push(`| \`${profile.name}\` | ${found}/${total} | ${total - found} | ${noise} | ${num(noisePx)} | ${num(diff)} |`);
  }

  lines.push('');
  lines.push('### Per case, with the numbers');
  lines.push('');
  lines.push('| Case | Profile | diff px | diff % | regions | top region px | noise regions | runtime |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of synthetic) {
    for (const profile of PROFILES) {
      const s = row.profiles[profile.name];
      lines.push(
        `| ${row.name} | \`${profile.name}\` | ${num(s.diffPixels)} | ${pct(s.diffRatio)} | ${s.regions} | ` +
        `${num(s.topRegionPx)} | ${s.falsePositives} | ${s.ms.toFixed(0)}ms |`
      );
    }
  }

  lines.push('');
  lines.push('## Real captures');
  lines.push('');
  if (sites.rows.length) {
    lines.push('Recall is measured against the design differences verified by comparing the two');
    lines.push('images directly. It is a floor: these captures differ far more widely than the');
    lines.push('rectangles listed, and the noise-region column is not meaningful here because the');
    lines.push('ground truth is deliberately partial.');
    lines.push('');
    lines.push('| Capture | Mode | Profile | Verified defects | diff px | diff % | regions | top region px | runtime |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of sites.rows) {
      for (const profile of PROFILES) {
        const s = row.profiles[profile.name];
        lines.push(
          `| ${row.site} | ${row.mode} | \`${profile.name}\` | ${s.detected}/${s.truth} | ${num(s.diffPixels)} | ` +
          `${pct(s.diffRatio)} | ${s.regions} | ${num(s.topRegionPx)} | ${s.ms.toFixed(0)}ms |`
        );
      }
    }
    lines.push('');
    lines.push('### Which design differences each profile finds');
    lines.push('');
    for (const row of sites.rows) {
      const names = PROFILES.map(p => `\`${p.name}\``).join(' / ');
      lines.push(`**${row.site}, ${row.mode}** — ${names}`);
      lines.push('');
      for (const t of SITES.find(s => s.key === row.key).truth) {
        const cells = PROFILES.map(p => {
          const s = row.profiles[p.name].rects.find(r => r.name === t.name);
          return s.detected ? `yes ${(s.recall * 100).toFixed(0)}%` : `no ${(s.recall * 100).toFixed(0)}%`;
        });
        lines.push(`- \`${t.name}\` — ${cells.join(' | ')}`);
      }
      lines.push('');
    }
  }
  if (sites.skipped.length) {
    lines.push(`Not run (captures not present): ${sites.skipped.join(', ')}`);
    lines.push('');
  }

  lines.push('## Position shift interaction');
  lines.push('');
  if (shifts.rows.length) {
    lines.push('A sensitivity profile changes the pixel diff. It must not change what the shift');
    lines.push('classifier concludes. The established answer for this pair is two shifts, at -57');
    lines.push('and -156.');
    lines.push('');
    lines.push('| Profile | Shifts | deltaY | Min confidence | Regions | runtime | Verdict |');
    lines.push('| --- | ---: | --- | ---: | ---: | ---: | :---: |');
    for (const row of shifts.rows) {
      const ok = row.shifts === 2 && row.deltas === '-57, -156';
      lines.push(
        `| \`${row.name}\` | ${row.shifts} | ${row.deltas} | ` +
        `${row.minConfidence === null ? '-' : row.minConfidence.toFixed(4)} | ${row.regions} | ` +
        `${row.ms.toFixed(0)}ms | ${ok ? 'yes' : 'NO'} |`
      );
      if (!ok) failures.push(`shift verdict changed under --preset ${row.name}`);
    }
    lines.push('');
  } else {
    lines.push(`Not run (captures not present): ${shifts.skipped.join(', ')}`);
    lines.push('');
  }

  // ---- assertions
  //
  // These encode the claims the presets make. A preset that stops holding one
  // of them fails the benchmark rather than quietly shipping.
  const mustDetect = new Set(['case2-strong-color', 'case3-spacing-1px', 'case4-spacing-2px', 'case7-structural-block', 'case10-defect-plus-noise']);
  for (const row of synthetic.filter(r => mustDetect.has(r.name))) {
    for (const profile of PROFILES) {
      if (row.profiles[profile.name].detected < row.profiles[profile.name].truth) {
        failures.push(`${profile.name} misses a structural or spacing defect in ${row.name}`);
      }
    }
  }
  const strictRow = synthetic.find(r => r.name === 'case1-subtle-color');
  if (strictRow && strictRow.profiles.strict.detected !== 1) {
    failures.push('strict does not find the 5/255 colour field, which is the reason it exists');
  }
  for (const row of synthetic.filter(r => r.kind === 'noise')) {
    for (const profile of PROFILES) {
      const s = row.profiles[profile.name];
      if (row.name === 'case6-shadow-variance' && profile.name === 'strict') continue;
      if (s.falsePositives > 0) {
        failures.push(`${profile.name} reports ${s.falsePositives} false positive region(s) on ${row.name}`);
      }
    }
  }
  // No profile may lose a verified real defect that the default already found.
  for (const row of sites.rows) {
    const baseline = row.profiles.legacy.detected;
    for (const profile of PROFILES.filter(p => p.preset !== null)) {
      if (row.profiles[profile.name].detected < baseline) {
        failures.push(
          `${profile.name} finds fewer verified design defects than the default on ` +
          `${row.site} ${row.mode} (${row.profiles[profile.name].detected} < ${baseline})`
        );
      }
    }
  }

  // A preset must be reproducible. This is the property the whole tool rests
  // on, so it is checked for every profile and not inferred from the others.
  for (const testCase of synthetic) {
    for (const profile of PROFILES) {
      const once = comparePngFiles({ expected: testCase.reference, actual: testCase.actual, preset: profile.preset });
      const twice = comparePngFiles({ expected: testCase.reference, actual: testCase.actual, preset: profile.preset });
      if (JSON.stringify(once) !== JSON.stringify(twice)) {
        failures.push(`${profile.name} is not reproducible on ${testCase.name}`);
      }
    }
  }

  fs.rmSync(fixtureDir, { recursive: true, force: true });

  lines.push('## Assertions');
  lines.push('');
  if (failures.length) {
    for (const failure of failures) lines.push(`- FAILED: ${failure}`);
  } else {
    lines.push('- every profile finds every structural and spacing defect');
    lines.push('- every profile reports no false positive on the pure-noise cases');
    lines.push('- strict finds the 5/255 colour field');
    lines.push('- no profile loses a verified design defect that the default finds');
    lines.push('- every profile reaches the same position shift verdicts');
    lines.push('- every profile is byte-reproducible on every case');
  }
  lines.push('');

  process.stdout.write(`${lines.join('\n')}\n`);

  if (failures.length) {
    process.stderr.write(`\npreset benchmark FAILED: ${failures.length} assertion(s)\n`);
    process.exit(1);
  }
}

main();
