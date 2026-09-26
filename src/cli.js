#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = `agent-visual-diff (avd) v${pkg.version}

Deterministic PNG visual regression for humans, CI, and coding agents.

Usage:
  avd compare <expected.png> <actual.png> [options]
  avd <expected.png> <actual.png> [options]
  agent-visual-diff compare <expected.png> <actual.png> [options]

Output modes:
  default                       human-readable summary
  --json                        structured JSON on stdout
  --compact                     compact single-line JSON (implies --json)

Artifacts:
  --out <report.json>           also write JSON report to a file
  --diff <diff.png>             write pixel diff PNG
  --section <name>              stable logical screen/section name

Comparison:
  --threshold <0..1>            pixelmatch threshold (default: 0.1)
  --include-aa                  include anti-aliased pixels
  --min-region-pixels <n>       discard tiny components (default: 2)
  --merge-gap <px>              merge nearby components (default: 6)
  --region-padding <px>         expand final boxes (default: 2)
  --max-regions <n>             cap reported regions (default: 50)

Masks (exclude known-dynamic or irrelevant regions from the comparison):
  --mask <file.json>            read regions from a JSON mask file
  --ignore <x,y,w,h>            ignore one inline region, repeatable

  Mask file format:
    { "regions": [ { "name": "testimonial-carousel",
                     "x": 120, "y": 2100, "w": 1200, "h": 600 } ] }

  Masked pixels are excluded from diffPixels, from the detected regions, and
  from the diffRatio denominator. Excluded zones are grayed in the diff PNG.

  Regions are clamped to the viewport; a zone entirely outside it is an error.

Position shifts (opt-in, off by default):
  --detect-shifts               report content that moved instead of changed

  Adds a top-level "shifts" array. Each entry is a run of content that is
  visually correct but displaced by a constant offset, which usually means an
  upstream section has the wrong height:

    { "id": 1, "type": "position-shift", "x": 0, "y": 2685,
      "w": 1440, "h": 1026, "deltaX": 0, "deltaY": -57, "confidence": 0.8385 }

  The classifier is deliberately conservative: a shift is reported only when
  translation explains the region better than leaving it in place, by a
  decisive and repeatable margin across neighbouring bands. Anything ambiguous
  stays a normal pixel-diff region. Treat a shift as evidence of an upstream
  layout cause, not as proof of one, and do not fix the moved regions one by one.

CI:
  --fail-above <ratio>          exit 2 when diffRatio exceeds ratio
                                example: 0.01 = more than 1% changed

Other:
  -h, --help                    show help
  -v, --version                 show version

Exit codes:
  0  comparison completed and threshold passed
  1  usage/runtime error
  2  comparison completed but --fail-above threshold failed
