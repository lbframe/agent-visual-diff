import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { comparePngFiles } from '../src/compare.js';
import { buildFixtures } from './fixtures/shifts.mjs';

/**
 * Position shift benchmark.
 *
 * Two halves:
 *   synthetic  eight generated cases with a known answer, including the cases
 *              that must NOT be called shifts
 *   real       the existing Duna, Stripe and Apple captures
 *
 * A case passes only when the detector's answer matches the expected answer,
 * including "no shift" for the negative cases. The negative cases are the ones
 * that matter: a detector that reports a shift for everything is worthless, and
 * a benchmark that only scores positives cannot see that.
 */

const FIXTURES = path.join(os.tmpdir(), `avd-shift-fixtures-${process.pid}`);

const MAX_DELTA_ERROR = 2;
const MIN_CONFIDENCE = 0.5;

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function left(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function measure(fn) {
  const started = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

/** Load the real captures, or report that they are unavailable. */
function realSites() {
  const duna = process.env.AVD_BENCH_DUNA_ROOT
    ?? path.join(
      os.homedir(),
      'lab/ai-website-cloner/docs/design-references/duna-com-7c5a0f0d/root-8a5edab2'
    );
  const stripe = process.env.AVD_BENCH_STRIPE_ROOT
    ?? path.join(os.homedir(), 'lab/stripe/docs/design-references/stripe-com-9ababc9a/root-8a5edab2');
  const apple = process.env.AVD_BENCH_APPLE_ROOT
    ?? path.join(
      os.homedir(),
      'lab/apple/ai-website-cloner-template/docs/design-references/apple-com-736d3707/spacing-review-2026-09-25'
    );

  return [
    {
      key: 'duna',
      label: 'Duna desktop',
      reference: path.join(duna, 'desktop-full.png'),
      actual: path.join(duna, 'clone/clone-desktop-full.png'),
      // Expected deltas measured independently from row-by-row similarity
      // sweeps, not from this detector. See bench/README.md.
      expected: [{ y0: 2685, y1: 3711, deltaY: -57 }, { y0: 8809, y1: 9319, deltaY: -156 }],
      note: 'reference/clone full-page pair, cropped to a common height',
      crop: true
    },
    {
      key: 'stripe',
      label: 'Stripe reco',
      reference: path.join(stripe, 'reco-desktop.png'),
      actual: path.join(stripe, 'reco-clone-typed.png'),
      expected: [],
      note: 'large real heading defect must stay a pixel diff'
    },
    {
      key: 'apple',
      label: 'Apple gallery',
      reference: path.join(apple, 'reference-desktop-gallery-1440x1000.png'),
      actual: path.join(apple, 'clone-desktop-gallery-1440x1000.png'),
      expected: [],
      note: 'colour/logo/spacing changes must stay pixel diffs'
    }
  ];
}

/**
 * The Duna captures are full-page and differ in total length (9610 vs 9319), so
 * avd cannot compare them as they stand. Truncating the taller one to a common
 * height is exactly the situation a fixed-height capture produces, and it is
 * what exposes the downstream displacement the feature is meant to explain.
 */
function cropToHeight(file, height) {
  const { PNG } = globalThis.__avdPng;
  const source = PNG.sync.read(fs.readFileSync(file));
  if (source.height <= height) return file;
  const out = new PNG({ width: source.width, height });
  out.data.set(source.data.subarray(0, source.width * height * 4));
  const target = path.join(FIXTURES, `cropped-${path.basename(file)}-${height}.png`);
  fs.writeFileSync(target, PNG.sync.write(out));
  return target;
}

function verdictRow(site, report, expected, runtime) {
  const shifts = report.shifts ?? [];
  const unmatched = shifts.filter(
    (s) => !expected.some((e) => s.y + s.h > e.y0 && s.y < e.y1 && Math.abs(s.deltaY - e.deltaY) <= MAX_DELTA_ERROR)
  );
  const missed = expected.filter((e) => !shifts.some((s) => s.y + s.h > e.y0 && s.y < e.y1 && Math.abs(s.deltaY - e.deltaY) <= MAX_DELTA_ERROR));
  const lowConfidence = shifts.filter((s) => s.confidence < MIN_CONFIDENCE);

  const ok = expected.length === 0 ? shifts.length === 0 : unmatched.length === 0 && missed.length === 0;
  return {
    site,
    shifts: shifts.length,
    expected: expected.length,
    deltas: shifts.map((s) => s.deltaY).join(', ') || '-',
    confidence: shifts.length ? Math.min(...shifts.map((s) => s.confidence)) : '-',
    runtime: `${runtime.toFixed(0)}ms`,
    regions: report.regions.length,
    ok: ok && lowConfidence.length === 0
  };
}

async function main() {
  const { PNG } = await import('pngjs');
  globalThis.__avdPng = { PNG };

  const cases = buildFixtures(FIXTURES);
  const synthetic = [];
  for (const testCase of cases) {
    const { value: report, ms } = measure(() => comparePngFiles({
      expected: testCase.reference,
      actual: testCase.actual,
      minRegionPixels: 20,
      detectShifts: true,
      mask: testCase.mask ?? []
    }));

    const shifts = report.shifts ?? [];
    const want = testCase.expected;

    if (want) {
      const best = shifts.reduce(
        (acc, s) => (acc === null || Math.abs(s.deltaY - want.deltaY) < Math.abs(acc.deltaY - want.deltaY) ? s : acc),
        null
      );
      const dyError = best ? Math.abs(best.deltaY - want.deltaY) : null;
      const dxError = best ? Math.abs(best.deltaX - want.deltaX) : null;
      synthetic.push({
        name: testCase.name,
        expected: `${want.deltaX},${want.deltaY}`,
        detected: best ? `${best.deltaX},${best.deltaY}` : 'none',
        error: dyError === null ? '-' : `${dyError}px`,
        confidence: best ? best.confidence : '-',
        runtime: `${ms.toFixed(0)}ms`,
        ok: best !== null && dyError <= MAX_DELTA_ERROR && dxError <= MAX_DELTA_ERROR && best.confidence >= MIN_CONFIDENCE
      });
    } else {
      synthetic.push({
        name: testCase.name,
        expected: 'none',
        detected: shifts.length ? shifts.map((s) => `${s.deltaX},${s.deltaY}`).join(' ') : 'none',
        error: '-',
        confidence: shifts.length ? Math.max(...shifts.map((s) => s.confidence)) : '-',
        runtime: `${ms.toFixed(0)}ms`,
        ok: shifts.length === 0
      });
    }
  }

  const real = [];
  const skipped = [];
  for (const site of realSites()) {
    if (!fs.existsSync(site.reference) || !fs.existsSync(site.actual)) {
      skipped.push(site.label);
      continue;
    }
    const reference = site.crop ? cropToHeight(site.reference, Math.min(9319, 9319)) : site.reference;
    const { value: report, ms } = measure(() => comparePngFiles({
      expected: reference,
      actual: site.actual,
      minRegionPixels: 20,
      mergeGap: 10,
      includeAA: true,
      detectShifts: true,
      mask: []
    }));
    real.push(verdictRow(site.label, report, site.expected, ms));
  }

  const lines = [];
  lines.push('# Position shift benchmark');
  lines.push('');
  lines.push('## Synthetic cases');
  lines.push('');
  lines.push(
    `${left('Case', 26)} ${left('Expected', 10)} ${left('Detected', 12)} ${left('Delta error', 12)} ` +
    `${left('Confidence', 12)} ${left('Runtime', 10)} Correct`
  );
  lines.push('-'.repeat(96));
  for (const row of synthetic) {
    lines.push(
      `${left(row.name, 26)} ${left(row.expected, 10)} ${left(row.detected, 12)} ${left(row.error, 12)} ` +
      `${left(row.confidence, 12)} ${left(row.runtime, 10)} ${row.ok ? 'yes' : 'NO'}`
    );
  }
  lines.push('');
  lines.push('## Real captures');
  lines.push('');
  if (real.length) {
    lines.push(
      `${left('Capture', 18)} ${left('Shifts', 8)} ${left('Expected', 9)} ${left('deltaY', 16)} ` +
      `${left('Min conf', 9)} ${left('Runtime', 10)} ${left('Regions', 8)} Correct`
    );
    lines.push('-'.repeat(88));
    for (const row of real) {
      lines.push(
        `${left(row.site, 18)} ${left(row.shifts, 8)} ${left(row.expected, 9)} ${left(row.deltas, 16)} ` +
        `${left(row.confidence, 9)} ${left(row.runtime, 10)} ${left(row.regions, 8)} ${row.ok ? 'yes' : 'NO'}`
      );
    }
  }
  if (skipped.length) {
    lines.push('');
    lines.push(`Not run (captures not present): ${skipped.join(', ')}`);
  }
  lines.push('');

  const text = lines.join('\n');
  process.stdout.write(text);

  const failed = [...synthetic, ...real].filter((row) => !row.ok);
  fs.rmSync(FIXTURES, { recursive: true, force: true });

  if (failed.length) {
    process.stderr.write(`\nshift benchmark FAILED for: ${failed.map((row) => row.name ?? row.site).join(', ')}\n`);
    process.exit(1);
  }
}

await main();
