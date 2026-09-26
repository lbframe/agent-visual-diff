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

- Regions are clamped to the viewport. A region entirely outside it is a hard error.
- Overlapping regions are unioned; `ignoredPixels` counts each pixel once.
- An unnamed region is reported as `region-<n>`, 1-based, in declaration order.
- Regions from `--mask` come first, then `--ignore` specs in command-line order.
- Masking the whole viewport is an error: there is nothing left to compare.

An agent reading a report can tell exactly what was excluded. It cannot tell whether the
exclusion was justified — that judgment stays with the caller. A mask wide enough to hide a
real defect will also hide it from `fail-above`.

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
Do not modify the reference image unless explicitly instructed.
Do not widen an ignored region to make a failing run pass.
```

## What the tool does not decide

The report does not claim that a change is desirable, undesirable, or semantically equivalent. It provides pixel evidence. Semantic or design judgment belongs to the calling system or human reviewer.
