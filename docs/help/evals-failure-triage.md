---
summary: "What to do when eval safety gates fail"
read_when:
  - An eval gate fails locally or in CI
title: "Eval Failure Triage"
---

# Eval Failure Triage

When `pnpm evals` or `pnpm evals:ci` fails:

## 1) Inspect machine output first

Open the generated JSON report:

- `reports/evals/latest.json` (local)
- `reports/evals/ci.json` (CI)

Look at:

- `gate.reasons` (run-level failures)
- `suites[].gate.reasons` (suite-specific failures)
- `suites[].stdout` / `suites[].stderr` for immediate clues

## 2) Re-run only the failing suite

Example:

```bash
node --import tsx scripts/evals/run.ts --profile local --suite orchestration-lifecycle
```

Then run underlying tests directly for full Vitest output:

```bash
pnpm exec vitest run <files listed in suites[].testFiles>
```

## 3) Classify the failure quickly

- **Regression**: expected behavior changed unintentionally.
- **Intentional behavior change**: tests/thresholds need aligned update.
- **Harness issue**: bad suite config, missing tests, parser mismatch.

## 4) Apply the right fix

- Regression:
  - fix source behavior
  - keep thresholds unchanged
- Intentional change:
  - update tests and suite docs in same PR
  - only adjust thresholds with explicit rationale
- Harness issue:
  - fix eval runner/config/tests
  - add/extend `src/evals/runner.test.ts` coverage for the bug

## 5) Validate before closing

Run full gate and confirm JSON output is clean:

```bash
pnpm evals && pnpm evals:ci
```

Both commands must end with overall `PASS` and zero gate reasons.
