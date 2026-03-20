import { describe, expect, it } from "vitest";
import {
  buildCodexRateLimitSummary,
  resolveCodexRateLimitStatusForModel,
  type CodexRateLimitsSnapshot,
} from "./codex-rate-limits.js";

function makeSnapshot(overrides: Partial<CodexRateLimitsSnapshot> = {}): CodexRateLimitsSnapshot {
  return {
    schemaVersion: 1,
    checkedAt: 1_700_000_000_000,
    source: "codex-app-server",
    buckets: [],
    ...overrides,
  };
}

describe("resolveCodexRateLimitStatusForModel", () => {
  it("marks a model exhausted when a future reset bucket is at 100%", () => {
    const snapshot = makeSnapshot({
      buckets: [
        {
          bucketId: "gpt-5.4-5h",
          source: "rateLimitsByLimitId",
          scope: "model_specific",
          modelRefs: ["openai-codex/gpt-5.4"],
          usedPercent: 100,
          windowDurationMins: 300,
          resetsAt: 1_700_000_300_000,
        },
      ],
    });

    const result = resolveCodexRateLimitStatusForModel(
      "openai-codex/gpt-5.4",
      snapshot,
      1_700_000_100_000,
    );

    expect(result.status).toBe("exhausted");
    expect(result.activeBucket?.bucketId).toBe("gpt-5.4-5h");
  });

  it("uses generic codex buckets when no model-specific bucket exists", () => {
    const snapshot = makeSnapshot({
      buckets: [
        {
          bucketId: "primary",
          source: "rateLimits",
          scope: "generic_codex",
          modelRefs: ["openai-codex/gpt-5.4", "openai-codex/gpt-5.3-codex-spark"],
          usedPercent: 96,
          windowDurationMins: 300,
          resetsAt: 1_700_000_300_000,
        },
      ],
    });

    const result = resolveCodexRateLimitStatusForModel(
      "openai-codex/gpt-5.3-codex-spark",
      snapshot,
      1_700_000_100_000,
    );

    expect(result.status).toBe("hot");
    expect(result.buckets).toHaveLength(1);
  });
});

describe("buildCodexRateLimitSummary", () => {
  it("returns a stale summary when the snapshot is old", () => {
    const summary = buildCodexRateLimitSummary(
      makeSnapshot({
        checkedAt: 1_700_000_000_000,
        account: { type: "chatgpt", planType: "pro" },
      }),
      1_700_001_000_000,
    );

    expect(summary.status).toBe("stale");
    expect(summary.planType).toBe("pro");
  });
});
