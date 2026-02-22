import type { EvalProfileThresholds, EvalSuiteConfig } from "./runner.js";

export const EVAL_SUITES: EvalSuiteConfig[] = [
  {
    id: "messaging-routing",
    title: "Messaging routing correctness",
    description: "Policy + fallback routing behavior for message delivery and session routing.",
    testFiles: ["src/routing/resolve-route.test.ts", "src/sessions/send-policy.test.ts"],
  },
  {
    id: "orchestration-lifecycle",
    title: "Orchestration task lifecycle correctness",
    description:
      "Task-plan publishing/delegation and terminal status mapping for orchestration workflows.",
    testFiles: [
      "src/agents/tools/orchestration-plan-tool.test.ts",
      "src/agents/subagent-registry.task-plan-outcome.test.ts",
      "src/gateway/server-methods.sessions-patch-lineage-warning.test.ts",
    ],
  },
  {
    id: "voice-action-safety",
    title: "Voice action safety confirmation requirements",
    description: "High-risk voice actions must require explicit confirmation before execution.",
    testFiles: ["src/voice/router.test.ts", "src/voice/voice-action-safety.test.ts"],
  },
];

export const EVAL_PROFILE_THRESHOLDS: Record<"local" | "ci", EvalProfileThresholds> = {
  local: {
    minOverallPassRate: 1,
    maxTotalFailures: 0,
    suites: {
      "messaging-routing": {
        minPassRate: 1,
        maxFailures: 0,
        minTotalTests: 20,
      },
      "orchestration-lifecycle": {
        minPassRate: 1,
        maxFailures: 0,
        minTotalTests: 6,
      },
      "voice-action-safety": {
        minPassRate: 1,
        maxFailures: 0,
        minTotalTests: 9,
      },
    },
  },
  ci: {
    minOverallPassRate: 1,
    maxTotalFailures: 0,
    suites: {
      "messaging-routing": {
        minPassRate: 1,
        maxFailures: 0,
        minTotalTests: 20,
      },
      "orchestration-lifecycle": {
        minPassRate: 1,
        maxFailures: 0,
        minTotalTests: 6,
      },
      "voice-action-safety": {
        minPassRate: 1,
        maxFailures: 0,
        minTotalTests: 9,
      },
    },
  },
};
