import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { comparePngFiles } from '../src/compare.js';
import { DEFAULTS, PRESETS, PRESET_NAMES, assertPresetName, resolveSettings } from '../src/presets.js';
import { buildFixtures } from '../bench/fixtures/presets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src', 'cli.js');

function blank(file, fill = 250) {
  const p = new PNG({ width: 60, height: 40 });
  for (let i = 0; i < p.data.length; i += 4) {
    p.data[i] = fill; p.data[i + 1] = fill; p.data[i + 2] = fill; p.data[i + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(p));
}

function patch(file, x, y, w, h, shade) {
  const p = PNG.sync.read(fs.readFileSync(file));
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      const k = (j * p.width + i) * 4;
      p.data[k] = shade; p.data[k + 1] = shade; p.data[k + 2] = shade;
    }
  }
  fs.writeFileSync(file, PNG.sync.write(p));
}

function pair(dir) {
  const expected = path.join(dir, 'a.png');
  const actual = path.join(dir, 'b.png');
  blank(expected);
  blank(actual);
  patch(actual, 10, 10, 20, 20, 0);
  return { expected, actual };
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

// ---------------------------------------------------------------- resolution

test('the documented preset names are exactly strict, balanced and noisy', () => {
  assert.deepEqual(PRESET_NAMES, ['strict', 'balanced', 'noisy']);
  for (const name of PRESET_NAMES) assert.equal(assertPresetName(name), name);
});

test('an unknown preset name is rejected and the message lists the valid ones', () => {
  for (const bad of ['ultra', 'STRICT', 'strict ', '', 'balanced\n']) {
    assert.throws(() => assertPresetName(bad), /unknown preset/);
  }
  assert.throws(() => assertPresetName('ultra'), /strict, balanced, noisy/);
  assert.throws(() => assertPresetName(undefined), /unknown preset/);
  // A prototype key must not resolve to a preset.
  assert.throws(() => assertPresetName('toString'), /unknown preset/);
});

test('a preset resolves every comparison setting and inherits the rest', () => {
  for (const name of PRESET_NAMES) {
    const s = resolveSettings({ preset: name });
    for (const key of ['threshold', 'includeAA', 'minRegionPixels', 'mergeGap', 'regionPadding', 'maxRegions']) {
      assert.notEqual(s[key], undefined, `${name} left ${key} unresolved`);
    }
  }
  // balanced and noisy deliberately do not pin maxRegions.
  assert.equal(resolveSettings({ preset: 'balanced' }).maxRegions, DEFAULTS.maxRegions);
  assert.equal(resolveSettings({ preset: 'strict' }).maxRegions, 100);
});

test('with no preset the resolved settings are exactly the v0.1 defaults', () => {
  assert.deepEqual(resolveSettings(), DEFAULTS);
  assert.deepEqual(resolveSettings({ preset: null }), DEFAULTS);
  assert.deepEqual(resolveSettings({ threshold: undefined }), DEFAULTS);
});

test('the shipped preset values are the ones the benchmark justifies', () => {
  // These are asserted so that editing a value without re-running
  // `npm run bench:presets` fails the suite instead of silently changing what
  // the documentation claims.
  assert.deepEqual(PRESETS.strict, { threshold: 0.01, includeAA: true, minRegionPixels: 20, maxRegions: 100 });
  assert.deepEqual(PRESETS.balanced, { threshold: 0.03, includeAA: true, minRegionPixels: 20 });
  assert.deepEqual(PRESETS.noisy, { threshold: 0.1, includeAA: true, minRegionPixels: 20 });
  // No preset may pin a setting the benchmark never justified.
  for (const name of PRESET_NAMES) {
    assert.equal(PRESETS[name].mergeGap, undefined, `${name} pins mergeGap`);
    assert.equal(PRESETS[name].regionPadding, undefined, `${name} pins regionPadding`);
  }
});

// ----------------------------------------------------------------- precedence

test('an explicit option wins over the preset on the programmatic API', () => {
  assert.equal(resolveSettings({ preset: 'balanced', threshold: 0.05 }).threshold, 0.05);
  assert.equal(resolveSettings({ preset: 'balanced' }).threshold, 0.03);
  assert.equal(resolveSettings({ preset: 'strict', minRegionPixels: 2 }).minRegionPixels, 2);
  assert.equal(resolveSettings({ preset: 'strict', maxRegions: 7 }).maxRegions, 7);
  // includeAA is a boolean, and `false` is a value the caller meant.
  assert.equal(resolveSettings({ preset: 'noisy', includeAA: false }).includeAA, false);
  assert.equal(resolveSettings({ preset: 'noisy' }).includeAA, true);
  // 0 is falsy but not absent.
  assert.equal(resolveSettings({ preset: 'balanced', threshold: 0 }).threshold, 0);
  // Untouched keys still come from the preset.
  assert.equal(resolveSettings({ preset: 'balanced', threshold: 0.05 }).minRegionPixels, 20);
});

test('an explicit option wins over the preset in a real comparison', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-preset-'));
  const expected = path.join(d, 'a.png');
  const actual = path.join(d, 'b.png');
  blank(expected, 100);
  blank(actual, 100);
  // A 5/255 change. pixelmatch needs delta > 264 * threshold, so it is below
  // balanced's 0.03 and above the 0.01 that strict uses. That makes the pixel
  // count a direct readout of which threshold actually ran.
  patch(actual, 10, 10, 20, 20, 105);

  const balanced = comparePngFiles({ expected, actual, preset: 'balanced' });
  assert.equal(balanced.settings.threshold, 0.03);
  assert.equal(balanced.diffPixels, 0);

  // Overriding downwards past the preset's own value must take effect.
  const lowered = comparePngFiles({ expected, actual, preset: 'balanced', threshold: 0.01 });
  assert.equal(lowered.settings.threshold, 0.01);
  assert.equal(lowered.settings.minRegionPixels, 20);
  assert.equal(lowered.diffPixels, 400);

  // And so must overriding upwards.
  const raised = comparePngFiles({ expected, actual, preset: 'strict', threshold: 0.5 });
  assert.equal(raised.settings.threshold, 0.5);
  assert.equal(raised.diffPixels, 0);
  // The keys the override did not mention still come from the preset.
  assert.equal(raised.settings.includeAA, true);
  assert.equal(raised.settings.maxRegions, 100);

  assert.equal(comparePngFiles({ expected, actual, preset: 'strict' }).diffPixels, 400);
});

