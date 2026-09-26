import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src', 'cli.js');

function png(file, dark = false) {
  const p = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < p.data.length; i += 4) {
    p.data[i] = dark ? 0 : 255;
    p.data[i + 1] = dark ? 0 : 255;
    p.data[i + 2] = dark ? 0 : 255;
    p.data[i + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(p));
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('--help and --version work', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /avd compare/);

  const version = run(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^0\.1\.0\n$/);
});

test('compare supports human and JSON output', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-cli-'));
  const expected = path.join(d, 'expected.png');
  const actual = path.join(d, 'actual.png');
  png(expected, false);
  png(actual, true);

  const human = run(['compare', expected, actual, '--merge-gap', '0', '--region-padding', '0']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Match:/);
  assert.match(human.stdout, /Regions: 1/);

  const json = run([expected, actual, '--json', '--merge-gap', '0', '--region-padding', '0']);
  assert.equal(json.status, 0);
  const report = JSON.parse(json.stdout);
  assert.equal(report.diffPixels, 16);
  assert.equal(report.regions.length, 1);
});

test('--fail-above returns exit code 2 after a completed comparison', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-cli-'));
  const expected = path.join(d, 'expected.png');
  const actual = path.join(d, 'actual.png');
  png(expected, false);
  png(actual, true);

  const result = run(['compare', expected, actual, '--json', '--fail-above', '0.1']);
  assert.equal(result.status, 2);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
});

test('--mask excludes regions and reports them in JSON', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-cli-'));
  const expected = path.join(d, 'expected.png');
  const actual = path.join(d, 'actual.png');
  const mask = path.join(d, 'mask.json');
  png(expected, false);
  png(actual, true);
  fs.writeFileSync(mask, JSON.stringify({ regions: [{ name: 'testimonial-carousel', x: 0, y: 0, w: 4, h: 2 }] }));

  const human = run(['compare', expected, actual, '--mask', mask, '--merge-gap', '0', '--region-padding', '0']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Ignored: 1 region\(s\), 8px excluded \(8px evaluated\)/);
  assert.match(human.stdout, /~ testimonial-carousel  x=0 y=0  4x2/);

  const json = run(['compare', expected, actual, '--mask', mask, '--json', '--merge-gap', '0', '--region-padding', '0']);
  const report = JSON.parse(json.stdout);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.diffPixels, 8);
  assert.equal(report.ignoredPixels, 8);
  assert.equal(report.evaluatedPixels, 8);
  assert.deepEqual(report.ignoredRegions, [{ name: 'testimonial-carousel', x: 0, y: 0, w: 4, h: 2 }]);
  assert.equal(report.settings.mask, mask);
});

test('--ignore is repeatable and merges with --mask', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-cli-'));
  const expected = path.join(d, 'expected.png');
  const actual = path.join(d, 'actual.png');
  const mask = path.join(d, 'mask.json');
  png(expected, false);
  png(actual, true);
  fs.writeFileSync(mask, JSON.stringify({ regions: [{ name: 'from-file', x: 0, y: 0, w: 4, h: 1 }] }));

  const result = run([
    'compare', expected, actual, '--json',
    '--mask', mask,
    '--ignore', '0,1,4,1',
    '--ignore', '0,2,4,1'
  ]);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.ignoredRegions, [
    { name: 'from-file', x: 0, y: 0, w: 4, h: 1 },
    { name: 'inline-1', x: 0, y: 1, w: 4, h: 1 },
    { name: 'inline-2', x: 0, y: 2, w: 4, h: 1 }
  ]);
  assert.equal(report.ignoredPixels, 12);
  assert.equal(report.evaluatedPixels, 4);
  assert.equal(report.diffPixels, 4);
});

test('mask errors exit 1 with a clear message', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-cli-'));
  const expected = path.join(d, 'expected.png');
  const actual = path.join(d, 'actual.png');
  png(expected, false);
  png(actual, true);

  const missing = run(['compare', expected, actual, '--mask', path.join(d, 'nope.json')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read mask file/);

  const badSpec = run(['compare', expected, actual, '--ignore', '1,2,3']);
  assert.equal(badSpec.status, 1);
  assert.match(badSpec.stderr, /--ignore expects "x,y,w,h"/);

  const noValue = run(['compare', expected, actual, '--ignore']);
  assert.equal(noValue.status, 1);
  assert.match(noValue.stderr, /missing value for --ignore/);
});

test('--help documents the mask flags', () => {
  const help = run(['--help']);
  assert.match(help.stdout, /--mask <file\.json>/);
  assert.match(help.stdout, /--ignore <x,y,w,h>/);
});
