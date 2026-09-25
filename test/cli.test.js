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