test('the CLI forwards only the flags that were typed', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-preset-'));
  const { expected, actual } = pair(d);

  const presetOnly = JSON.parse(run(['compare', expected, actual, '--json', '--preset', 'balanced']).stdout);
  assert.equal(presetOnly.settings.threshold, 0.03);
  assert.equal(presetOnly.settings.minRegionPixels, 20);

  const overridden = JSON.parse(run([
    'compare', expected, actual, '--json', '--preset', 'balanced', '--threshold', '0.05'
  ]).stdout);
  assert.equal(overridden.settings.threshold, 0.05);
  assert.equal(overridden.settings.minRegionPixels, 20);
  assert.equal(overridden.preset, 'balanced');

  // Options given without a preset still behave as they always did.
  const bare = JSON.parse(run(['compare', expected, actual, '--json', '--threshold', '0.2']).stdout);
  assert.equal(bare.settings.threshold, 0.2);
  assert.equal(bare.settings.minRegionPixels, DEFAULTS.minRegionPixels);
});

// ------------------------------------------------------------ json contract

test('the report names the preset and the settings that actually ran', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-preset-'));
  const { expected, actual } = pair(d);

  for (const name of PRESET_NAMES) {
    const report = comparePngFiles({ expected, actual, preset: name });
    assert.equal(report.preset, name);
    assert.deepEqual(report.settings, {
      threshold: PRESETS[name].threshold ?? DEFAULTS.threshold,
      includeAA: PRESETS[name].includeAA,
      minRegionPixels: PRESETS[name].minRegionPixels,
      mergeGap: DEFAULTS.mergeGap,
      regionPadding: DEFAULTS.regionPadding,
      maxRegions: PRESETS[name].maxRegions ?? DEFAULTS.maxRegions,
      mask: null
    });
  }
});

test('a run without a preset omits the preset key entirely', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-preset-'));
  const { expected, actual } = pair(d);

  const report = comparePngFiles({ expected, actual });
  assert.equal('preset' in report, false);
  assert.equal(JSON.stringify(report).includes('"preset"'), false);
  assert.deepEqual(report.settings, { ...DEFAULTS, mask: null });
});

