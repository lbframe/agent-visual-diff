<p align="center">
  <img src=".github/assets/hero.svg" alt="agent-visual-diff" width="880">
</p>

<p align="center">
  Deterministic visual regression built for coding agents, CI, and humans.
</p>

<p align="center">
  <a href="https://github.com/lbframe/agent-visual-diff/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/lbframe/agent-visual-diff/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111111.svg"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-111111.svg">
  <img alt="Agent friendly" src="https://img.shields.io/badge/output-agent--friendly-111111.svg">
</p>

`agent-visual-diff` compares two PNG screenshots, finds the pixels that changed, groups them into meaningful regions, and returns stable bounding boxes ranked by importance.

Instead of telling an agent only that a screenshot is “2.7% different”, it can say:

```text
#1  x=160 y=80   500x40   8,900px
#2  x=923 y=214  180x62   2,104px
#3  x=88  y=701  240x32   1,031px
```

The agent now knows exactly **where to look**.

## Why this exists

Most visual regression tools are designed around human review: a pass/fail verdict, a diff image, or an HTML report.

Coding agents need something slightly different:

- deterministic evidence
- compact machine-readable output
- ranked regions instead of a full-screen treasure hunt
- stable exit codes for loops and CI
- minimal dependencies and no hosted service

`agent-visual-diff` is intentionally small. It uses `pixelmatch` for pixel comparison and adds deterministic region extraction on top.

## Quick start

Requires Node.js 20+.

```bash
npm install
npm link

avd --help
```

Compare two screenshots:

```bash
avd compare reference.png actual.png \
  --diff .avd/diff.png \
  --out .avd/report.json
```

`compare` is optional:

```bash
avd reference.png actual.png --json
```

## Human output

```text
Match: 97.3000%
Diff pixels: 12,402 (2.7000%)
Regions: 3

#1  x=160 y=80   500x40   8900px
#2  x=923 y=214  180x62   2104px
#3  x=88  y=701  240x32   1031px

Report: .avd/report.json
Diff:   .avd/diff.png
```

## Agent output

Use `--json` for structured stdout:

```bash
avd compare reference.png actual.png --json
```

Use `--compact` when tokens matter:

```bash
avd compare reference.png actual.png --compact
```

Example region:

```json
{
  "id": 1,
  "x": 160,
  "y": 80,
  "w": 500,
  "h": 40,
  "px": 8900,
  "area": 20000,
  "density": 0.445,
  "shareOfDiff": 0.2543
}
```

An agent can inspect `x=160,y=80,w=500,h=40` first, fix the likely cause, recapture, and rerun.

See [the agent contract](docs/agent-contract.md) for the intended automation loop and field semantics.

## CI mode

Fail when the changed-pixel ratio exceeds a threshold:

```bash
avd compare reference.png actual.png \
  --json \
  --fail-above 0.01
```

Exit codes:

| Code | Meaning |
| ---: | --- |
| `0` | Comparison completed and threshold passed |
| `1` | Usage or runtime error |
| `2` | Comparison completed but `--fail-above` failed |

JSON is still emitted on exit code `2`, so the failed run keeps its evidence.

## CLI options

```text
--json
--compact
--out <report.json>
--diff <diff.png>
--section <name>
--threshold <0..1>
--include-aa
--min-region-pixels <n>
--merge-gap <px>
--region-padding <px>
--max-regions <n>
--fail-above <ratio>
-h, --help
-v, --version
```

## How regions are built

1. Run `pixelmatch` with `diffMask: true`.
2. Convert the alpha channel to a binary diff mask.
3. Run deterministic 8-neighbour connected-component labelling.
4. Drop components smaller than `minRegionPixels`.
5. Merge boxes whose x/y separation is within `mergeGap`.
6. Apply `regionPadding` and clamp to the viewport.
7. Sort by changed pixels descending, then y/x for stable ties.

`px` is the number of changed pixels represented by a region. `area` is the final bounding-box area and may include padding or unchanged pixels inside the rectangle.

## Programmatic API

```js
import { comparePngFiles } from 'agent-visual-diff';

const report = comparePngFiles({
  expected: 'reference.png',
  actual: 'actual.png',
  diffPng: '.avd/diff.png',
  section: 'homepage',
  threshold: 0.1,
  minRegionPixels: 3,
  mergeGap: 6,
  regionPadding: 4
});
```

Region primitives are also exported from `agent-visual-diff/regions`.

## Playwright

A minimal integration lives in [`examples/playwright-snippet.mjs`](examples/playwright-snippet.mjs).

The comparator is deterministic for identical PNG inputs and settings. Browser capture itself may not be. Fix the viewport, fonts, animations, dates, random data, dynamic content, and browser/runtime versions when reproducibility matters.

## Development

```bash
npm install
npm test
npm run check
npm run pack:dry
```

Test the exact package artifact before publishing:

```bash
npm pack
mkdir /tmp/avd-smoke && cd /tmp/avd-smoke
npm init -y
npm install /path/to/agent-visual-diff/agent-visual-diff-0.1.0.tgz
./node_modules/.bin/avd --help
```

## Publishing

Check package availability and authentication:

```bash
npm view agent-visual-diff
npm whoami
```

Then publish:

```bash
npm publish --access public
```

After publication:

```bash
npx agent-visual-diff compare reference.png actual.png --json
```

## Scope

This project does **not** attempt to infer why a visual change happened or whether a design is aesthetically correct. It produces deterministic visual evidence so another system, agent, or human can make that judgment.

## Contributing

Issues and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.

Security reports should follow [SECURITY.md](SECURITY.md).

## License

MIT © LB FRAME
