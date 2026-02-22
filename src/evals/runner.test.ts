import { describe, expect, it } from "vitest";
import {
  aggregateRunTotals,
  evaluateRunGate,
  evaluateSuiteThreshold,
  parseVitestJsonReport,
  type EvalSuiteMetrics,
} from "./runner.js";

describe("eval runner scoring", () => {
  it("parses root-level vitest counters", () => {
    const parsed = parseVitestJsonReport({
      numTotalTests: 10,
      numPassedTests: 9,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      success: false,
    });
    expect(parsed).toMatchObject({ total: 10, passed: 9, failed: 1, skipped: 0, success: false });
  });

  it("falls back to assertion-level counters when root counters are missing", () => {
    const parsed = parseVitestJsonReport({
      success: true,
      testResults: [
        {
          assertionResults: [{ status: "passed" }, { status: "failed" }, { status: "skipped" }],
          startTime: 100,
          endTime: 150,
        },
      ],
    });

    expect(parsed.total).toBe(3);
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(1);
    expect(parsed.skipped).toBe(1);
    expect(parsed.durationMs).toBe(50);
  });

  it("fails suite gate when thresholds are not met", () => {
    const metrics: EvalSuiteMetrics = {
      id: "suite-a",
      total: 8,
      passed: 7,
      failed: 1,
      skipped: 0,
      success: false,
      durationMs: 10,
      exitCode: 1,
    };

    const scored = evaluateSuiteThreshold(metrics, {
      minPassRate: 1,
      maxFailures: 0,
      minTotalTests: 10,
    });

    expect(scored.gate.passed).toBe(false);
    expect(scored.gate.reasons.join(" ")).toContain("expected at least 10 tests");
    expect(scored.gate.reasons.join(" ")).toContain("failed tests 1 > threshold 0");
    expect(scored.gate.reasons.join(" ")).toContain("vitest exit code 1");
  });

  it("aggregates totals and run-level threshold gate", () => {
    const suitePass = evaluateSuiteThreshold(
      {
        id: "suite-pass",
        total: 4,
        passed: 4,
        failed: 0,
        skipped: 0,
        success: true,
        durationMs: 5,
        exitCode: 0,
      },
      { minPassRate: 1, maxFailures: 0, minTotalTests: 1 },
    );

    const suiteFail = evaluateSuiteThreshold(
      {
        id: "suite-fail",
        total: 4,
        passed: 3,
        failed: 1,
        skipped: 0,
        success: false,
        durationMs: 5,
        exitCode: 1,
      },
      { minPassRate: 1, maxFailures: 0, minTotalTests: 1 },
    );

    const totals = aggregateRunTotals([suitePass, suiteFail]);
    expect(totals.total).toBe(8);
    expect(totals.passed).toBe(7);
    expect(totals.failed).toBe(1);
    expect(totals.passRate).toBe(0.875);

    const run = evaluateRunGate([suitePass, suiteFail], {
      minOverallPassRate: 1,
      maxTotalFailures: 0,
    });

    expect(run.gate.passed).toBe(false);
    expect(run.gate.reasons.join(" ")).toContain("suite suite-fail failed gate");
    expect(run.gate.reasons.join(" ")).toContain("total failed tests 1 > threshold 0");
  });
});
