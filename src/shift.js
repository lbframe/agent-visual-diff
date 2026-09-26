/**
 * Position shift detection.
 *
 * A "position shift" is a run of content that is visually correct but displaced
 * by a constant integer translation, typically everything below a section whose
 * height does not match. Reporting that as a pixel diff buries the real cause
 * under dozens of large regions.
 *
 * This module is deliberately conservative. A missed shift costs an agent one
 * extra pass over a pixel diff; a false shift sends it hunting for a layout
 * change that does not exist. So a candidate must clear five independent gates,
 * and anything ambiguous stays a plain pixel diff:
 *
 *   1. in-place   the content must genuinely fail to match where it sits
 *   2. explain    translation must account for at least 85% of the band
 *   3. separate   translation must beat in-place by a decisive margin
 *   4. localise   the best lag must be a single interior, prominent peak
 *   5. consensus  neighbouring bands must independently agree on the delta
 *
 * Gate 5 is the strongest of them. Layout drift is a *run*: the same
 * displacement repeats down the page. Smooth gradients and repeated card grids
 * produce sharp-looking peaks, but never two adjacent bands agreeing on the
 * same delta, and they are rejected by it.
 *
 * Determinism: scoring accumulates integer match/total counts and divides
 * exactly once, iteration order is fixed, and every float that reaches the
 * report is rounded. Two runs on identical input produce byte-identical JSON.
 */

/** Default per-channel tolerance, in 0..255, for "these pixels are the same". */
const DEFAULT_TOLERANCE = 24;

/** Default bound on the searched translation, in pixels, on each axis. */
const DEFAULT_MAX_SHIFT = 200;

/** Spacing of the coarse lag sweep; the fine sweep then resolves each integer. */
const DEFAULT_COARSE_STEP = 4;

/** Pixel stride of the sampling grid, in both axes, for the fine sweep. */
const DEFAULT_STEP = 2;

/**
 * Pixel stride for the coarse sweep, which only has to locate the basin of the
 * peak. Sampling it more thinly roughly halves the cost of the dominant pass,
 * while the fine sweep that measures the reported delta keeps full density.
 */
const DEFAULT_COARSE_PIXEL_STEP = 4;

/** Rows bridged across a quiet gap when grouping active rows into a band. */
const DEFAULT_GAP_ROWS = 40;

/** Minimum differing pixels in a row for it to count as active. */
const DEFAULT_MIN_ROW_DIFF = 8;

/** Shortest run of active rows worth analysing. */
const DEFAULT_MIN_BAND_HEIGHT = 100;

/** Minimum samples in a band before its numbers are trusted at all. */
const DEFAULT_MIN_SAMPLES = 2000;

/** Bands taller than this are split, so one band cannot blur two shifts. */
const DEFAULT_MAX_WINDOW_HEIGHT = 400;

/** Upper bound on bands analysed per run, highest activity first. */
const DEFAULT_MAX_BANDS = 64;

/**
 * Gate 1 - above this in-place similarity there is nothing left to explain.
 *
 * This gate is mostly a performance shortcut: it lets a run skip the lag sweep
 * for the many bands that are already fine. It is deliberately loose, because a
 * veto here is silent and a veto on a real shift is a false negative, whereas a
 * band that passes is still subject to gates 2 to 5. Measured on the Duna
 * capture, 0.92 to 0.97 yields the same verdicts.
 */
const MAX_INPLACE_SIMILARITY = 0.95;

/** Gate 2 - translation must account for at least this much of the band. */
const MIN_TRANSLATED_SIMILARITY = 0.85;

/**
 * Gate 3 - translation must beat the in-place comparison by at least this.
 *
 * Gates 1 and 2 already bound the in-place and translated similarity, so this
 * is a floor rather than the main defence: it excludes peaks that are no better
 * than leaving the content where it is, and does little else. On the Duna
 * capture, any value from 0.05 to 0.10 produces identical verdicts, while 0.20
 * discards genuine shifts whose windows straddle the edge of the moved run.
 */
const MIN_IMPROVEMENT = 0.1;

/** Similarity within this distance of the peak counts as the same mode. */
const PEAK_PLATEAU_EPSILON = 0.02;

