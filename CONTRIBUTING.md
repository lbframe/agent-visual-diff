# Contributing

Thanks for considering a contribution to `agent-visual-diff`.

The project is intentionally small. Contributions should preserve three properties: deterministic output, a compact agent-friendly contract, and minimal dependencies.

## Before opening a pull request

1. Open an issue first for behavior changes or new features unless the change is obviously small.
2. Keep the scope focused. Avoid unrelated refactors in the same PR.
3. Add or update tests for observable behavior.
4. Run the full local checks.

```bash
npm install
npm run check
npm run pack:dry
```

## Supported Node.js versions

`agent-visual-diff` supports non-EOL Node.js versions relevant to production use. The minimum
supported major is currently Node 22.

CI runs the full check suite on every supported line:

| Line | Status |
| --- | --- |
| Node.js 22 | LTS — minimum supported |
| Node.js 24 | LTS |
| Node.js 26 | Current — tested for forward compatibility, not a support commitment |

The Current line is tested to catch incompatibilities early. It is not a promise of permanent
support; the LTS lines are. Please run the same checks locally on the lowest supported major when
touching runtime code:

```bash
nvm use 22
npm install
npm run check
```

## Design principles

- **Deterministic first.** Same inputs and options should produce the same report ordering and values.
- **Evidence over interpretation.** The core should report what changed, not guess why it changed.
- **Machine output is an API.** Treat JSON field names, exit codes, ordering, and compact output as compatibility-sensitive.
- **Keep it small.** New runtime dependencies need a strong justification.
- **Fail clearly.** Invalid images, mismatched dimensions, invalid options, and filesystem errors should produce actionable failures.

## Pull requests

A useful PR description includes:

- problem being solved
- behavioral change
- test evidence
- compatibility impact, if any

For changes to JSON output or CLI semantics, include before/after examples.

## Commit style

Clear imperative commit subjects are preferred, for example:

```text
Add stable region tie-breaking
Reject mismatched PNG dimensions
Document CI exit codes
```

## Releases

Versioning follows semantic versioning. Changes to documented JSON fields, CLI behavior, or exit codes may require a major version once the project reaches `1.0.0`.
