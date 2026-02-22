export type EvalSuiteConfig = {
  id: string;
  title: string;
  description: string;
  testFiles: string[];
};

export type EvalSuiteThreshold = {
  minPassRate: number;
  maxFailures: number;
  minTotalTests: number;
};

export type EvalProfileThresholds = {
  minOverallPassRate: number;
  maxTotalFailures: number;
  suites: Record<string, EvalSuiteThreshold>;
};

export type VitestJsonReport = {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  success?: boolean;
  testResults?: Array<{
    assertionResults?: Array<{
      status?: string;
    }>;
    startTime?: number;
    endTime?: number;
  }>;
};

export type EvalSuiteMetrics = {
  id: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  success: boolean;
  durationMs: number;
  exitCode: number;
};

export type EvalSuiteGate = {
  passed: boolean;
  reasons: string[];
};

export type EvalSuiteOutcome = EvalSuiteMetrics & {
  threshold: EvalSuiteThreshold;
  passRate: number;
  score: number;
  gate: EvalSuiteGate;
};

export type EvalRunGate = {
  passed: boolean;
  reasons: string[];
};

export type EvalRunTotals = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number;
  score: number;
  durationMs: number;
};

function clampRate(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

export function parseVitestJsonReport(report: VitestJsonReport): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  success: boolean;
  durationMs: number;
} {
  const totalsFromRoot = {
    total: toNonNegativeInt(report.numTotalTests),
    passed: toNonNegativeInt(report.numPassedTests),
    failed: toNonNegativeInt(report.numFailedTests),
    skipped: toNonNegativeInt(report.numPendingTests) + toNonNegativeInt(report.numTodoTests),
  };

  let fromAssertions = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  };

  let durationMs = 0;
  for (const suite of report.testResults ?? []) {
    const start = toNonNegativeInt(suite.startTime);
    const end = toNonNegativeInt(suite.endTime);
    if (end > start) {
      durationMs += end - start;
    }
    for (const assertion of suite.assertionResults ?? []) {
      fromAssertions.total += 1;
      const status = (assertion.status ?? "").trim().toLowerCase();
      if (status === "passed") {
        fromAssertions.passed += 1;
      } else if (status === "failed") {
        fromAssertions.failed += 1;
      } else {
        fromAssertions.skipped += 1;
      }
    }
  }

  const useAssertionCounts = totalsFromRoot.total === 0 && fromAssertions.total > 0;
  const total = useAssertionCounts ? fromAssertions.total : totalsFromRoot.total;
  const passed = useAssertionCounts ? fromAssertions.passed : totalsFromRoot.passed;
  const failed = useAssertionCounts ? fromAssertions.failed : totalsFromRoot.failed;
  const skipped = useAssertionCounts ? fromAssertions.skipped : totalsFromRoot.skipped;

  return {
    total,
    passed,
    failed,
    skipped,
    success: report.success === true,
    durationMs,
  };
}

export function evaluateSuiteThreshold(
  metrics: EvalSuiteMetrics,
  threshold: EvalSuiteThreshold,
): EvalSuiteOutcome {
  const passRate = metrics.total > 0 ? clampRate(metrics.passed / metrics.total) : 0;
  const score = round3(passRate);
  const reasons: string[] = [];

  if (metrics.total < threshold.minTotalTests) {
    reasons.push(`expected at least ${threshold.minTotalTests} tests, got ${metrics.total}`);
  }
  if (metrics.failed > threshold.maxFailures) {
    reasons.push(`failed tests ${metrics.failed} > threshold ${threshold.maxFailures}`);
  }
  if (passRate < threshold.minPassRate) {
    reasons.push(
      `pass rate ${round3(passRate)} < threshold ${round3(clampRate(threshold.minPassRate))}`,
    );
  }
  if (metrics.exitCode !== 0) {
    reasons.push(`vitest exit code ${metrics.exitCode}`);
  }

  return {
    ...metrics,
    threshold,
    passRate: round3(passRate),
    score,
    gate: {
      passed: reasons.length === 0,
      reasons,
    },
  };
}

export function aggregateRunTotals(outcomes: EvalSuiteOutcome[]): EvalRunTotals {
  const totals = outcomes.reduce(
    (acc, suite) => {
      acc.total += suite.total;
      acc.passed += suite.passed;
      acc.failed += suite.failed;
      acc.skipped += suite.skipped;
      acc.durationMs += suite.durationMs;
      return acc;
    },
    {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
    },
  );

  const passRate = totals.total > 0 ? clampRate(totals.passed / totals.total) : 0;
  return {
    ...totals,
    passRate: round3(passRate),
    score: round3(passRate),
  };
}

export function evaluateRunGate(
  outcomes: EvalSuiteOutcome[],
  profile: Pick<EvalProfileThresholds, "minOverallPassRate" | "maxTotalFailures">,
): { gate: EvalRunGate; totals: EvalRunTotals } {
  const totals = aggregateRunTotals(outcomes);
  const reasons: string[] = [];

  for (const suite of outcomes) {
    if (!suite.gate.passed) {
      reasons.push(`suite ${suite.id} failed gate: ${suite.gate.reasons.join("; ")}`);
    }
  }

  if (totals.failed > profile.maxTotalFailures) {
    reasons.push(
      `total failed tests ${totals.failed} > threshold ${Math.max(0, profile.maxTotalFailures)}`,
    );
  }
  if (totals.passRate < clampRate(profile.minOverallPassRate)) {
    reasons.push(
      `overall pass rate ${totals.passRate} < threshold ${round3(clampRate(profile.minOverallPassRate))}`,
    );
  }

  return {
    totals,
    gate: {
      passed: reasons.length === 0,
      reasons,
    },
  };
}