/** Prominence is measured this far outside the plateau, in pixels. */
const PROMINENCE_DISTANCE = 16;

/** Gate 4 - the peak must stand this far above the shoulders of its plateau. */
const MIN_PROMINENCE = 0.05;

/** Neighbouring bands must agree on the delta to within this many pixels. */
const CONSENSUS_TOLERANCE = 4;

/** Gate 5 - minimum number of consecutive agreeing bands. */
const MIN_CONSENSUS_BANDS = 2;

/**
 * Vertical gap bridged when joining two agreeing shift segments.
 *
 * A displaced section is not guaranteed to produce a clean run of windows: a
 * heading, a lazy-loaded block or a smooth panel can leave a window without
 * usable evidence. Reporting one physical shift as two adjacent entries would
 * be misleading, so segments that agree on the delta are joined across such a
 * gap. This mirrors how `mergeRegions` joins pixel components.
 */
const SHIFT_MERGE_GAP = 200;

/** Horizontal residue searched once a vertical delta is already known. */
const RESIDUAL_MAX_SHIFT = 32;

/**
 * Bound on the fallback sweep for a purely horizontal displacement.
 *
 * This search runs for every band whose vertical axis came back empty, so it is
 * the difference between a run costing seconds and one costing tens of seconds.
 * It is bounded tightly because a large horizontal displacement with no vertical
 * component is not the failure this feature exists for: that is a gross layout
 * error, and the pixel diff already reports it loudly.
 */
const HORIZONTAL_ONLY_MAX_SHIFT = 64;

function round(value, digits = 4) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function clip01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Per-row count of differing pixels, taken from the diff mask the comparison
 * already produced. Deciding *where* to look therefore costs O(pixels) and
 * touches no image data at all.
 */
export function rowActivity(diffMask, width, height) {
  const activity = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (diffMask[row + x]) count++;
    }
    activity[y] = count;
  }
  return activity;
}

/**
 * Group active rows into bands.
 *
 * A gap of up to `gapRows` quiet rows is bridged so that headings and
 * whitespace cannot fracture one displaced section into pieces too short to
 * reach consensus. Bands shorter than `minHeight` are dropped.
 */
export function candidateBands(activity, height, {
  minRowDiff = DEFAULT_MIN_ROW_DIFF,
  gapRows = DEFAULT_GAP_ROWS,
  minHeight = 100
} = {}) {
  const bands = [];
  let start = -1;
  let lastActive = -1;

  for (let y = 0; y <= height; y++) {
    const active = y < height && activity[y] >= minRowDiff;
    if (active) {
      if (start < 0) start = y;
      lastActive = y;
      continue;
    }
    if (start >= 0 && y - lastActive > gapRows) {
      bands.push({ y0: start, y1: lastActive + 1 });
      start = -1;
    }
  }
  if (start >= 0) bands.push({ y0: start, y1: lastActive + 1 });

  return bands
    .filter((band) => band.y1 - band.y0 >= minHeight)
    .map((band) => {
      let px = 0;
      for (let y = band.y0; y < band.y1; y++) px += activity[y];
      return { ...band, px };
    });
}

/**
 * Trim a band to the rows that carry a diff, so quiet leading and trailing rows
 * cannot dilute similarity. Only sub-threshold rows are dropped: trimming by a
 * share of the diff would eat into real content, because a band's diff is
 * concentrated in its middle.
 */
function trimBand(activity, y0, y1, minRowDiff) {
  let head = y0;
  while (head < y1 - 1 && activity[head] < minRowDiff) head++;
  let tail = y1 - 1;
  while (tail > head && activity[tail] < minRowDiff) tail--;
  return { y0: head, y1: tail + 1 };
}

/**
 * Split a band into analysis windows.
 *
 * A band is never analysed as one window when it can be split: large windows
 * give smoother similarity profiles, but a single window can never satisfy the
 * consensus gate, so a short displaced section would be unreportable. The target
 * height is therefore `min(maxWindowHeight, half the band)`, which yields 400px
 * windows for a long band and exactly two for a short one.
 *
 * Windows are non-overlapping and cut from the band start, so the result depends
 * only on the band's coordinates. Splitting also keeps each profile narrow: a
 * band spanning two sections that drifted in opposite directions produces one
 * smeared peak and no verdict, where two windows would each resolve cleanly.
 */