test('an invalid preset fails on the API and exits 1 on the CLI', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-preset-'));
  const { expected, actual } = pair(d);

  assert.throws(
    () => comparePngFiles({ expected, actual, preset: 'ultra' }),
    /unknown preset/
  );

  const result = run(['compare', expected, actual, '--preset', 'ultra']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown preset: "ultra"/);
  assert.match(result.stderr, /strict, balanced, noisy/);

  const noValue = run(['compare', expected, actual, '--preset']);
  assert.equal(noValue.status, 1);
  assert.match(noValue.stderr, /missing value for --preset/);
});

test('the CLI help documents the presets and the override rule', () => {
  const help = run(['--help']).stdout;
  assert.match(help, /--preset <name>/);
  assert.match(help, /strict, balanced, noisy/);
  assert.match(help, /An explicit option always wins/);
});

// ------------------------------------------------------------ compatibility

test('a run without a preset is byte-identical to passing the defaults', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-preset-'));
  const { expected, actual } = pair(d);

  const implicit = JSON.stringify(comparePngFiles({ expected, actual }));
  const explicit = JSON.stringify(comparePngFiles({ expected, actual, ...DEFAULTS }));
  assert.equal(implicit, explicit);

  const nullPreset = JSON.stringify(comparePngFiles({ expected, actual, preset: null }));
  assert.equal(implicit, nullPreset);
});

test('presets do not change mask semantics', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-preset-'));
  const { expected, actual } = pair(d);
  const mask = [{ name: 'dynamic-strip', x: 0, y: 0, w: 60, h: 15 }];

  for (const name of PRESET_NAMES) {
    const report = comparePngFiles({ expected, actual, preset: name, mask });
    assert.equal(report.ignoredPixels, 900);
    assert.equal(report.evaluatedPixels, 60 * 40 - 900);
    assert.deepEqual(report.ignoredRegions, mask);
    // The changed block spans y=10..29 and the mask covers y=0..14, so the
    // five masked rows of it are excluded and 300 of its 400 pixels remain.
    assert.equal(report.diffPixels, 300);
    const region = report.regions[0];
    assert.ok(region, `${name} found no region`);
    // No region may claim a masked pixel. Its box can still overlap the mask,
    // because regionPadding expands the box and nothing is clipped back.
    assert.equal(region.px, 300);
    assert.ok(report.regions.every(r => r.px >= 1));
    assert.ok(report.regions.reduce((sum, r) => sum + r.px, 0) <= report.diffPixels);
  }
});

test('presets do not change shift detection semantics', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-preset-'));
  const expected = path.join(d, 'ref.png');
  const actual = path.join(d, 'clone.png');
  const inPlace = path.join(d, 'in-place.png');

  // Bars of varying height, so a vertical offset is uniquely pinned. Evenly
  // spaced bars would be periodic and would match at every multiple.
  const build = (file, dy) => {
    const p = new PNG({ width: 120, height: 200 });
    for (let i = 0; i < p.data.length; i += 4) { p.data[i] = 250; p.data[i + 1] = 250; p.data[i + 2] = 250; p.data[i + 3] = 255; }
    for (let bar = 0; bar < 12; bar++) {
      const y = 10 + bar * 14 + dy;
      const h = 4 + (bar % 4) * 3;
      for (let j = y; j < y + h; j++) {
        for (let i = 20; i < 100; i++) {
          const k = (j * p.width + i) * 4;
          p.data[k] = 20; p.data[k + 1] = 20; p.data[k + 2] = 20; p.data[k + 3] = 255;
        }
      }
    }
    fs.writeFileSync(file, PNG.sync.write(p));
  };

  build(expected, 0);
  build(actual, 12);
  // Same geometry, one block recoloured: a change, not a displacement.
  fs.copyFileSync(expected, inPlace);
  patch(inPlace, 30, 30, 30, 30, 250);

  for (const name of PRESET_NAMES) {
    const shifted = comparePngFiles({ expected, actual, preset: name, detectShifts: true });
    assert.equal(shifted.settings.detectShifts, true);
    assert.equal(shifted.shifts.length, 1, `${name} lost the shift`);
    assert.equal(shifted.shifts[0].deltaY, 12);

    const changed = comparePngFiles({ expected, actual: inPlace, preset: name, detectShifts: true });
    assert.equal(changed.shifts.length, 0, `${name} invented a shift`);
  }
});