`;

function die(message, code = 1) {
  if (message) process.stderr.write(`avd: ${message}\n\n`);
  if (code === 1) process.stderr.write(HELP);
  process.exit(code);
}

function parseNumber(name, value, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return n;
}

function parse(argv) {
  const args = [...argv];
  const options = {};

  if (args[0] === '-h' || args[0] === '--help') return { action: 'help' };
  if (args[0] === '-v' || args[0] === '--version') return { action: 'version' };
  if (args[0] === 'compare') args.shift();

  const positional = [];
  const booleanFlags = new Set(['--include-aa', '--json', '--compact', '--detect-shifts']);
  const multiValueFlags = new Set(['--ignore']);
  const valueFlags = new Set([
    '--out', '--diff', '--section', '--threshold', '--min-region-pixels',
    '--merge-gap', '--region-padding', '--max-regions', '--fail-above', '--mask'
  ]);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') return { action: 'help' };
    if (a === '-v' || a === '--version') return { action: 'version' };

    if (booleanFlags.has(a)) {
      options[a.slice(2)] = true;
      continue;
    }

    if (multiValueFlags.has(a)) {
      const v = args[++i];
      if (v == null || v.startsWith('--')) throw new Error(`missing value for ${a}`);
      (options[a.slice(2)] ??= []).push(v);
      continue;
    }

    if (valueFlags.has(a)) {
      const v = args[++i];
      if (v == null || v.startsWith('--')) throw new Error(`missing value for ${a}`);
      options[a.slice(2)] = v;
      continue;
    }

    if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    positional.push(a);
  }

  if (positional.length !== 2) {
    throw new Error('compare requires exactly <expected.png> and <actual.png>');
  }

  return { action: 'compare', expected: positional[0], actual: positional[1], options };
}

function humanSummary(report, outPath) {
  const lines = [
    `Match: ${report.match}`,
    `Diff pixels: ${report.diffPixels.toLocaleString('en-US')} (${(report.diffRatio * 100).toFixed(4)}%)`,
    `Regions: ${report.regions.length}`
  ];

  if (report.ignoredRegions.length) {
    lines.push(
      `Ignored: ${report.ignoredRegions.length} region(s), ` +
      `${report.ignoredPixels.toLocaleString('en-US')}px excluded ` +
      `(${report.evaluatedPixels.toLocaleString('en-US')}px evaluated)`
    );
  }

  if (report.shifts?.length) {
    lines.push(
      `Position shifts: ${report.shifts.length} (look for an upstream height or spacing cause, ` +
      'not one fix per region)'
    );
  }

  if (report.regions.length) {
    lines.push('');
    for (const r of report.regions.slice(0, 10)) {
      lines.push(`#${r.id}  x=${r.x} y=${r.y}  ${r.w}x${r.h}  ${r.px}px`);
    }
    if (report.regions.length > 10) lines.push(`… ${report.regions.length - 10} more region(s)`);
  }

  if (report.shifts?.length) {
    lines.push('');
    for (const s of report.shifts) {
      lines.push(`^${s.id}  y=${s.y}  ${s.w}x${s.h}  dx=${s.deltaX} dy=${s.deltaY}  conf=${s.confidence}`);
    }
  }

  if (report.ignoredRegions.length) {
    lines.push('');
    for (const r of report.ignoredRegions.slice(0, 10)) {
      lines.push(`~ ${r.name}  x=${r.x} y=${r.y}  ${r.w}x${r.h}`);
    }
    if (report.ignoredRegions.length > 10) lines.push(`… ${report.ignoredRegions.length - 10} more ignored region(s)`);
  }

  if (outPath || report.diffPng) {
    lines.push('');
    if (outPath) lines.push(`Report: ${outPath}`);
    if (report.diffPng) lines.push(`Diff:   ${report.diffPng}`);
  }

  return `${lines.join('\n')}\n`;
}

try {
  const parsed = parse(process.argv.slice(2));

  if (parsed.action === 'help') {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed.action === 'version') {
    process.stdout.write(`${pkg.version}\n`);
    process.exit(0);
  }

  const a = parsed.options;
  const compact = Boolean(a.compact);
  const jsonMode = Boolean(a.json || compact);

  const threshold = a.threshold == null ? 0.1 : parseNumber('--threshold', a.threshold, { min: 0, max: 1 });
  const minRegionPixels = a['min-region-pixels'] == null ? 2 : parseNumber('--min-region-pixels', a['min-region-pixels'], { min: 1, integer: true });
  const mergeGap = a['merge-gap'] == null ? 6 : parseNumber('--merge-gap', a['merge-gap'], { min: 0, integer: true });
  const regionPadding = a['region-padding'] == null ? 2 : parseNumber('--region-padding', a['region-padding'], { min: 0, integer: true });
  const maxRegions = a['max-regions'] == null ? 50 : parseNumber('--max-regions', a['max-regions'], { min: 1, integer: true });
  const failAbove = a['fail-above'] == null ? null : parseNumber('--fail-above', a['fail-above'], { min: 0, max: 1 });

  const { comparePngFiles } = await import('./compare.js');
  const { readMaskFile, parseIgnoreSpec } = await import('./mask.js');

  const mask = a.mask ? readMaskFile(a.mask) : [];
  const ignore = (a.ignore ?? []).map((spec, index) => parseIgnoreSpec(spec, `inline-${index + 1}`));

  const report = comparePngFiles({
    expected: parsed.expected,
    actual: parsed.actual,
    diffPng: a.diff,
    section: a.section,
    threshold,
    includeAA: Boolean(a['include-aa']),
    minRegionPixels,
    mergeGap,
    regionPadding,
    maxRegions,
    mask,
    ignore,
    maskFile: a.mask ?? null,
    detectShifts: Boolean(a['detect-shifts'])
  });

  const json = `${JSON.stringify(report, null, compact ? 0 : 2)}\n`;
  if (a.out) {
    fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
    fs.writeFileSync(a.out, json);
  }

  process.stdout.write(jsonMode ? json : humanSummary(report, a.out));

  if (failAbove != null && report.diffRatio > failAbove) process.exitCode = 2;
} catch (err) {
  die(err.message);
}