function splitBand(y0, y1, maxHeight) {
  const target = Math.max(1, Math.min(maxHeight, Math.ceil((y1 - y0) / 2)));
  const windows = [];
  for (let top = y0; top < y1; top += target) {
    windows.push({ y0: top, y1: Math.min(y1, top + target) });
  }
  return windows;
}

/**
 * Count matching sampled pixels between two images over a band displaced by
 * (lagX, lagY).
 *
 * A sample counts only when the pixel is inside the viewport on both sides and
 * is *not* ignored at either coordinate. Checking the mask at the translated
 * destination as well as the source is what stops a masked zone from re-entering
 * the comparison through a shifted match.
 *
 * This is the hot loop of the whole feature, so the two cases are kept apart
 * rather than testing `ignore` per pixel: an unmasked run, which is the common
 * one, then does nothing per sample but load, compare and count.
 */
function score(aData, bData, width, height, y0, y1, lagX, lagY, ignore, step, tolerance) {
  let matched = 0;
  let total = 0;

  // Samples that would leave the viewport are excluded outright, which keeps the
  // per-sample bounds test out of the loop.
  const from = lagX < 0 ? -lagX : 0;
  const to = lagX > 0 ? width - lagX : width;

  for (let y = y0; y < y1; y += step) {
    const by = y + lagY;
    if (by < 0 || by >= height) continue;
    const aRow = y * width;
    const bRow = by * width;

    if (ignore) {
      for (let x = from; x < to; x += step) {
        if (ignore[aRow + x]) continue;
        const bx = x + lagX;
        if (ignore[bRow + bx]) continue;
        const ai = (aRow + x) * 4;
        const bi = (bRow + bx) * 4;
        total++;
        const d0 = aData[ai] - bData[bi];
        if (d0 > tolerance || d0 < -tolerance) continue;
        const d1 = aData[ai + 1] - bData[bi + 1];
        if (d1 > tolerance || d1 < -tolerance) continue;
        const d2 = aData[ai + 2] - bData[bi + 2];
        if (d2 <= tolerance && d2 >= -tolerance) matched++;
      }
    } else {
      for (let x = from; x < to; x += step) {
        const ai = (aRow + x) * 4;
        const bi = (bRow + x + lagX) * 4;
        total++;
        const d0 = aData[ai] - bData[bi];
        if (d0 > tolerance || d0 < -tolerance) continue;
        const d1 = aData[ai + 1] - bData[bi + 1];
        if (d1 > tolerance || d1 < -tolerance) continue;
        const d2 = aData[ai + 2] - bData[bi + 2];
        if (d2 <= tolerance && d2 >= -tolerance) matched++;
      }
    }
  }

  return { matched, total, sim: total ? matched / total : 0 };
}

/** Similarity of one band at every integer lag in [from, to]. */
function scanLags(context, y0, y1, axis, from, to, stride, pixelStep) {
  const { aData, bData, width, height, ignoreMask, tolerance } = context;
  const step = pixelStep;
  // When the vertical delta is already known, the horizontal sweep is a residual
  // search and must be measured against that delta, not against lag 0.
  const baseLagY = context.baseLagY ?? 0;
  const profile = [];
  for (let lag = from; lag <= to; lag += stride) {
    const { matched, total, sim } = axis === 'y'
      ? score(aData, bData, width, height, y0, y1, 0, lag, ignoreMask, step, tolerance)
      : score(aData, bData, width, height, y0, y1, lag, baseLagY, ignoreMask, step, tolerance);
    profile.push({ lag, matched, total, sim });
  }
  return profile;
}

/** Highest-similarity entry, ties broken toward the smallest displacement. */
function pickBest(profile) {
  let best = profile[0];
  for (const entry of profile) {
    if (entry.sim > best.sim || (entry.sim === best.sim && Math.abs(entry.lag) < Math.abs(best.lag))) {
      best = entry;
    }
  }
  return best;
}

