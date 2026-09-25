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

Top-level comparison data describes the full image. `regions` describes localized clusters of changed pixels.

Important region fields:

| Field | Meaning |
| --- | --- |
| `id` | Stable 1-based rank in the emitted report |
| `x`, `y` | Top-left coordinate in screenshot pixels |
| `w`, `h` | Bounding-box dimensions |
| `px` | Number of changed pixels represented by the region |
| `area` | Bounding-box area after merge/padding |
| `density` | `px / area` |
| `shareOfDiff` | Fraction of all changed pixels represented by the region |

Regions are sorted by changed-pixel count descending, with deterministic coordinate tie-breaking.

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
Do not modify the reference image unless explicitly instructed.
```

## What the tool does not decide

The report does not claim that a change is desirable, undesirable, or semantically equivalent. It provides pixel evidence. Semantic or design judgment belongs to the calling system or human reviewer.
