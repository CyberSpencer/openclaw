import { describe, expect, it } from "vitest";
import type { ExecutiveBriefSources } from "./executive-brief.types.js";
import { rankExecutiveBriefActions } from "./executive-brief.js";
import { EMPTY_TOTALS } from "./executive-brief.types.js";

function makeSources(): ExecutiveBriefSources {
  return {
    sessions: {
      status: "ok",
      warnings: [],
      totalSessions: 12,
      activeSessions: 6,
      staleSessions: 6,
      latestUpdatedAt: Date.now(),
    },
    usage: {
      status: "ok",
      warnings: [],
      totals: EMPTY_TOTALS(),
      activeAgents: 1,
      dailyEntries: 3,
    },
    orchestrator: {
      status: "ok",
      warnings: [],
      boards: 1,
      runningCards: 1,
      reviewCards: 2,
      failedCards: 1,
      backlogCards: 4,
    },
    cron: {
      status: "ok",
      warnings: [],
      enabled: true,
      totalJobs: 5,
      enabledJobs: 5,
      runningJobs: 0,
      failingJobs: 2,
      dueSoonJobs: 1,
      overdueJobs: 1,
    },
    messaging: {
      status: "ok",
      warnings: [],
      totalAccounts: 3,
      runningAccounts: 3,
      connectedAccounts: 2,
      errorAccounts: 2,
      staleAccounts: 1,
    },
  };
}

describe("rankExecutiveBriefActions", () => {
  it("prioritizes highest risk actions first", () => {
    const sources = makeSources();
    sources.usage.totals.totalTokens = 250_000;
    sources.usage.totals.totalCost = 7;

    const actions = rankExecutiveBriefActions(sources, { topActionsLimit: 3 });

    expect(actions).toHaveLength(3);
    expect(actions[0]?.id).toBe("messaging-errors");
    expect(actions[1]?.id).toBe("cron-failures");
    expect(actions[2]?.id).toBe("orchestrator-triage");
    expect(actions[0]?.confidence).toBeGreaterThan(0.8);
  });

  it("adds telemetry restoration action when sources are partial/unavailable", () => {
    const sources = makeSources();
    sources.sessions.status = "unavailable";
    sources.sessions.warnings = ["session store missing"];
    sources.cron.status = "partial";
    sources.cron.warnings = ["cron disabled"];
    sources.cron.failingJobs = 0;
    sources.cron.overdueJobs = 0;
    sources.messaging.errorAccounts = 0;
    sources.orchestrator.failedCards = 0;
    sources.orchestrator.reviewCards = 0;

    const actions = rankExecutiveBriefActions(sources, { topActionsLimit: 3 });

    expect(actions).toHaveLength(3);
    expect(actions.some((action) => action.id === "restore-telemetry")).toBe(true);
    expect(actions[0]?.id).toBe("restore-telemetry");
    expect(actions[1]?.id).toBe("default-priorities");
    expect(actions[2]?.id).toBe("default-monitoring");
  });
});