/**
 * Locate the best lag on one axis, without applying any gate.
 *
 * A coarse sweep finds the basin and a fine sweep at every integer lag resolves
 * it, which keeps the cost linear in `maxShift / coarseStep` while still
 * reporting an exact integer delta.
 */
function axisPeak(context, y0, y1, axis, maxShift, baseLagY = 0) {
  const scoped = axis === 'x' ? { ...context, baseLagY } : context;
  const coarse = scanLags(scoped, y0, y1, axis, -maxShift, maxShift, context.coarseStep, context.coarsePixelStep);
  const bestCoarse = pickBest(coarse);

  // The fine sweep must always contain lag 0, so a caller can always read the
  // no-displacement baseline out of the profile.
  const margin = context.coarseStep * 2;
  const from = Math.min(0, Math.max(-maxShift, bestCoarse.lag - margin));
  const to = Math.max(0, Math.min(maxShift, bestCoarse.lag + margin));
  const fine = scanLags(scoped, y0, y1, axis, from, to, 1, context.step);
  const bestFine = pickBest(fine);

  let low = 0;
  let high = fine.length - 1;
  while (low < fine.length && fine[low].sim < bestFine.sim - PEAK_PLATEAU_EPSILON) low++;
  while (high >= 0 && fine[high].sim < bestFine.sim - PEAK_PLATEAU_EPSILON) high--;

  return {
    profile: fine,
    lag: Math.round((fine[low].lag + fine[high].lag) / 2),
    bestLag: bestFine.lag,
    plateauLo: fine[low].lag,
    plateauHi: fine[high].lag,
    atSearchEdge: Math.abs(bestCoarse.lag) >= maxShift,
    atWindowEdge: bestFine.lag === from || bestFine.lag === to,
    singleMode: high - low < fine.length - 1
  };
}

/** Similarity of a window displaced by an explicit (deltaX, deltaY). */
function similarityAt(context, y0, y1, deltaX, deltaY) {
  const { aData, bData, width, height, ignoreMask, step, tolerance } = context;
  return score(aData, bData, width, height, y0, y1, deltaX, deltaY, ignoreMask, step, tolerance);
}

/**
 * Judge a candidate translation and record every gate it fails.
 *
 * The gates deliberately describe the *combined* displacement rather than the
 * vertical component alone. A diagonally displaced band never matches well on
 * the vertical axis by itself, so judging that axis in isolation would reject
 * exactly the cases a two-axis feature exists to catch.
 *
 * The reasons are returned rather than swallowed so a benchmark can show *why* a
 * window was rejected, which is the only way to tell a working guard from a
 * threshold set too tight.
 */
function judgeCandidate(context, window, candidate, inPlace) {
  const { deltaX, deltaY, vertical, horizontal } = candidate;
  const translated = similarityAt(context, window.y0, window.y1, deltaX, deltaY);
  const improvement = translated.sim - inPlace.sim;

  // Prominence is measured just outside the plateau of near-best lags, not at a
  // fixed distance from the peak: a broad plateau is exactly the ambiguous case
  // this gate exists to catch, and probing from its centre would hide it.
  //
  // Only axes that are actually displaced are required to be prominent. A purely
  // vertical displacement legitimately has a flat horizontal profile, and asking
  // that flatness to be prominent would reject every real vertical shift.
  const reach = PROMINENCE_DISTANCE;
  const offY = Math.max(
    similarityAt(context, window.y0, window.y1, deltaX, vertical.plateauLo - reach).sim,
    similarityAt(context, window.y0, window.y1, deltaX, vertical.plateauHi + reach).sim
  );
  const prominenceY = translated.sim - offY;

  const offX = Math.max(
    similarityAt(context, window.y0, window.y1, horizontal.plateauLo - reach, deltaY).sim,
    similarityAt(context, window.y0, window.y1, horizontal.plateauHi + reach, deltaY).sim
  );
  const prominenceX = translated.sim - offX;

  const prominence = Math.min(
    deltaY === 0 ? Number.POSITIVE_INFINITY : prominenceY,
    deltaX === 0 ? Number.POSITIVE_INFINITY : prominenceX
  );

  const reasons = [];
  if (inPlace.sim > MAX_INPLACE_SIMILARITY) reasons.push('already-matches-in-place');
  if (translated.sim < MIN_TRANSLATED_SIMILARITY) reasons.push('translation-does-not-explain');
  if (improvement < MIN_IMPROVEMENT) reasons.push('insufficient-improvement');
  if (prominence < MIN_PROMINENCE) reasons.push('peak-not-prominent');

  // Localisation is only required on an axis the candidate actually claims. A
  // purely vertical displacement has a broad, meaningless horizontal profile,
  // and holding that against it would reject every real vertical shift.
  for (const [axis, displaced] of [[vertical, deltaY !== 0], [horizontal, deltaX !== 0]]) {
    if (!axis || !displaced) continue;
    if (!axis.singleMode) reasons.push('ambiguous-multiple-modes');
    if (axis.atSearchEdge) reasons.push('peak-at-search-boundary');
    if (axis.atWindowEdge) reasons.push('peak-at-fine-window-edge');
  }

  return {
    deltaX,
    deltaY,
    translatedSimilarity: translated.sim,
    inPlaceSimilarity: inPlace.sim,
    improvement,
    prominence: Number.isFinite(prominence) ? prominence : Math.max(prominenceY, prominenceX),
    accepted: reasons.length === 0,
    reasons: [...new Set(reasons)]
  };
}

