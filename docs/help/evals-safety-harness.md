---
summary: "Deterministic eval suites and CI/local safety gates"
read_when:
  - Running reliability evals for messaging/orchestration/voice safety
  - Integrating eval gates in local workflows or CI
title: "Evals + Safety Harness"
---

# Evals + Safety Harness

Feature 2 adds deterministic, CI-safe eval suites for critical workflows:

- **messaging-routing**: routing policy + fallback correctness
- **orchestration-lifecycle**: task-plan lifecycle/delegation terminal-state correctness
- **voice-action-safety**: voice action confirmation requirements for high-risk actions

## Single-command run

```bash
pnpm evals
```

CI profile:

```bash
pnpm evals:ci
```

## Machine-readable output

- Local run writes: `reports/evals/latest.json`
- CI run writes: `reports/evals/ci.json`

Output schema includes:

- per-suite test totals (`total`, `passed`, `failed`, `skipped`)
- per-suite score (`passRate`, `score`) and gate decision (`gate.passed`, `gate.reasons`)
- overall totals and overall gate
- threshold profile used

## Thresholds

Thresholds are strict and deterministic for both local + CI:

- Overall: `minOverallPassRate=1.0`, `maxTotalFailures=0`
- Suite gates:
  - messaging-routing: `minPassRate=1.0`, `maxFailures=0`, `minTotalTests=20`
  - orchestration-lifecycle: `minPassRate=1.0`, `maxFailures=0`, `minTotalTests=6`
  - voice-action-safety: `minPassRate=1.0`, `maxFailures=0`, `minTotalTests=9`

## Running a single suite

```bash
node --import tsx scripts/evals/run.ts --profile local --suite messaging-routing
```

You can repeat `--suite` to run multiple targeted suites.