test('a preset and shift detection coexist without either changing the other', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-preset-'));
  const { expected, actual } = pair(d);

  for (const name of PRESET_NAMES) {
    const withShifts = comparePngFiles({ expected, actual, preset: name, detectShifts: true });
    const withoutShifts = comparePngFiles({ expected, actual, preset: name });

    // Asking for shifts adds exactly two things and changes nothing else.
    assert.equal('shifts' in withoutShifts, false);
    assert.equal(withoutShifts.settings.detectShifts, undefined);
    assert.equal(withShifts.settings.detectShifts, true);
    assert.equal(withShifts.diffPixels, withoutShifts.diffPixels);
    assert.equal(withShifts.diffRatio, withoutShifts.diffRatio);
    assert.equal(withShifts.evaluatedPixels, withoutShifts.evaluatedPixels);
    assert.deepEqual(withShifts.regions, withoutShifts.regions);
    assert.deepEqual(withShifts.settings, { ...withoutShifts.settings, detectShifts: true });
  }
});

test('every preset is byte-reproducible', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-preset-'));
  const { expected, actual } = pair(d);
  for (const name of PRESET_NAMES) {
    const once = comparePngFiles({ expected, actual, preset: name, section: 'fixed' });
    const twice = comparePngFiles({ expected, actual, preset: name, section: 'fixed' });
    assert.equal(JSON.stringify(once), JSON.stringify(twice));
  }
});

// ------------------------------------------------------- synthetic fixtures

test('the synthetic fixtures are deterministic and their ground truth is declared', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-fx-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-fx-b-'));
  const a = buildFixtures(first);
  const b = buildFixtures(second);

  assert.equal(a.length, 10);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].name, b[i].name);
    assert.equal(fs.readFileSync(a[i].reference).equals(fs.readFileSync(b[i].reference)), true, `${a[i].name} reference drifted`);
    assert.equal(fs.readFileSync(a[i].actual).equals(fs.readFileSync(b[i].actual)), true, `${a[i].name} actual drifted`);
  }

  // Every case is one of signal, noise or mixed, and the noise cases must not
  // also claim to contain a real defect.
  for (const testCase of a) {
    assert.ok(['signal', 'noise', 'mixed'].includes(testCase.kind), testCase.name);
    if (testCase.kind === 'noise') assert.equal(testCase.truth.length, 0, testCase.name);
  }
  assert.equal(a.filter(c => c.truth.length > 0).length, 6);
});

test('the synthetic cases separate the profiles the way they are documented to', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-fx-'));
  const cases = buildFixtures(d);
  const byName = name => cases.find(c => c.name === name);

  const regions = (name, preset) => comparePngFiles({
    expected: byName(name).reference,
    actual: byName(name).actual,
    preset
  }).regions;

  // A 5/255 flat colour field: below every other threshold, visible to strict.
  assert.equal(regions('case1-subtle-color', 'strict').length, 1);
  assert.equal(regions('case1-subtle-color', 'balanced').length, 0);
  assert.equal(regions('case1-subtle-color', 'noisy').length, 0);

  // A 40/255 colour field: everybody sees it.
  for (const preset of PRESET_NAMES) {
    assert.equal(regions('case2-strong-color', preset).length, 1, preset);
  }

  // A 1px and a 2px shift of a hairline card: structural, so nobody may lose it.
  for (const preset of PRESET_NAMES) {
    assert.ok(regions('case3-spacing-1px', preset).length > 0, preset);
    assert.ok(regions('case4-spacing-2px', preset).length > 0, preset);
    assert.equal(regions('case7-structural-block', preset).length, 1, preset);
  }

  // Isolated single pixels are never an actionable region, at any preset.
  for (const preset of PRESET_NAMES) {
    assert.equal(regions('case8-single-pixel-noise', preset).length, 0, preset);
  }

  // diffPixels stays honest even when region filtering reports nothing.
  const singlePixel = comparePngFiles({
    expected: byName('case8-single-pixel-noise').reference,
    actual: byName('case8-single-pixel-noise').actual,
    preset: 'strict'
  });
  assert.equal(singlePixel.diffPixels, 12);
  assert.equal(singlePixel.regions.length, 0);

  // A real defect buried in a noise field is found, and reported alone.
  for (const preset of PRESET_NAMES) {
    const mixed = regions('case10-defect-plus-noise', preset);
    assert.equal(mixed.length, 1, `${preset} reported ${mixed.length} regions on the mixed case`);
    assert.ok(mixed[0].px > 14000, preset);
  }
});