/**
 * Analyse one window.
 *
 * The vertical axis is searched first because that is the failure this feature
 * exists for: a height mismatch displaces everything below it. The horizontal
 * axis is then searched as a residual at that vertical delta, which is what lets
 * a diagonal displacement be measured and judged as one translation. A purely
 * horizontal displacement is only considered when the vertical reading does not
 * already explain the window.
 */
function analyseWindow(band, context) {
  const { ignoreMask, step, tolerance, width, height, aData, bData, minSamples } = context;

  const inPlace = score(aData, bData, width, height, band.y0, band.y1, 0, 0, ignoreMask, step, tolerance);
  if (inPlace.total < minSamples) {
    return { ...band, skipped: 'too-few-samples', accepted: false, confidence: 0 };
  }

  // Gate 1 is free: when the content already matches where it sits, no
  // translation has anything to explain, so the whole sweep is skipped. On a
  // long page most windows take this exit, which is what keeps runs cheap.
  if (inPlace.sim > MAX_INPLACE_SIMILARITY) {
    return {
      ...band,
      samples: inPlace.total,
      inPlaceSimilarity: inPlace.sim,
      accepted: false,
      reasons: ['already-matches-in-place'],
      confidence: 0
    };
  }

  const vertical = axisPeak(context, band.y0, band.y1, 'y', context.maxShift);
  const residual = axisPeak(context, band.y0, band.y1, 'x', RESIDUAL_MAX_SHIFT, vertical.lag);

  let candidate = {
    deltaX: residual.singleMode && !residual.atSearchEdge ? residual.lag : 0,
    deltaY: vertical.lag,
    vertical,
    horizontal: residual
  };
  let judged = judgeCandidate(context, band, candidate, inPlace);

  // Only if the vertical reading does not already account for the window is it
  // worth asking whether the displacement was horizontal after all.
  if (!judged.accepted) {
    const horizontal = axisPeak(context, band.y0, band.y1, 'x', HORIZONTAL_ONLY_MAX_SHIFT, 0);
    const alternative = { deltaX: horizontal.lag, deltaY: 0, vertical, horizontal };
    const alternativeVerdict = judgeCandidate(context, band, alternative, inPlace);
    if (alternativeVerdict.accepted || alternativeVerdict.translatedSimilarity > judged.translatedSimilarity) {
      candidate = alternative;
      judged = alternativeVerdict;
    }
  }

  return {
    ...band,
    samples: inPlace.total,
    inPlaceSimilarity: inPlace.sim,
    vertical: candidate.vertical,
    horizontal: candidate.horizontal,
    deltaX: judged.accepted ? candidate.deltaX : 0,
    deltaY: judged.accepted ? candidate.deltaY : 0,
    accepted: judged.accepted,
    reasons: judged.reasons,
    translatedSimilarity: judged.translatedSimilarity,
    prominence: judged.prominence,
    improvement: judged.improvement,
    confidence: judged.accepted ? confidenceOf(judged) : 0
  };
}

