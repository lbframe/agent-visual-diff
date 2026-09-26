# Agent contract

`agent-visual-diff` is designed to sit inside an automated implementation loop. Its job is to reduce a full-screen visual regression into deterministic evidence that is cheap for an agent to consume.

## Recommended loop

```text
capture reference/current screenshots
        ↓
avd compare --compact --fail-above <ratio>
        ↓
pass? ── yes → stop
  │
  no
  ↓
inspect regions[0]
        ↓
fix implementation
        ↓
recapture and rerun
```

Start with the highest-ranked region. Only inspect more regions when needed.

## Output semantics

Top-level comparison data describes the evaluated part of the image. `regions` describes localized clusters of changed pixels.

| Field | Meaning |
| --- | --- |
| `diffPixels` | Changed pixels outside every ignored region |
| `diffRatio` | `diffPixels / evaluatedPixels`, not over the full viewport |
| `ignoredPixels` | Distinct pixels covered by at least one ignored region |
| `evaluatedPixels` | `width * height - ignoredPixels` |
| `ignoredRegions` | The clamped rectangles that were excluded, in declaration order |
| `match`, `matchRatio` | `1 - diffRatio`, over the evaluated area |

`ignoredRegions`, `ignoredPixels` and `evaluatedPixels` are always present, including when no
mask is used, so the JSON shape does not depend on the flags passed. `schemaVersion` is `2`
as of this feature; a run with no mask produces the same numbers as `schemaVersion: 1` apart
from the three new fields.

Important region fields:

| Field | Meaning |
| --- | --- |
| `id` | Stable 1-based rank in the emitted report |
| `x`, `y` | Top-left coordinate in screenshot pixels |
| `w`, `h` | Bounding-box dimensions |
| `px` | Number of changed pixels represented by the region |
| `area` | Bounding-box area after merge/padding |
| `density` | `px / area` |
| `shareOfDiff` | Fraction of all counted changed pixels represented by the region |

Regions are sorted by changed-pixel count descending, with deterministic coordinate tie-breaking.

No counted pixel ever falls inside an ignored region. A region's *bounding box* can still
overlap an ignored zone, because `mergeGap` and `regionPadding` expand boxes after labelling.
`px` remains exact; only the box is generous.

## Ignored regions

```json
{
  "ignoredRegions": [
    { "name": "testimonial-carousel", "x": 120, "y": 2100, "w": 1200, "h": 600 }
  ],
  "ignoredPixels": 720000,
  "evaluatedPixels": 12345678
}
```

Contract:

- Regions are validated identically whether they come from `--mask`, `--ignore`, or are passed
  straight to `comparePngFiles({ mask })`: `x`/`y` integers `>= 0`, `w`/`h` integers `> 0`,
  `name` a non-empty string when present, no unknown keys.
- Negative `x` or `y` coordinates are rejected. A negative index would rasterize into the
  previous scanline and report a pixel count nobody asked for.
- A region that starts inside the viewport but extends beyond its right or bottom edge is
  clamped to the viewport.
- A region that lies entirely outside the viewport is rejected.
- Overlapping regions are unioned; `ignoredPixels` counts each pixel once.
- An unnamed region is reported as `region-<n>`, 1-based, in declaration order.
- Regions from `--mask` come first, then `--ignore` specs in command-line order.
- Masking the whole viewport is an error: there is nothing left to compare.

Because the API and the CLI share one validation path, `ignoredPixels + evaluatedPixels`
always equals `width * height` on a successful run. If either number looks wrong, the region
that produced it was rejected rather than silently reinterpreted.

An agent reading a report can tell exactly what was excluded. It cannot tell whether the
exclusion was justified — that judgment stays with the caller. A mask wide enough to hide a
real defect will also hide it from `fail-above`.

## Position shifts

Opt-in, off by default:

```bash
avd compare reference.png actual.png --detect-shifts
```

```js
comparePngFiles({ expected, actual, detectShifts: true });
```

A position shift is a run of content that is visually correct but displaced by a constant
offset. It usually means an upstream section has the wrong height, and everything below it
moved as a consequence.

