#!/usr/bin/env -S node --import tsx
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVAL_PROFILE_THRESHOLDS, EVAL_SUITES } from "../../src/evals/config.js";
import {
  evaluateRunGate,
  evaluateSuiteThreshold,
  parseVitestJsonReport,
  type EvalSuiteMetrics,
} from "../../src/evals/runner.js";

type Profile = "local" | "ci";

type CliOptions = {
  profile: Profile;
  suiteIds: Set<string>;
  jsonOut?: string;
};

function parseArgs(argv: string[]): CliOptions {
  let profile: Profile = "local";
  const suiteIds = new Set<string>();
  let jsonOut: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      const next = (argv[i + 1] ?? "").trim().toLowerCase();
      if (next === "local" || next === "ci") {
        profile = next;
        i += 1;
      }
      continue;
    }
    if (arg === "--suite") {
      const next = (argv[i + 1] ?? "").trim();
      if (next) {
        suiteIds.add(next);
        i += 1;
      }
      continue;
    }
    if (arg === "--json-out") {
      const next = (argv[i + 1] ?? "").trim();
      if (next) {
        jsonOut = next;
        i += 1;
      }
    }
  }

  return { profile, suiteIds, jsonOut };
}

function resolveRepoRoot(): string {
  const filePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filePath), "../..");
}

function resolveSuites(suiteIds: Set<string>) {
  if (suiteIds.size === 0) {
    return EVAL_SUITES;
  }
  const selected = EVAL_SUITES.filter((suite) => suiteIds.has(suite.id));
  const missing = [...suiteIds].filter((id) => !selected.some((suite) => suite.id === id));
  if (missing.length > 0) {
    throw new Error(`Unknown suite id(s): ${missing.join(", ")}`);
  }
  return selected;
}

function runVitestSuite(params: { repoRoot: string; suiteId: string; testFiles: string[] }): {
  metrics: EvalSuiteMetrics;
  stderr: string;
  stdout: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-evals-"));
  const outputFile = path.join(tmpDir, `${params.suiteId}.json`);

  try {
    const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const args = [
      "exec",
      "vitest",
      "run",
      "--reporter=json",
      "--outputFile",
      outputFile,
      ...params.testFiles,
    ];

    const res = spawnSync(pnpmCmd, args, {
      cwd: params.repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    });

    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";

    let reportRaw: Record<string, unknown> = {};
    try {
      const data = fs.readFileSync(outputFile, "utf8");
      reportRaw = JSON.parse(data) as Record<string, unknown>;
    } catch {
      reportRaw = {};
    }

    const parsed = parseVitestJsonReport(reportRaw as Parameters<typeof parseVitestJsonReport>[0]);
    const metrics: EvalSuiteMetrics = {
      id: params.suiteId,
      total: parsed.total,
      passed: parsed.passed,
      failed: parsed.failed,
      skipped: parsed.skipped,
      success: parsed.success,
      durationMs: parsed.durationMs,
      exitCode: res.status ?? 1,
    };

    return { metrics, stdout, stderr };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}

function fmtPct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const suites = resolveSuites(options.suiteIds);
  const profileThresholds = EVAL_PROFILE_THRESHOLDS[options.profile];

  const suiteOutcomes = [] as Array<
    ReturnType<typeof evaluateSuiteThreshold> & {
      title: string;
      description: string;
      testFiles: string[];
      stderr: string;
      stdout: string;
    }
  >;

  for (const suite of suites) {
    const run = runVitestSuite({
      repoRoot,
      suiteId: suite.id,
      testFiles: suite.testFiles,
    });
    const threshold =
      profileThresholds.suites[suite.id] ??
      ({ minPassRate: 1, maxFailures: 0, minTotalTests: 1 } as const);
    const scored = evaluateSuiteThreshold(run.metrics, threshold);
    suiteOutcomes.push({
      ...scored,
      title: suite.title,
      description: suite.description,
      testFiles: suite.testFiles,
      stderr: run.stderr.trim(),
      stdout: run.stdout.trim(),
    });

    const gateLabel = scored.gate.passed ? "PASS" : "FAIL";
    console.log(
      `[evals] ${gateLabel} ${suite.id} ${scored.passed}/${scored.total} passed (${fmtPct(scored.passRate)})`,
    );
    if (!scored.gate.passed) {
      for (const reason of scored.gate.reasons) {
        console.log(`  - ${reason}`);
      }
    }
  }

  const { gate, totals } = evaluateRunGate(suiteOutcomes, profileThresholds);
  const result = {
    schemaVersion: 1,
    profile: options.profile,
    generatedAt: new Date().toISOString(),
    thresholds: profileThresholds,
    suites: suiteOutcomes,
    totals,
    gate,
  };

  const defaultOut =
    options.profile === "ci" ? "reports/evals/ci.json" : "reports/evals/latest.json";
  const outPath = path.resolve(repoRoot, options.jsonOut ?? defaultOut);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  const overallLabel = gate.passed ? "PASS" : "FAIL";
  console.log(
    `[evals] ${overallLabel} overall ${totals.passed}/${totals.total} passed (${fmtPct(totals.passRate)}), report: ${path.relative(repoRoot, outPath)}`,
  );

  process.exit(gate.passed ? 0 : 1);
}

void main();