/**
 * A bounded, human-legible strength score in 0..1.
 *
 * This is a heuristic, not a probability: it says how strongly the evidence
 * clears each gate, not how likely the layout cause is to be real.
 */
function confidenceOf(peak) {
  return round(clip01(
    0.5 * clip01(peak.translatedSimilarity)
    + 0.3 * clip01(peak.improvement / 0.25)
    + 0.2 * clip01(peak.prominence / 0.1)
  ), 4);
}

/**
 * Fuse consecutive windows that agree on a delta.
 *
 * A single window claiming a shift is noise. Requiring agreement from
 * `minConsensusBands` neighbours is the gate that rejects the sharp peaks
 * produced by smooth backgrounds and repeated card grids, neither of which
 * reproduces the same delta twice in a row.
 */
function fuseConsensus(analyses, { consensusTolerance, minConsensusBands }) {
  const segments = [];
  let run = [];

  const flush = () => {
    if (run.length >= minConsensusBands) {
      // The median delta wins, so one window that drifted within tolerance
      // cannot drag the reported value off the consensus.
      const deltas = run.map((item) => item.deltaY).sort((p, q) => p - q);
      const median = deltas[Math.floor(deltas.length / 2)];
      const members = run.filter((item) => item.deltaY === median);
      segments.push({
        y0: run[0].y0,
        y1: run[run.length - 1].y1,
        deltaY: median,
        deltaX: members[0].deltaX,
        windows: run.length,
        diffPixels: run.reduce((sum, item) => sum + item.px, 0),
        evaluatedSamples: run.reduce((sum, item) => sum + item.samples, 0),
        confidence: Math.min(...run.map((item) => item.confidence))
      });
    }
    run = [];
  };

  for (const analysis of analyses) {
    if (!analysis.accepted) { flush(); continue; }
    if (run.length === 0) { run.push(analysis); continue; }
    const previous = run[run.length - 1];
    const contiguous = analysis.y0 - previous.y1 <= 1;
    const agrees = Math.abs(analysis.deltaY - previous.deltaY) <= consensusTolerance;
    if (contiguous && agrees) run.push(analysis);
    else { flush(); run.push(analysis); }
  }
  flush();

  return segments;
}

/**
 * Join consecutive segments that agree on a delta across a small gap.
 *
 * A displaced section is not guaranteed to yield a clean run of windows: a
 * heading, a lazy-loaded block or a flat panel can leave one window without
 * usable evidence. Reporting a single physical shift as two adjacent entries
 * would be misleading, so agreeing segments are joined across such a gap. This
 * mirrors how `mergeRegions` joins pixel components.
 */
function mergeSegments(segments, mergeGap) {
  const merged = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && previous.deltaY === segment.deltaY && segment.y0 - previous.y1 <= mergeGap) {
      previous.y1 = segment.y1;
      previous.windows += segment.windows;
      previous.diffPixels += segment.diffPixels;
      previous.evaluatedSamples += segment.evaluatedSamples;
      previous.confidence = Math.min(previous.confidence, segment.confidence);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/**
 * Accepted ranges for the tuning overrides.
 *
 * The CLI deliberately exposes none of these: `--detect-shifts` is the only
 * knob, because none of them were needed to make the benchmark pass. They exist
 * for programmatic callers who need to bound a pathological page, and are
 * validated rather than trusted so a typo cannot silently disable a gate.
 */
const TUNING_RANGES = {
  maxShift: [1, 4000],
  coarseStep: [1, 64],
  step: [1, 16],
  coarsePixelStep: [1, 16],
  tolerance: [0, 255],
  minRowDiff: [1, 100000],
  gapRows: [0, 100000],
  minSamples: [1, 100000000],
  maxWindowHeight: [20, 100000],
  maxBands: [1, 100000],
  consensusTolerance: [0, 1000],
  minConsensusBands: [1, 1000],
  mergeGap: [0, 100000]
};

function validateTuning(tuning) {
  if (tuning === null || typeof tuning !== 'object' || Array.isArray(tuning)) {
    throw new Error('shift tuning must be an object');
  }
  for (const [key, value] of Object.entries(tuning)) {
    const range = TUNING_RANGES[key];
    if (!range) {
      throw new Error(`shift tuning: unknown option "${key}"`);
    }
    if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
      throw new Error(`shift tuning: "${key}" must be an integer between ${range[0]} and ${range[1]}, got ${JSON.stringify(value)}`);
    }
  }
}