```json
{
  "shifts": [
    {
      "id": 1,
      "type": "position-shift",
      "x": 0, "y": 2812, "w": 1440, "h": 899,
      "deltaX": 0, "deltaY": -58,
      "confidence": 0.8235,
      "windows": 4,
      "diffPixels": 1204371,
      "evaluatedSamples": 316440
    }
  ],
  "settings": { "detectShifts": true }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable 1-based rank, ordered top to bottom |
| `type` | Always `"position-shift"` |
| `x`, `y`, `w`, `h` | The displaced run. `x` is `0` and `w` is the viewport width, since a vertical height mismatch displaces the full page width |
| `deltaX`, `deltaY` | Integer translation that best explains the run. `deltaY` is how far the content moved in the actual image relative to the reference |
| `confidence` | Bounded 0..1 strength score, **not** a probability (see below) |
| `windows` | How many independent analysis windows agreed on the delta |
| `diffPixels` | Differing pixels the shift accounts for |
| `evaluatedSamples` | Pixels actually compared, after ignoring masked ones |

### Why `shifts` is a separate array, and why `schemaVersion` did not change

`shifts` sits beside `regions` rather than inside it, for three reasons:

- A region's fields describe *changed* pixels (`px`, `density`, `shareOfDiff`). Displaced pixels
  did not change, they moved, so those numbers are not meaningful for a shift.
- `regions` is a ranking capped by `--max-regions` whose `shareOfDiff` values sum against
  `diffPixels`. Folding shifts in would break that invariant and every consumer that relies on it.
- One shift usually spans many diff regions. That aggregation is the entire point: it is what
  turns "fix these 40 regions" into "find the section above this one".

`schemaVersion` stays at `2`. Both `shifts` and `settings.detectShifts` appear **only** when the
option is requested, and no documented field changes meaning or shape. A run without the flag
serialises to exactly the bytes it did before this feature existed — the test suite asserts this
against the previous implementation. A consumer must therefore treat `shifts` as present if and
only if `settings.detectShifts` is `true`, and must not assume the key exists.

### Reading a shift

```text
Do not fix the regions inside this span one by one.
Look for the section immediately above it and compare its height.
```

A shift is evidence, not semantic truth. It says the pixels below a point moved together by a
constant amount. It does not say why, and the reported span can include rows that did not move,
since the span is bounded by the evidence rather than by the true extent of the displacement.

`confidence` summarises how strongly the evidence cleared each internal gate. It is a strength
score, not a probability: `0.84` does not mean an 84% chance of any particular layout cause.

### When to distrust it

- Entries with the same `deltaY` in different places are usually one cause. Masked or low-contrast
  rows interrupt the evidence, and a single displacement is then reported as several entries.
- A shift never suppresses a diff region. Both are reported, and `--fail-above` still fails on
  `diffRatio`. The feature adds an explanation, it does not grant a pass.
- Ignored pixels contribute to nothing: not to a candidate, not to a score, not to a confidence,
  and not through a translated match. A mask that covers where content moved hides the shift.

## Exit codes

- `0`: comparison completed and any configured threshold passed
- `1`: invocation/runtime failure
- `2`: comparison completed, evidence was produced, but `--fail-above` failed

Exit code `2` is intentionally distinct from runtime failure. An agent should parse the report and continue its correction loop rather than treating the command itself as broken.

## Prompt pattern

A coding agent can be instructed along these lines:

```text
Run agent-visual-diff against the reference and current screenshot.
If it passes, stop.
If it fails, inspect the highest-ranked diff region first.
Use the region coordinates to focus visual inspection, fix the underlying implementation, recapture, and rerun.
If regions[0] sits inside ignoredRegions, that area was declared non-comparable; confirm the mask still applies before changing it.
When shifts are reported, do not repair the regions they cover individually: look for the section
immediately above the shift and compare its height against the reference, then fix that one cause.
Treat a shift as evidence of an upstream geometry problem, not as proof of a particular fix.
Do not modify the reference image unless explicitly instructed.
Do not widen an ignored region to make a failing run pass.
```

## What the tool does not decide

The report does not claim that a change is desirable, undesirable, or semantically equivalent. It provides pixel evidence. Semantic or design judgment belongs to the calling system or human reviewer.

Position shift detection is the sharpest version of that limit. Its classifier is intentionally
conservative: a shift is reported only when a single translation explains a run of content
decisively, and only when neighbouring windows agree on the same offset independently. Where the
evidence is ambiguous the region stays an ordinary pixel diff, because a false shift would send an
agent after a layout cause that does not exist — a worse outcome than a missed one. The tool will
therefore sometimes report a real displacement as a pile of diff regions. That is the intended
failure direction, not a bug to be tuned away.
