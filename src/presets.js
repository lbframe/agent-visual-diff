/**
 * Named sensitivity profiles.
 *
 * A preset is a fixed set of comparison settings, so that a comparison can be
 * described by intent ("this is a design-fidelity review") instead of by six
 * numbers. The values below are not taste: each one is the outcome of the
 * measurements in `npm run bench:presets`, which is the only place they are
 * justified. Changing a number here without re-running that benchmark makes the
 * documentation a lie.
 *
 * Three findings from that benchmark shaped the whole surface, and all three
 * contradict the intuitive guess:
 *
 * 1. `threshold` is squared YIQ distance, not perceptual amplitude. pixelmatch
 *    compares `0.5053 * delta^2` against `35215 * threshold^2`, so a neutral
 *    grey change is only seen when `delta > 264 * threshold`. At the legacy 0.1
 *    that is delta > 26.4: a whole 5/255 background tone shift is invisible.
 *    This is why the numbers below are an order of magnitude below 0.1 and why
 *    the three profiles are spread across a narrow band rather than a wide one.
 *
 * 2. `includeAA: true` belongs in every profile, including the tolerant one.
 *    With `includeAA: false`, pixelmatch drops the anti-aliased pixels of a
 *    difference, and a text defect then survives only as scattered fragments
 *    smaller than `minRegionPixels`. On the Duna capture, `includeAA: false`
 *    with `minRegionPixels: 20` drops the recall of two verified real defects
 *    from 100% to 5-10% at *every* threshold tested. Turning antialiasing
 *    detection off does not reduce noise here; it deletes real defects.
 *
 * 3. `minRegionPixels: 20` is the noise lever, and it is the only one. The
 *    synthetic corpus is clean at 20 and noisy at 2: a 12px threshold admits
 *    hundreds of single-pixel regions, while 20 admits none. 40 was tested and
 *    rejected, because it costs Duna real-defect recall (100% -> 45%) without
 *    removing anything the synthetic corpus had not already removed at 20.
 *
 * `mergeGap` and `regionPadding` are deliberately absent. No measured value of
 * either improved any profile, so pinning them would only freeze today's
 * defaults under a name that promises they were chosen. They stay overridable
 * per run like any other option.
 */

/** The effective settings when no preset is requested. Unchanged since v0.1. */
export const DEFAULTS = {
  threshold: 0.1,
  includeAA: false,
  minRegionPixels: 2,
  mergeGap: 6,
  regionPadding: 2,
  maxRegions: 50
};

export const PRESETS = {
  // Fidelity over noise. Catches the subtle, deliberate differences — a 5/255
  // colour field, a background tone, a headline's metrics — that the legacy
  // threshold cannot see at all. On the Apple capture that is the difference
  // between 1 of 4 and 4 of 4 verified design defects.
  //
  // `maxRegions: 100` is the only setting here that no other profile sets, and
  // it is there for a measured reason: the default cap of 50 is reached
  // constantly on a long noisy page, and on the unmasked Duna capture it is
  // what pushed a real static-text defect off the end of the list, holding its
  // recall to 69%. 100 restores full coverage. 200 was also measured and
  // bought nothing further while doubling the report size.
  strict: {
    threshold: 0.01,
    includeAA: true,
    minRegionPixels: 20,
    maxRegions: 100
  },

  // The recommended general profile. The lowest threshold that still finds the
  // Apple background tone — a 10/255 shift needs threshold < 0.038, so 0.03 is
  // the last value on the useful side of that cliff — at a diff ratio roughly a
  // fifth below `strict` on the same capture. It gives up one synthetic case
  // (a 5/255 flat colour field, which needs threshold <= 0.019) and in exchange
  // reports no false positive at all across the synthetic corpus.
  balanced: {
    threshold: 0.03,
    includeAA: true,
    minRegionPixels: 20
  },

  // For captures where rendering variation is expected: font antialiasing,
  // shadows, animation residue, a different rasteriser. It keeps every large
  // structural and layout defect measured on all three sites — the Stripe
  // heading offset and both Duna captions stay at 100% recall — and tolerates
  // low-amplitude differences that the other two profiles report.
  //
  // It is not a strictly weaker `balanced`: on the Apple capture it finds 2 of
  // 4 verified design defects, and it finds one of them (`headline-metrics`)
  // that `balanced` only partially covers. It trades recall of subtle tone and
  // spacing for a much lower diff ratio on exactly the kind of page where
  // `balanced` reports a third of it as changed.
  noisy: {
    threshold: 0.1,
    includeAA: true,
    minRegionPixels: 20
  }
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** The order the resolved settings are reported in. Part of the JSON contract. */
const SETTINGS_KEYS = ['threshold', 'includeAA', 'minRegionPixels', 'mergeGap', 'regionPadding', 'maxRegions'];

/**
 * Reject an unknown preset by name.
 *
 * A typo must fail loudly rather than silently comparing at the default
 * sensitivity, which is the failure mode this feature exists to remove.
 */
export function assertPresetName(name) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(PRESETS, name)) {
    throw new Error(`unknown preset: ${JSON.stringify(name)} (expected one of: ${PRESET_NAMES.join(', ')})`);
  }
  return name;
}

/**
 * Resolve the settings for one run.
 *
 * Precedence is explicit option, then preset, then the v0.1 defaults. An
 * override is anything not `undefined`, so a caller can pass `threshold: 0`
 * deliberately and keep it; the CLI only forwards flags the user actually
 * typed, which is what makes `--preset balanced --threshold 0.05` behave the
 * way the documentation says.
 *
 * The returned key order is fixed so that a run without a preset serialises to
 * exactly the bytes it always did.
 */
export function resolveSettings({ preset = null, ...overrides } = {}) {
  const base = preset === null || preset === undefined ? DEFAULTS : PRESETS[assertPresetName(preset)];
  const resolved = {};
  for (const key of SETTINGS_KEYS) {
    const override = overrides[key];
    // A preset only names the keys it has an opinion about, so anything it
    // leaves out keeps the v0.1 default rather than becoming undefined.
    resolved[key] = override === undefined ? (base[key] ?? DEFAULTS[key]) : override;
  }
  return resolved;
}