/**
 * Detect position shifts between two same-sized images.
 *
 * @param {object} options
 * @param {PNG} options.a expected image
 * @param {PNG} options.b actual image
 * @param {Uint8Array} options.diffMask binary diff mask, already masked
 * @param {Uint8Array|null} [options.ignoreMask] rasterized union of ignored
 *   regions; null means nothing is ignored and takes the faster scoring path
 * @param {number} options.width
 * @param {number} options.height
 * @param {object} [options.tuning]
 * @returns {{ shifts: object[], windows: object[], tuning: object }}
 */
export function detectPositionShifts({ a, b, diffMask, ignoreMask = null, width, height, tuning = {} }) {
  validateTuning(tuning);

  const settings = {
    maxShift: tuning.maxShift ?? DEFAULT_MAX_SHIFT,
    coarseStep: tuning.coarseStep ?? DEFAULT_COARSE_STEP,
    step: tuning.step ?? DEFAULT_STEP,
    coarsePixelStep: tuning.coarsePixelStep ?? DEFAULT_COARSE_PIXEL_STEP,
    tolerance: tuning.tolerance ?? DEFAULT_TOLERANCE,
    minRowDiff: tuning.minRowDiff ?? DEFAULT_MIN_ROW_DIFF,
    gapRows: tuning.gapRows ?? DEFAULT_GAP_ROWS,
    minSamples: tuning.minSamples ?? DEFAULT_MIN_SAMPLES,
    maxWindowHeight: tuning.maxWindowHeight ?? DEFAULT_MAX_WINDOW_HEIGHT,
    maxBands: tuning.maxBands ?? DEFAULT_MAX_BANDS,
    consensusTolerance: tuning.consensusTolerance ?? CONSENSUS_TOLERANCE,
    minConsensusBands: tuning.minConsensusBands ?? MIN_CONSENSUS_BANDS,
    mergeGap: tuning.mergeGap ?? SHIFT_MERGE_GAP
  };

  // A null mask is meaningful, not missing: it selects the branch in `score`
  // that skips the per-pixel mask test entirely.
  const ignore = ignoreMask ?? null;
  const activity = rowActivity(diffMask, width, height);

  const bands = candidateBands(activity, height, {
    minRowDiff: settings.minRowDiff,
    gapRows: settings.gapRows,
    minHeight: Math.min(DEFAULT_MIN_BAND_HEIGHT, height)
  });

  // Highest activity first, so the cap keeps the bands most likely to carry a
  // real defect; ties break on position to stay deterministic.
  const selected = [...bands]
    .sort((p, q) => q.px - p.px || p.y0 - q.y0)
    .slice(0, settings.maxBands);

  const context = { aData: a.data, bData: b.data, width, height, ignoreMask: ignore, activity, ...settings };

  const windows = selected
    .flatMap((band) => {
      const { y0, y1 } = trimBand(activity, band.y0, band.y1, settings.minRowDiff);
      return splitBand(y0, y1, settings.maxWindowHeight).map((window) => ({
        ...window,
        px: band.px,
        bandY0: band.y0,
        bandY1: band.y1
      }));
    })
    .sort((p, q) => p.y0 - q.y0);

  const analyses = windows.map((window) => analyseWindow(window, context));
  const segments = mergeSegments(fuseConsensus(analyses, settings), settings.mergeGap);

  const shifts = segments.map((segment, index) => ({
    id: index + 1,
    type: 'position-shift',
    x: 0,
    y: segment.y0,
    w: width,
    h: segment.y1 - segment.y0,
    deltaX: segment.deltaX,
    deltaY: segment.deltaY,
    confidence: segment.confidence,
    windows: segment.windows,
    diffPixels: segment.diffPixels,
    evaluatedSamples: segment.evaluatedSamples
  }));

  return { shifts, windows: analyses, tuning: settings };
}
